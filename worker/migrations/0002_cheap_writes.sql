-- 0002: stop spending D1's rows_written budget on data nothing reads.
--
-- Cost model that made this necessary: D1 counts one written row per table row AND
-- per index entry. So every tested config used to cost 6 rows in `configs`
-- (row + id index + 4 secondary indexes) plus 3 in `attempts`, i.e. ~9 rows for a
-- probe whose outcome was thrown away. At ~540 probes an hour that is ~120k rows a
-- day against a 100k free-tier limit.
--
-- 1) attempts was write-only debug telemetry. runs (one row per run) already keeps
--    tested/alive. Dropping it also removes an hourly bulk DELETE that counted as
--    one written row per deleted row.
DROP INDEX IF EXISTS idx_attempts_ts;
DROP TABLE IF EXISTS attempts;

-- 2) These three indexes are not used by any query:
--    idx_configs_score  -> getState orders by score but filters on works_global first
--    idx_configs_ir     -> only the (rare) ir claim reads last_ir_at
--    idx_configs_seen   -> only prune's last_seen scan, which is cheap on a small table
--    Every index costs one written row on every config upsert, so they are pure cost.
DROP INDEX IF EXISTS idx_configs_score;
DROP INDEX IF EXISTS idx_configs_ir;
DROP INDEX IF EXISTS idx_configs_seen;

-- 3) The one index that is actually needed: the alive-pool lookup.
CREATE INDEX IF NOT EXISTS idx_configs_global ON configs (works_global, score DESC);
