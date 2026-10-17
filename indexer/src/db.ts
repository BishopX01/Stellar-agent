import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const tracer = trace.getTracer("marc-indexer-db");

/**
 * Run `fn` inside an OpenTelemetry span.  Tracing is a no-op unless an SDK
 * tracer provider has been registered, so this is safe in tests.
 */
function withSpan<T>(name: string, fn: (span: Span) => T): T {
  return tracer.startActiveSpan(name, (span) => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Initialises (or opens) the SQLite database and ensures the schema and
 * indexes are present.  Safe to call on every startup — uses IF NOT EXISTS.
 */
export function openDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger      INTEGER NOT NULL,
      timestamp   INTEGER NOT NULL,
      contract    TEXT    NOT NULL,
      event_type  TEXT    NOT NULL,
      payload     TEXT    NOT NULL   -- JSON blob
    );

    CREATE INDEX IF NOT EXISTS idx_events_ledger
      ON events(ledger);

    CREATE INDEX IF NOT EXISTS idx_events_type
      ON events(event_type);

    CREATE INDEX IF NOT EXISTS idx_events_contract
      ON events(contract);

    CREATE INDEX IF NOT EXISTS idx_events_timestamp
      ON events(timestamp);

    -- Tracks the last successfully indexed ledger so we can resume on restart
    CREATE TABLE IF NOT EXISTS indexer_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Cached reputation scores per agent (issue #729)
    CREATE TABLE IF NOT EXISTS agent_reputation (
      agent_id    TEXT PRIMARY KEY,
      score       REAL NOT NULL,
      breakdown   TEXT NOT NULL,   -- JSON blob
      updated_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_reputation_score
      ON agent_reputation(score);
  `);

  return db;
}

// ── Prepared statement helpers ───────────────────────────────────────────────

export type EventRow = {
  id: number;
  ledger: number;
  timestamp: number;
  contract: string;
  event_type: string;
  payload: string;
};

export type ParsedEventRow = Omit<EventRow, "payload"> & { payload: Record<string, unknown> };

function parseRow(row: EventRow): ParsedEventRow {
  return { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}

export type InsertEventParams = {
  ledger: number;
  timestamp: number;
  contract: string;
  event_type: string;
  payload: Record<string, unknown>;
};

export type QueryOptions = {
  limit?: number;
  offset?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
};

/** Aggregated on-chain job metrics for a single agent (issue #729). */
export type AgentJobMetrics = {
  agent_id: string;
  total_jobs: number;
  completed_jobs: number;
  cancelled_jobs: number;
  disputed_jobs: number;
  avg_completion_time_secs: number | null;
};

export type ReputationRow = {
  agent_id: string;
  score: number;
  breakdown: Record<string, unknown>;
  updated_at: number;
};

export class EventStore {
  private db: Database.Database;

  private stmtInsert: Database.Statement;
  private stmtGetState: Database.Statement;
  private stmtSetState: Database.Statement;
  private stmtUpsertReputation: Database.Statement;
  private stmtGetReputation: Database.Statement;
  private stmtGetAllReputations: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtInsert = db.prepare(`
      INSERT INTO events (ledger, timestamp, contract, event_type, payload)
      VALUES (@ledger, @timestamp, @contract, @event_type, @payload)
    `);

    this.stmtGetState = db.prepare(
      `SELECT value FROM indexer_state WHERE key = ?`,
    );

    this.stmtSetState = db.prepare(`
      INSERT INTO indexer_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    this.stmtUpsertReputation = db.prepare(`
      INSERT INTO agent_reputation (agent_id, score, breakdown, updated_at)
      VALUES (@agent_id, @score, @breakdown, @updated_at)
      ON CONFLICT(agent_id) DO UPDATE SET
        score      = excluded.score,
        breakdown  = excluded.breakdown,
        updated_at = excluded.updated_at
    `);

    this.stmtGetReputation = db.prepare(
      `SELECT * FROM agent_reputation WHERE agent_id = ?`,
    );

    this.stmtGetAllReputations = db.prepare(
      `SELECT * FROM agent_reputation ORDER BY score DESC`,
    );
  }

  /** Bulk-insert events inside a single transaction. */
  insertMany(events: InsertEventParams[]): void {
    withSpan("db.events.insertMany", (span) => {
      span.setAttribute("db.system", "sqlite");
      span.setAttribute("db.operation", "insert");
      span.setAttribute("db.events.count", events.length);
      const insert = this.db.transaction((rows: InsertEventParams[]) => {
        for (const row of rows) {
          this.stmtInsert.run({
            ledger: row.ledger,
            timestamp: row.timestamp,
            contract: row.contract,
            event_type: row.event_type,
            payload: JSON.stringify(row.payload),
          });
        }
      });
      insert(events);
    });
  }

  getLastIndexedLedger(): number | null {
    return withSpan("db.indexer_state.getLastLedger", (span) => {
      span.setAttribute("db.system", "sqlite");
      const row = this.stmtGetState.get("last_ledger") as
        | { value: string }
        | undefined;
      return row ? Number(row.value) : null;
    });
  }

  setLastIndexedLedger(ledger: number): void {
    withSpan("db.indexer_state.setLastLedger", (span) => {
      span.setAttribute("db.system", "sqlite");
      span.setAttribute("indexer.ledger", ledger);
      this.stmtSetState.run("last_ledger", String(ledger));
    });
  }

  // ── Reputation API (issue #729) ────────────────────────────────────────────

  /** Insert or update the cached reputation record for an agent. */
  upsertReputation(
    agentId: string,
    score: number,
    breakdown: Record<string, unknown>,
    updatedAt: number = Date.now(),
  ): void {
    withSpan("db.agent_reputation.upsert", (span) => {
      span.setAttribute("db.system", "sqlite");
      span.setAttribute("agent.id", agentId);
      span.setAttribute("agent.score", score);
      this.stmtUpsertReputation.run({
        agent_id: agentId,
        score,
        breakdown: JSON.stringify(breakdown),
        updated_at: updatedAt,
      });
    });
  }

  /** Fetch a single agent's cached reputation, or null if unknown. */
  getReputation(agentId: string): ReputationRow | null {
    return withSpan("db.agent_reputation.get", (span) => {
      span.setAttribute("db.system", "sqlite");
      span.setAttribute("agent.id", agentId);
      const row = this.stmtGetReputation.get(agentId) as
        | {
            agent_id: string;
            score: number;
            breakdown: string;
            updated_at: number;
          }
        | undefined;
      if (!row) return null;
      return {
        agent_id: row.agent_id,
        score: row.score,
        breakdown: JSON.parse(row.breakdown) as Record<string, unknown>,
        updated_at: row.updated_at,
      };
    });
  }

  /** Fetch all cached reputations, ordered by score descending. */
  getAllReputations(): ReputationRow[] {
    return withSpan("db.agent_reputation.getAll", (span) => {
      span.setAttribute("db.system", "sqlite");
      const rows = this.stmtGetAllReputations.all() as {
        agent_id: string;
        score: number;
        breakdown: string;
        updated_at: number;
      }[];
      span.setAttribute("db.rows.count", rows.length);
      return rows.map((row) => ({
        agent_id: row.agent_id,
        score: row.score,
        breakdown: JSON.parse(row.breakdown) as Record<string, unknown>,
        updated_at: row.updated_at,
      }));
    });
  }

  /**
   * Aggregate on-chain job metrics per agent from the events table.
   *
   * Counts `JobCreated`, `JobCompleted`, `JobCancelled` and `JobDisputed`
   * events (case-insensitive, tolerant of snake_case / camelCase variants)
   * and computes the average completion time in seconds between the
   * `JobCreated` and `JobCompleted` events for the same job id.
   *
   * When `agentId` is provided only that agent's metrics are returned.
   */
  getAgentJobMetrics(agentId?: string): AgentJobMetrics[] {
    return withSpan("db.events.aggregateAgentMetrics", (span) => {
      span.setAttribute("db.system", "sqlite");
      if (agentId) span.setAttribute("agent.id", agentId);

      // Normalise the event type to a lowercase, underscore-free form so that
      // `JobCompleted`, `job_completed` and `jobCompleted` all match.
      const typeExpr = `lower(replace(replace(event_type, '_', ''), ' ', ''))`;

      // Agent id may be stored under `provider`, `provider_id`, `providerId`
      // or `agent` depending on the emitting contract.
      const agentExpr = `COALESCE(
        json_extract(payload, '$.provider'),
        json_extract(payload, '$.provider_id'),
        json_extract(payload, '$.providerId'),
        json_extract(payload, '$.agent'),
        json_extract(payload, '$.agent_id')
      )`;

      const jobIdExpr = `COALESCE(
        json_extract(payload, '$.job_id'),
        json_extract(payload, '$.jobId'),
        json_extract(payload, '$.job')
      )`;

      const filter = agentId ? " AND " + agentExpr + " = ?" : "";
      const params: (string | number)[] = agentId ? [agentId] : [];

      const countSql = `
        SELECT
          ${agentExpr} AS agent_id,
          COUNT(*) AS total_jobs,
          SUM(CASE WHEN ${typeExpr} = 'jobcompleted' THEN 1 ELSE 0 END) AS completed_jobs,
          SUM(CASE WHEN ${typeExpr} = 'jobcancelled' THEN 1 ELSE 0 END) AS cancelled_jobs,
          SUM(CASE WHEN ${typeExpr} = 'jobdisputed'  THEN 1 ELSE 0 END) AS disputed_jobs
        FROM events
        WHERE ${agentExpr} IS NOT NULL
          AND ${typeExpr} IN ('jobcreated', 'jobcompleted', 'jobcancelled', 'jobdisputed')
          ${filter}
        GROUP BY ${agentExpr}
      `;

      const counts = this.db.prepare(countSql).all(...params) as {
        agent_id: string;
        total_jobs: number;
        completed_jobs: number | null;
        cancelled_jobs: number | null;
        disputed_jobs: number | null;
      }[];

      // Average completion time: pair JobCreated -> JobCompleted per job id.
      const timingSql = `
        SELECT
          ${agentExpr} AS agent_id,
          ${jobIdExpr} AS job_id,
          MIN(CASE WHEN ${typeExpr} = 'jobcreated'   THEN timestamp END) AS created_at,
          MIN(CASE WHEN ${typeExpr} = 'jobcompleted' THEN timestamp END) AS completed_at
        FROM events
        WHERE ${agentExpr} IS NOT NULL
          AND ${jobIdExpr} IS NOT NULL
          AND ${typeExpr} IN ('jobcreated', 'jobcompleted')
          ${filter}
        GROUP BY ${agentExpr}, ${jobIdExpr}
        HAVING created_at IS NOT NULL AND completed_at IS NOT NULL
      `;

      const timings = this.db.prepare(timingSql).all(...params) as {
        agent_id: string;
        job_id: string | number;
        created_at: number;
        completed_at: number;
      }[];

      const durations = new Map<string, number[]>();
      for (const t of timings) {
        // Timestamps are stored in milliseconds; convert to seconds.
        const secs = Math.max(0, (t.completed_at - t.created_at) / 1000);
        const list = durations.get(t.agent_id) ?? [];
        list.push(secs);
        durations.set(t.agent_id, list);
      }

      const result: AgentJobMetrics[] = counts.map((c) => {
        const list = durations.get(c.agent_id) ?? [];
        const avg =
          list.length > 0
            ? list.reduce((a, b) => a + b, 0) / list.length
            : null;
        return {
          agent_id: c.agent_id,
          total_jobs: c.total_jobs,
          completed_jobs: c.completed_jobs ?? 0,
          cancelled_jobs: c.cancelled_jobs ?? 0,
          disputed_jobs: c.disputed_jobs ?? 0,
          avg_completion_time_secs: avg,
        };
      });

      span.setAttribute("db.agents.count", result.length);
      return result;
    });
  }

  // ── Query API ──────────────────────────────────────────────────────────────

  getByProvider(
    provider: string,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 20, offset = 0, fromTimestamp, toTimestamp } = opts;
    let sql = `
      SELECT * FROM events
      WHERE json_extract(payload, '$.provider') = ?
    `;
    const params: (string | number)[] = [provider];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  getByClient(
    client: string,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 20, offset = 0, fromTimestamp, toTimestamp } = opts;
    let sql = `
      SELECT * FROM events
      WHERE json_extract(payload, '$.client') = ?
    `;
    const params: (string | number)[] = [client];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  getByEventType(
    eventType: string,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 20, offset = 0, fromTimestamp, toTimestamp } = opts;
    let sql = `SELECT * FROM events WHERE event_type = ?`;
    const params: (string | number)[] = [eventType];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  getByContract(
    contract: string,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 20, offset = 0, fromTimestamp, toTimestamp } = opts;
    let sql = `SELECT * FROM events WHERE contract = ?`;
    const params: (string | number)[] = [contract];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  /**
   * Fetch events whose JSON payload contains the given job id under any of the
   * common key names used across the contracts (`job_id`, `jobId`, `job`).
   * Used by the E2E lifecycle test to assert that every event emitted for a
   * single job was persisted by the indexer.
   */
  getByJobId(
    jobId: string | number,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 100, offset = 0, fromTimestamp, toTimestamp } = opts;
    const id = String(jobId);
    let sql = `
      SELECT * FROM events
      WHERE json_extract(payload, '$.job_id') = ?
         OR json_extract(payload, '$.jobId')  = ?
         OR json_extract(payload, '$.job')    = ?
    `;
    const params: (string | number)[] = [id, id, id];
    if (fromTimestamp !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      sql += " AND timestamp <= ?";
      params.push(toTimestamp);
    }
    sql += " ORDER BY ledger ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(parseRow);
  }

  /**
   * Fetch events matching a job id AND a specific event type.  Convenience
   * wrapper used by the E2E test to assert individual lifecycle transitions
   * (e.g. `job_funded`, `job_completed`) were indexed.
   */
  getByJobIdAndType(
    jobId: string | number,
    eventType: string,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    return this.getByJobId(jobId, opts).filter(
      (row) => row.event_type === eventType,
    );
  }

  getByDateRange(
    from: number,
    to: number,
    opts: QueryOptions = {},
  ): ParsedEventRow[] {
    const { limit = 50, offset = 0 } = opts;
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE timestamp BETWEEN ? AND ?
         ORDER BY ledger ASC
         LIMIT ? OFFSET ?`,
      )
      .all(from, to, limit, offset) as EventRow[];
    return rows.map(parseRow);
  }

  /** Total event count — useful for health/status checks. */
  count(): number {
    return withSpan("db.events.count", (span) => {
      span.setAttribute("db.system", "sqlite");
      const row = this.db
        .prepare("SELECT COUNT(*) as c FROM events")
        .get() as { c: number };
      return row.c;
    });
  }
}
