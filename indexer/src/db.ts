import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// ── Migration runner ─────────────────────────────────────────────────────────

export type Migration = {
  version: number;
  name: string;
  up: string;
  down: string;
};

export type RunMigrationsOptions = {
  /** Directory containing numbered `NNN_name.sql` migration files. */
  migrationsDir?: string;
  /** When true, report pending migrations without applying them. */
  dryRun?: boolean;
  /** Roll back the most recent `rollback` applied migrations (default 0). */
  rollback?: number;
};

export type MigrationResult = {
  applied: number[];
  rolledBack: number[];
  pending: number[];
  dryRun: boolean;
};

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

/**
 * Parses a migration file's contents into up/down sections.  The `down`
 * section is delimited by a line containing only `-- down` (case-insensitive).
 * If no delimiter is present the whole file is treated as the `up` section.
 */
export function parseMigrationSql(sql: string): { up: string; down: string } {
  const marker = /^\s*--\s*down\s*$/im;
  const match = marker.exec(sql);
  if (!match) {
    return { up: sql.trim(), down: "" };
  }
  const up = sql.slice(0, match.index).trim();
  const down = sql.slice(match.index + match[0].length).trim();
  return { up, down };
}

/**
 * Loads all numbered migration files from `dir`, sorted by version.  Files
 * must be named `<version>_<name>.sql` (e.g. `001_initial.sql`).
 */
export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/i.test(f))
    .sort((a, b) => {
      const va = Number(a.split("_")[0]);
      const vb = Number(b.split("_")[0]);
      return va - vb;
    });

  return files.map((file) => {
    const version = Number(file.split("_")[0]);
    const name = file.replace(/^\d+_/, "").replace(/\.sql$/i, "");
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const { up, down } = parseMigrationSql(raw);
    return { version, name, up, down };
  });
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function getAppliedVersions(db: Database.Database): number[] {
  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as { version: number }[];
  return rows.map((r) => r.version);
}

/**
 * Applies pending migrations in order, each inside its own atomic transaction.
 * On failure the failing migration's transaction is rolled back and the error
 * is re-thrown so startup can halt.  Supports dry-run and rollback modes.
 */
export function runMigrations(
  db: Database.Database,
  options: RunMigrationsOptions = {},
): MigrationResult {
  const { migrationsDir = DEFAULT_MIGRATIONS_DIR, dryRun = false, rollback = 0 } = options;

  ensureMigrationsTable(db);
  const migrations = loadMigrations(migrationsDir);
  const applied = getAppliedVersions(db);
  const appliedSet = new Set(applied);

  const result: MigrationResult = {
    applied: [],
    rolledBack: [],
    pending: [],
    dryRun,
  };

  // ── Rollback mode ──────────────────────────────────────────────────────────
  if (rollback > 0) {
    const byVersion = new Map(migrations.map((m) => [m.version, m]));
    const toRollback = [...applied].sort((a, b) => b - a).slice(0, rollback);

    for (const version of toRollback) {
      const migration = byVersion.get(version);
      if (!migration) {
        throw new Error(`Cannot roll back migration ${version}: file not found`);
      }
      if (dryRun) {
        result.rolledBack.push(version);
        continue;
      }
      const tx = db.transaction(() => {
        if (migration.down) {
          db.exec(migration.down);
        }
        db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
      });
      tx();
      result.rolledBack.push(version);
    }
    return result;
  }

  // ── Forward mode ───────────────────────────────────────────────────────────
  const pending = migrations.filter((m) => !appliedSet.has(m.version));
  result.pending = pending.map((m) => m.version);

  if (dryRun) {
    return result;
  }

  for (const migration of pending) {
    const tx = db.transaction(() => {
      db.exec(migration.up);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
    });
    try {
      tx();
    } catch (err) {
      // better-sqlite3 rolls the transaction back automatically on throw.
      throw new Error(
        `Migration ${migration.version}_${migration.name} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    result.applied.push(migration.version);
  }

  return result;
}

/**
 * Initialises (or opens) the SQLite database, runs any pending migrations and
 * returns the connection.  Safe to call on every startup.
 */
export function openDatabase(
  dbPath: string,
  options: RunMigrationsOptions = {},
): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db, options);

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

export class EventStore {
  private db: Database.Database;

  private stmtInsert: Database.Statement;
  private stmtGetState: Database.Statement;
  private stmtSetState: Database.Statement;

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
  }

  /**
   * Bulk-insert events inside a single IMMEDIATE transaction.  All rows in the
   * batch commit atomically — if any insert fails the whole batch is rolled
   * back.  Using BEGIN IMMEDIATE acquires the write lock up-front, avoiding
   * deadlocks between concurrent writer processes.
   */
  insertEventsBatch(events: InsertEventParams[]): void {
    if (events.length === 0) return;

    const run = this.db.transaction((rows: InsertEventParams[]) => {
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

    // better-sqlite3's transaction() uses BEGIN; force IMMEDIATE semantics by
    // taking the write lock before the transaction body runs.
    this.db.pragma("busy_timeout = 5000");
    run.immediate(events);
  }

  /** Bulk-insert events inside a single transaction. */
  insertMany(events: InsertEventParams[]): void {
    this.insertEventsBatch(events);
  }

  getLastIndexedLedger(): number | null {
    const row = this.stmtGetState.get("last_ledger") as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : null;
  }

  setLastIndexedLedger(ledger: number): void {
    this.stmtSetState.run("last_ledger", String(ledger));
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
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM events")
      .get() as { c: number };
    return row.c;
  }
}
