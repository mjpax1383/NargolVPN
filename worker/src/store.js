// All D1 access lives here so the request handlers stay dumb and cheap (10ms CPU!).
import { nowSec } from "./net.js";

const CHUNK = 40;

export async function getMeta(env, key, fallback = "") {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(key).first();
  return row ? row.v : fallback;
}

export async function setMeta(env, key, value) {
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(key, String(value))
    .run();
}

const SQL_GLOBAL = [
  "INSERT INTO configs (id, uri, proto, host, port, sni, tag, first_seen, last_seen, last_ok_at, latency_ms, ok_streak, fail_streak, works_global, score)",
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  "ON CONFLICT(id) DO UPDATE SET",
  "  uri = excluded.uri,",
  "  last_seen = excluded.last_seen,",
  "  last_ok_at = COALESCE(excluded.last_ok_at, configs.last_ok_at),",
  "  latency_ms = COALESCE(excluded.latency_ms, configs.latency_ms),",
  "  works_global = excluded.works_global,",
  "  score = excluded.score,",
  "  ok_streak = CASE WHEN excluded.last_ok_at IS NOT NULL THEN configs.ok_streak + 1 ELSE 0 END,",
  "  fail_streak = CASE WHEN excluded.last_ok_at IS NULL THEN configs.fail_streak + 1 ELSE 0 END",
].join(" ");

const SQL_IR = [
  "INSERT INTO configs (id, uri, proto, host, port, sni, tag, first_seen, last_seen, last_ir_at, works_ir, latency_ms, score)",
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  "ON CONFLICT(id) DO UPDATE SET",
  "  last_seen = excluded.last_seen,",
  "  last_ir_at = excluded.last_ir_at,",
  "  works_ir = excluded.works_ir,",
  "  latency_ms = COALESCE(configs.latency_ms, excluded.latency_ms),",
  "  score = MAX(configs.score, excluded.score)",
].join(" ");

const SQL_ATTEMPT = "INSERT OR REPLACE INTO attempts (config_id, vantage, run_id, ts, ok, ok_count, tries, latency_ms, err) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function sanitizeResult(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(id)) return null;
  const uri = String(raw.uri || "").slice(0, 4096);
  if (!uri) return null;
  const proto = String(raw.proto || "").slice(0, 12).toLowerCase();
  const host = String(raw.host || "").slice(0, 255).toLowerCase();
  const port = clampInt(raw.port, 1, 65535, 0);
  if (!proto || !host || !port) return null;
  return {
    id,
    uri,
    proto,
    host,
    port,
    sni: raw.sni ? String(raw.sni).slice(0, 255) : null,
    tag: raw.tag ? String(raw.tag).slice(0, 120) : null,
    ok: raw.ok ? 1 : 0,
    okCount: clampInt(raw.ok_count, 0, 10, 0),
    tries: clampInt(raw.tries, 0, 10, 0),
    latency: raw.latency_ms == null ? null : clampInt(raw.latency_ms, 0, 60000, null),
    err: raw.err ? String(raw.err).slice(0, 120) : null,
    score: Number.isFinite(Number(raw.score)) ? Math.max(0, Math.min(1, Number(raw.score))) : 0,
  };
}

export async function upsertResults(env, vantage, runId, results) {
  const now = nowSec();
  const isIr = vantage !== "global";
  const statements = [];
  let stored = 0;
  for (const r of results) {
    if (isIr) {
      statements.push(env.DB.prepare(SQL_IR).bind(
        r.id, r.uri, r.proto, r.host, r.port, r.sni, r.tag, now, now, now, r.ok, r.latency, r.score,
      ));
    } else {
      statements.push(env.DB.prepare(SQL_GLOBAL).bind(
        r.id, r.uri, r.proto, r.host, r.port, r.sni, r.tag,
        now, now, r.ok ? now : null, r.latency,
        r.ok ? 1 : 0, r.ok ? 0 : 1, r.ok, r.score,
      ));
    }
    statements.push(env.DB.prepare(SQL_ATTEMPT).bind(
      r.id, vantage, runId, now, r.ok, r.okCount, r.tries, r.latency, r.err,
    ));
    stored++;
  }
  for (let i = 0; i < statements.length; i += CHUNK) {
    await env.DB.batch(statements.slice(i, i + CHUNK));
  }
  return stored;
}

export async function insertRun(env, run) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO runs (run_id, vantage, ts, tested, alive, ir, sources_ok, sources_fail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(run.run_id, run.vantage, nowSec(), run.tested || 0, run.alive || 0, run.ir || 0, run.sources_ok || 0, run.sources_fail || 0)
    .run();
}

export async function getState(env, limit = 200, offset = 0) {
  const cutoff = nowSec() - Number(env.STATE_TTL_MIN || 240) * 60;
  const rows = await env.DB.prepare(
    "SELECT id, uri, proto, host, port, sni, works_ir, latency_ms, last_ok_at, score FROM configs " +
      "WHERE works_global = 1 AND last_ok_at >= ? ORDER BY score DESC LIMIT ? OFFSET ?",
  )
    .bind(cutoff, clampInt(limit, 1, 300, 200), Math.max(0, offset))
    .all();
  return rows.results || [];
}

export async function claimIr(env, limit) {
  const stale = nowSec() - 6 * 3600;
  const rows = await env.DB.prepare(
    "SELECT id, uri, proto, host, port, sni, latency_ms, score FROM configs " +
      "WHERE works_global = 1 AND (last_ir_at IS NULL OR last_ir_at < ?) " +
      "ORDER BY COALESCE(last_ir_at, 0) ASC, score DESC LIMIT ?",
  )
    .bind(stale, clampInt(limit, 1, 200, 120))
    .all();
  const items = rows.results || [];
  if (!items.length) return [];
  // Stamp the claim so the same configs do not come back for 6 hours.
  const stamp = nowSec();
  const batch = items.map((row) => env.DB.prepare("UPDATE configs SET claimed_ir_at = ? WHERE id = ?").bind(stamp, row.id));
  for (let i = 0; i < batch.length; i += CHUNK) await env.DB.batch(batch.slice(i, i + CHUNK));
  return items;
}


export async function setSub(env, name, body, plain, count) {
  await env.DB.prepare(
    "INSERT INTO subs (name, body, plain, count, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(name) DO UPDATE SET body = excluded.body, plain = excluded.plain, count = excluded.count, updated_at = excluded.updated_at",
  )
    .bind(name, body, plain, count, nowSec())
    .run();
}

export async function listSubs(env) {
  const rows = await env.DB.prepare("SELECT name, count, updated_at FROM subs ORDER BY name").all();
  return rows.results || [];
}

export async function deleteSubsExcept(env, names, families) {
  // Only touch the families this publish owns: a partial publisher must never
  // wipe a family it did not send.
  const keep = new Set((names || []).filter(Boolean));
  const owned = new Set((families || []).filter(Boolean));
  if (!keep.size || !owned.size) return 0;
  const rows = await env.DB.prepare("SELECT name FROM subs").all();
  const stale = (rows.results || [])
    .map((row) => String(row.name))
    .filter((name) => {
      const match = name.match(/^([a-z]+)\d*$/);
      return match && owned.has(match[1]) && !keep.has(name);
    });
  if (!stale.length) return 0;
  await env.DB.prepare("DELETE FROM subs WHERE name IN (" + stale.map(() => "?").join(",") + ")")
    .bind(...stale)
    .run();
  return stale.length;
}

export async function getSub(env, name) {
  return env.DB.prepare("SELECT body, plain, count, updated_at FROM subs WHERE name = ?").bind(name).first();
}

export async function setTop(env, payload) {
  await env.DB.prepare(
    "INSERT INTO top (id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
  )
    .bind("current", JSON.stringify(payload), nowSec())
    .run();
}

export async function getTop(env) {
  const row = await env.DB.prepare("SELECT body, updated_at FROM top WHERE id = ?").bind("current").first();
  if (!row) return { updated_at: 0, items: [] };
  let parsed = { updated_at: row.updated_at, items: [] };
  try { parsed = JSON.parse(row.body); parsed.updated_at = row.updated_at; } catch (e) { /* keep defaults */ }
  return parsed;
}

export async function health(env) {
  const [total, alive, ir, subs] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM configs").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM configs WHERE works_global = 1 AND last_ok_at >= ?").bind(nowSec() - 6 * 3600).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM configs WHERE works_ir = 1 AND last_ir_at >= ?").bind(nowSec() - 6 * 3600).first(),
    env.DB.prepare("SELECT name, count, updated_at FROM subs").all(),
  ]);
  return {
    ok: true,
    now: nowSec(),
    configs_total: total ? total.n : 0,
    alive_global: alive ? alive.n : 0,
    alive_ir: ir ? ir.n : 0,
    subs: (subs.results || []).reduce((acc, row) => { acc[row.name] = { count: row.count, updated_at: row.updated_at }; return acc; }, {}),
    last_dispatch: Number(await getMeta(env, "last_dispatch", "0")) || 0,
    last_post: Number(await getMeta(env, "last_post", "0")) || 0,
  };
}

export async function prune(env) {
  const cutoff = nowSec() - 7 * 86400;
  await env.DB.prepare("DELETE FROM attempts WHERE ts < ?").bind(cutoff).run();
  await env.DB.prepare("DELETE FROM runs WHERE ts < ?").bind(cutoff).run();
  await env.DB.prepare("DELETE FROM configs WHERE works_global = 0 AND works_ir = 0 AND fail_streak >= 4 AND last_seen < ?")
    .bind(nowSec() - 3 * 86400)
    .run();
  await setMeta(env, "last_prune", String(nowSec()));
}