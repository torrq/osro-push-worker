-- D1 schema for OSRO cross-device sync & multi-device notifications

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  code_hash TEXT UNIQUE,
  email TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  account_id TEXT NOT NULL,
  app TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, app, key)
);

CREATE TABLE IF NOT EXISTS devices (
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  subscription TEXT NOT NULL,
  label TEXT,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);
CREATE INDEX IF NOT EXISTS idx_kv_account_app ON kv(account_id, app);
CREATE INDEX IF NOT EXISTS idx_kv_deleted ON kv(deleted, updated_at);
