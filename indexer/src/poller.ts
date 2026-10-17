import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import type { DatabaseAdapter, InsertEventParams } from "./db.js";
import {
  stellarEventsIngestedTotal,
  stellarRpcRequestDurationSeconds,
  activeEscrowJobsGauge,
} from "./metrics.js";
import type { WebhookDispatcher } from "./webhooks.js";

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
  /** Optional webhook dispatcher invoked on JobCreated events. */
  webhooks?: WebhookDispatcher;
};

/** Wraps an RPC call, observing its latency in the Prometheus histogram. */
async function observeRpc<T>(
  method: "getEvents" | "getLatestLedger",
  fn: () => Promise<T>,
): Promise<T> {
  const end = stellarRpcRequestDurationSeconds.startTimer({ method });
  try {
    return await fn();
  } finally {
    end();
  }
}

/**
 * Continuously polls Soroban RPC for new contract events and persists them
 * to SQLite.  Call `start()` to begin and `stop()` to halt gracefully.
 */
export class SorobanEventPoller {
  private readonly rpc: SorobanRpcClient;
  private readonly store: DatabaseAdapter;
  private readonly contracts: string[];
  private readonly startLedger: number;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly debug: boolean;
  private readonly webhooks?: WebhookDispatcher;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    rpc: SorobanRpcClient,
    store: DatabaseAdapter,
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
    this.webhooks = opts.webhooks;
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

  /**
   * Fires webhook notifications for JobCreated events without blocking the
   * poll loop.  Any failure is logged and swallowed so the poller keeps running.
   */
  private dispatchJobCreatedWebhooks(inserts: InsertEventParams[]): void {
    if (!this.webhooks) return;

    for (const insert of inserts) {
      if (insert.event_type !== "JobCreated") continue;

      const payload = insert.payload as Record<string, unknown>;
      const value = payload?.value as Record<string, unknown> | undefined;
      const provider =
        (value?.provider as string | undefined) ??
        (value?.seller as string | undefined);
      if (!provider) continue;

      const jobId =
        (value?.job_id as string | undefined) ??
        (value?.jobId as string | undefined) ??
        insert.event_type;
      const budget = value?.budget;
      const client = value?.client;
      const description = value?.description;

      void Promise.resolve()
        .then(() =>
          this.webhooks!.dispatchJobCreated(provider, {
            jobId: String(jobId),
            budget,
            client,
            description,
          }),
        )
        .catch((err) => {
          console.error(
            `[indexer] Webhook dispatch failed for provider ${provider}:`,
            (err as Error).message,
          );
        });
    }
  }

  private async poll(): Promise<void> {
    const fromLedger = this.getFromLedger();

    try {
      const latest = await observeRpc("getLatestLedger", () =>
        this.rpc.getLatestLedger(),
      );
      if (fromLedger > latest.sequence) {
        this.log(`Up to date at ledger ${latest.sequence}`);
        return;
      }

      // Query each contract separately to stay within RPC limits
      for (const contractId of this.contracts) {
        try {
          const response = await observeRpc("getEvents", () =>
            this.rpc.getEvents({
              startLedger: fromLedger,
              filters: [
                {
                  type: "contract",
                  contractIds: [contractId],
                },
              ],
              limit: this.batchSize,
            }),
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

          this.store.insertMany(inserts);
          for (const insert of inserts) {
            stellarEventsIngestedTotal.inc({ event_type: insert.event_type });
          }
          this.dispatchJobCreatedWebhooks(inserts);
          this.log(
            `Indexed ${inserts.length} events from contract ${contractId} (ledgers ${fromLedger}+)`,
          );
        } catch (err) {
          console.error(
            `[indexer] Failed to fetch events for contract ${contractId}:`,
            (err as Error).message,
          );
        }
      }

      // Advance the watermark to the latest ledger we queried up to
      this.store.setLastIndexedLedger(latest.sequence);

      // Refresh the gauge of currently active escrow jobs.
      try {
        const active = this.store.countActiveJobs?.();
        if (typeof active === "number") {
          activeEscrowJobsGauge.set(active);
        }
      } catch (err) {
        this.log(`Failed to update active jobs gauge: ${(err as Error).message}`);
      }
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
