import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import { openDatabase, EventStore, type QueryOptions, type ParsedEventRow } from "./db.js";
import { SorobanEventPoller, type PollerOptions } from "./poller.js";
import {
  initTracing,
  shutdownTracing,
  withSpan,
  type TracingConfig,
} from "./tracing.js";
import {
  ReputationEngine,
  type AgentReputation,
  type ReputationBreakdown,
} from "./reputation.js";

export type { QueryOptions, ParsedEventRow };
export type { TracingConfig };
export type { AgentReputation, ReputationBreakdown };

export type BearEventIndexerConfig = {
  /** Soroban RPC URL */
  rpcUrl: string;
  /** Identity contract address */
  identityContract: string;
  /** Commerce contract address */
  commerceContract: string;
  /** Path to the SQLite database file. Default: "./data/events.db" */
  dbPath?: string;
  /** Ledger to start indexing from on first run. Default: 0 (chain origin) */
  startLedger?: number;
  /** Polling options */
  polling?: PollerOptions;
  /** OpenTelemetry tracing configuration. Tracing is disabled when omitted. */
  tracing?: TracingConfig;
  /** Port for the reputation HTTP API. Default: 0 (disabled). */
  apiPort?: number;
  /** Host to bind the reputation HTTP API. Default: "127.0.0.1" */
  apiHost?: string;
};

/**
 * High-level facade for the Bear Protocol event indexer.
 *
 * @example
 * ```typescript
 * import { BearEventIndexer } from "bear-event-indexer";
 *
 * const indexer = new BearEventIndexer({
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   identityContract: "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5",
 *   commerceContract: "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE",
 *   dbPath: "./data/events.db",
 *   startLedger: 1_000_000,
 * });
 *
 * await indexer.start();
 * const jobs = await indexer.getJobsByProvider(providerAddress, { limit: 20 });
 * ```
 */
export class BearEventIndexer {
  private readonly store: EventStore;
  private readonly poller: SorobanEventPoller;
  private readonly reputation: ReputationEngine;
  private readonly apiPort: number;
  private readonly apiHost: string;
  private server: Server | null = null;

  constructor(config: BearEventIndexerConfig) {
    // Initialize OpenTelemetry before any instrumented work begins.
    initTracing(config.tracing);

    const dbPath = config.dbPath ?? "./data/events.db";
    const startLedger = config.startLedger ?? 0;

    const db = openDatabase(dbPath);
    this.store = new EventStore(db);
    this.reputation = new ReputationEngine(db);
    this.apiPort = config.apiPort ?? 0;
    this.apiHost = config.apiHost ?? "127.0.0.1";

    const rpcServer = new StellarRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });

    const contracts = [config.identityContract, config.commerceContract].filter(
      (c) => c && c.trim() !== "",
    );

    this.poller = new SorobanEventPoller(rpcServer, this.store, contracts, startLedger, {
      ...config.polling,
    });
  }

  /** Start continuous indexing. Resolves once the first poll completes. */
  async start(): Promise<void> {
    await withSpan("indexer.start", async () => {
      await this.poller.start();
    });
    if (this.apiPort > 0) {
      await this.startApi();
    }
  }

  /** Stop the indexer gracefully. */
  stop(): void {
    this.poller.stop();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    void shutdownTracing();
  }

  // ── Reputation API ─────────────────────────────────────────────────────────

  /** Start the reputation HTTP API on the configured port. */
  async startApi(): Promise<void> {
    if (this.server) return;
    const handler = createReputationHandler(this.reputation);
    this.server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.apiPort, this.apiHost, () => resolve());
    });
  }

  /** Returns the reputation score and breakdown for an agent. */
  getReputation(agentId: string): AgentReputation {
    return this.reputation.getReputation(agentId);
  }

  // ── Query API ──────────────────────────────────────────────────────────────

  /**
   * Retrieve events where the `provider` field in the payload matches the
   * given address. Matches JobCreated, JobCompleted, etc.
   */
  getJobsByProvider(provider: string, opts?: QueryOptions): ParsedEventRow[] {
    return this.store.getByProvider(provider, opts);
  }

  /**
   * Retrieve events where the `client` field in the payload matches the
   * given address.
   */
  getJobsByClient(client: string, opts?: QueryOptions): ParsedEventRow[] {
    return this.store.getByClient(client, opts);
  }

  /**
   * Retrieve events filtered by a specific event type, e.g. "JobCreated".
   */
  getEventsByType(eventType: string, opts?: QueryOptions): ParsedEventRow[] {
    return this.store.getByEventType(eventType, opts);
  }

  /**
   * Retrieve all events within a Unix timestamp range (seconds, inclusive).
   */
  getEventsByDateRange(from: number, to: number, opts?: QueryOptions): ParsedEventRow[] {
    return this.store.getByDateRange(from, to, opts);
  }

  /** Returns the last indexed ledger sequence number, or null if none yet. */
  getLastIndexedLedger(): number | null {
    return this.store.getLastIndexedLedger();
  }

  /** Returns the total number of indexed events. */
  totalEvents(): number {
    return this.store.count();
  }
}

// ── Reputation HTTP handler ──────────────────────────────────────────────────

/**
 * Creates a Node HTTP request handler exposing:
 *   GET /api/agents/:id/reputation
 *
 * Returns the score breakdown and percentile rank from the reputation engine.
 */
export function createReputationHandler(
  reputation: ReputationEngine,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void withSpan("indexer.api.request", async (span) => {
      span.setAttribute("http.method", req.method ?? "");
      span.setAttribute("http.url", req.url ?? "");

      const url = req.url ?? "/";
      const match = /^\/api\/agents\/([^/]+)\/reputation\/?$/.exec(url.split("?")[0]);

      if (!match) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }

      const agentId = decodeURIComponent(match[1]);
      span.setAttribute("agent.id", agentId);

      try {
        const result = reputation.getReputation(agentId);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      } catch (err) {
        span.recordException(err as Error);
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    });
  };
}

// Re-export lower-level primitives for advanced use-cases
export { openDatabase, EventStore } from "./db.js";
export { SorobanEventPoller } from "./poller.js";
export { ReputationEngine } from "./reputation.js";
export { initTracing, shutdownTracing, withSpan } from "./tracing.js";
