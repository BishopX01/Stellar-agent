CREATE TABLE IF NOT EXISTS dashboard_cache (
  cache_key  TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- down
DROP TABLE IF EXISTS dashboard_cache;
