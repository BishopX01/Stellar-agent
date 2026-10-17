import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { EventStore, type InsertEventParams } from "./db.js";
import { ReputationEngine } from "./reputation.js";

const tracer = trace.getTracer("bear-indexer-poller");

export type SorobanRpcClient = {
  getEvents(
    params: StellarRpc.Server.GetEventsRequest,
  ): Promise<StellarRpc.Api.GetEventsResponse>;
  getLatestLedger(): Promise<StellarRpc.Api.GetLatestLedgerResponse>;
};

// Known Bear Protocol event topic names
export const BEAR_EVENT_TYPES = [
  "JobCreated",
  "JobSubmitted",
  "JobCompleted",
  "JobCancelled",
  "JobDisputed",
  "JobExpired",
  "JobRefunded",
  "BatchJobsCreated",
  "Registered",
  "AgentDeregistered",
  "UriUpdated",
  "OwnerTransferred",
  "BadgeIssued",
  "BadgeRevoked",
] as const;

export type BearEventType = (typeof BEAR_EVENT_TYPES)[number];

/**
 * Converts a raw Soroban event into the InsertEventParams format.
 * The full event is stored as a JSON blob in `payload` so no information
 * is lost and new fields can be queried without schema migrations.
 */
function toInsertParams(
  event: StellarRpc.Api.EventResponse,
  ledgerCloseTime: number,
): InsertEventParams {
  // The first topic element is typically the event name / discriminant
  const topics = event.topic ?? [];
  const firstTopic = topics[0];
  let eventType = "Unknown";
  try {
    // Topic values come back as xdr strings; attempt a best-effort decode
    if (firstTopic && typeof firstTopic === "object" && "value" in firstTopic) {
      eventType = String((firstTopic as Record<string, unknown>).value);
    } else if (typeof firstTopic === "string") {
      eventType = firstTopic;
    }
  } catch {
    // leave as "Unknown"
  }

  const payload: Record<string, unknown> = {
    topics: topics,
    value: event.value,
    txHash: event.txHash,
    id: event.id,
  };

  return {
    ledger: event.ledger,
    timestamp: ledgerCloseTime,
    contract: event.contractId ?? "",
    event_type: eventType,
    payload,
  };
}

export type PollerOptions = {
  /** Polling interval in milliseconds. Default: 5000 */
  intervalMs?: number;
  /** Max events to fetch per RPC call. Default: 100 */
  batchSize?: number;
  /** Emit debug logs. Default: false */
  debug?: boolean;
  /** Optional reputation engine used to recalculate scores on settlement. */
  reputation?: ReputationEngine;
};

/** Event types that affect an agent's reputation score. */
const REPUTATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "JobCompleted",
  "JobDisputed",
]);

/**
 * Best-effort extraction of the agent address from a raw Soroban event.
 * Job events carry the provider agent as one of their topics; we scan the
 * topics for the first string-like value that is not the event name.
 */
function extractAgentId(event: StellarRpc.Api.EventResponse): string | null {
  const topics = event.topic ?? [];
  for (let i = 1; i < topics.length; i++) {
    const topic = topics[i] as unknown;
    if (typeof topic === "string") return topic;
    if (topic && typeof topic === "object") {
      const value = (topic as Record<string, unknown>).value;
      if (typeof value === "string") return value;
    }
  }
  return null;
}

/**
 * Continuously polls Soroban RPC for new contract events and persists them
 * to SQLite.  Call `start()` to begin and `stop()` to halt gracefully.
 */
export class SorobanEventPoller {
  private readonly rpc: SorobanRpcClient;
  private readonly store: EventStore;
  private readonly contracts: string[];
  private readonly startLedger: number;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly debug: boolean;
  private readonly reputation: ReputationEngine | null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    rpc: SorobanRpcClient,
    store: EventStore,
    contracts: string[],
    startLedger: number,
    opts: PollerOptions = {},
  ) {
    this.rpc = rpc;
    this.store = store;
    this.contracts = contracts;
    this.startLedger = startLedger;
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.batchSize = opts.batchSize ?? 100;
    this.debug = opts.debug ?? false;
    this.reputation = opts.reputation ?? null;
  }

  private log(msg: string): void {
    if (this.debug) console.log(`[indexer] ${msg}`);
  }

  /** Returns the ledger to start polling from (resume or initial). */
  private getFromLedger(): number {
    const last = this.store.getLastIndexedLedger();
    // Start one ledger ahead of the last processed to avoid re-indexing
    return last !== null ? last + 1 : this.startLedger;
  }

  /** Recalculate reputation for agents affected by settlement events. */
  private updateReputation(events: StellarRpc.Api.EventResponse[]): void {
    if (!this.reputation) return;

    const agents = new Set<string>();
    for (const ev of events) {
      const params = toInsertParams(ev, 0);
      if (!REPUTATION_EVENT_TYPES.has(params.event_type)) continue;
      const agentId = extractAgentId(ev);
      if (agentId) agents.add(agentId);
    }

    for (const agentId of agents) {
      try {
        this.reputation.recalculate(agentId);
        this.log(`Recalculated reputation for agent ${agentId}`);
      } catch (err) {
        console.error(
          `[indexer] Failed to recalculate reputation for ${agentId}:`,
          (err as Error).message,
        );
      }
    }
  }

  private async poll(): Promise<void> {
    const fromLedger = this.getFromLedger();

    try {
      const latest = await tracer.startActiveSpan(
        "soroban.getLatestLedger",
        async (span: Span) => {
          try {
            const res = await this.rpc.getLatestLedger();
            span.setAttribute("stellar.ledger.sequence", res.sequence);
            return res;
          } catch (err) {
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw err;
          } finally {
            span.end();
          }
        },
      );
      if (fromLedger > latest.sequence) {
        this.log(`Up to date at ledger ${latest.sequence}`);
        return;
      }

      // Collect all events for this ledger across contracts before writing.
      const allInserts: InsertEventParams[] = [];

      // Query each contract separately to stay within RPC limits
      for (const contractId of this.contracts) {
        try {
          const response = await tracer.startActiveSpan(
            "soroban.getEvents",
            async (span: Span) => {
              span.setAttribute("stellar.contract.id", contractId);
              span.setAttribute("stellar.ledger.start", fromLedger);
              try {
                const res = await this.rpc.getEvents({
                  startLedger: fromLedger,
                  filters: [
                    {
                      type: "contract",
                      contractIds: [contractId],
                    },
                  ],
                  limit: this.batchSize,
                });
                span.setAttribute("stellar.events.count", res.events?.length ?? 0);
                return res;
              } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
              } finally {
                span.end();
              }
            },
          );

          if (!response.events || response.events.length === 0) continue;

          // Soroban getEvents returns ledger close times via the `ledgerClosedAt` field;
          // fall back to current time when unavailable (e.g. in tests).
          const inserts: InsertEventParams[] = response.events.map((ev) => {
            const closeTime =
              typeof (ev as Record<string, unknown>).ledgerClosedAt === "string"
                ? Math.floor(
                    new Date(
                      (ev as Record<string, unknown>).ledgerClosedAt as string,
                    ).getTime() / 1000,
                  )
                : Math.floor(Date.now() / 1000);
            return toInsertParams(ev as StellarRpc.Api.EventResponse, closeTime);
          });

          // Collect events across all contracts so the whole ledger batch is
          // persisted atomically in a single IMMEDIATE transaction below.
          allInserts.push(...inserts);
          this.log(
            `Fetched ${inserts.length} events from contract ${contractId} (ledgers ${fromLedger}+)`,
          );
        } catch (err) {
          console.error(
            `[indexer] Failed to fetch events for contract ${contractId}:`,
            (err as Error).message,
          );
        }
      }

      // Persist the entire ledger batch (events + watermark) atomically.
      // If anything fails, neither the events nor the watermark advance.
      this.store.insertEventsBatch(allInserts, latest.sequence);
      this.log(
        `Indexed ${allInserts.length} events across ${this.contracts.length} contract(s) up to ledger ${latest.sequence}`,
      );
    } catch (err) {
      console.error("[indexer] Poll error:", (err as Error).message);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log("Starting event poller…");

    const tick = async () => {
      if (!this.running) return;
      await this.poll();
      if (this.running) {
        this.timer = setTimeout(tick, this.intervalMs);
      }
    };

    await tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log("Poller stopped.");
  }
}
