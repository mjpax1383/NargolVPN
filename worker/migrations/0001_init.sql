-- vpnbot schema. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS configs (
  id            TEXT PRIMARY KEY,        -- sha256(proto|host|port|secret|net|path|sni), first 32 hex chars
  uri           TEXT NOT NULL,           -- the original share link
  proto         TEXT NOT NULL,           -- vless | vmess | trojan | ss
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  sni           TEXT,
  tag           TEXT,                    -- cosmetic label from the link
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  last_ok_at    INTEGER,                 -- last time the global vantage completed the full handshake
  latency_ms    INTEGER,
  ok_streak     INTEGER NOT NULL DEFAULT 0,
  fail_streak   INTEGER NOT NULL DEFAULT 0,
  works_global  INTEGER NOT NULL DEFAULT 0,
  works_ir      INTEGER NOT NULL DEFAULT 0,
  last_ir_at    INTEGER,
  claimed_ir_at INTEGER,
  score         REAL    NOT NULL DEFAULT 0,
  posted_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_configs_score  ON configs (score DESC);
CREATE INDEX IF NOT EXISTS idx_configs_global ON configs (works_global, score DESC);
CREATE INDEX IF NOT EXISTS idx_configs_ir     ON configs (works_global, works_ir, last_ir_at);
CREATE INDEX IF NOT EXISTS idx_configs_seen   ON configs (last_seen DESC);

CREATE TABLE IF NOT EXISTS attempts (
  config_id TEXT NOT NULL,
  vantage   TEXT NOT NULL,               -- global | ir | <custom>
  run_id    TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  ok        INTEGER NOT NULL,
  ok_count  INTEGER NOT NULL DEFAULT 0,
  tries     INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  err       TEXT,
  PRIMARY KEY (config_id, vantage, run_id)
);

CREATE INDEX IF NOT EXISTS idx_attempts_ts ON attempts (ts);

CREATE TABLE IF NOT EXISTS subs (
  name       TEXT PRIMARY KEY,           -- ir | global | all
  body       TEXT NOT NULL,              -- base64 subscription payload
  plain      TEXT,                       -- newline separated share links
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS top (
  id         TEXT PRIMARY KEY,           -- singleton row, id = "current"
  body       TEXT NOT NULL,              -- JSON array served to the website
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  vantage      TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  tested       INTEGER NOT NULL DEFAULT 0,
  alive        INTEGER NOT NULL DEFAULT 0,
  ir           INTEGER NOT NULL DEFAULT 0,
  sources_ok   INTEGER NOT NULL DEFAULT 0,
  sources_fail INTEGER NOT NULL DEFAULT 0
);