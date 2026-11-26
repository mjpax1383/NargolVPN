// vpnbot worker: cron heartbeat + storage + subscription mirrors + delivery.
// Deliberately tiny per request so it stays inside the free plan CPU budget.
import { fetchTimeout, isPublicHttpUrl, json, nowSec, text, verifySignature } from "./net.js";
import {
  claimIr,
  getMeta,
  getState,
  getSub,
  getTop,
  health,
  insertRun,
  prune,
  sanitizeResult,
  setMeta,
  setSub,
  setTop,
  upsertResults,
} from "./store.js";
import { buildDigest, commitFile, dispatchWorkflow, publicBase, pushSubsToGithub, replyMarkup, sendTelegram, subUrl } from "./publish.js";

const SUB_NAMES = new Set(["ir", "global", "all"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "OPTIONS") return corsPreflight();
      if (path === "/") return landing(env, url);
      if (path === "/health") return json(await health(env));
      if (path.startsWith("/sub/")) return serveSub(env, path);
      if (path === "/api/configs") return apiConfigs(env);
      if (path === "/api/info") return apiInfo(env, url);
      if (path === "/api/state") return auth(request, env, () => apiState(env, url));
      if (path === "/api/claim") return auth(request, env, () => apiClaim(env, url));
      if (path === "/api/ingest") return auth(request, env, (body) => apiIngest(env, body));
      if (path === "/api/publish") return auth(request, env, (body) => apiPublish(env, body, url));
      if (path === "/api/dispatch") return auth(request, env, () => apiDispatch(env));
      if (path === "/api/probe") return auth(request, env, () => apiProbe(env, url));
      return json({ error: "not_found", path }, 404);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-ts, x-sig",
      "access-control-max-age": "86400",
    },
  });
}

async function auth(request, env, fn) {
  const raw = request.method === "POST" ? await request.text() : "";
  const ok = await verifySignature(request, raw, env.TESTER_SECRET);
  if (!ok) return json({ error: "unauthorized" }, 401);
  let body = null;
  if (raw) {
    try { body = JSON.parse(raw); } catch (e) { return json({ error: "bad_json" }, 400); }
  }
  return fn(body);
}

async function serveSub(env, path) {
  const parts = path.split("/").filter(Boolean);
  const name = parts[1] || "all";
  const raw = parts[2] === "plain";
  if (!SUB_NAMES.has(name)) return json({ error: "unknown_sub" }, 404);
  const row = await getSub(env, name);
  if (!row) return text("", "text/plain; charset=utf-8", "no-store");
  const response = raw
    ? text(row.plain || "", "text/plain; charset=utf-8", "public, max-age=120")
    : text(row.body || "", "text/plain; charset=utf-8", "public, max-age=300");
  return edgeCached(response, raw ? 120 : 300);
}

async function apiConfigs(env) {
  const payload = await getTop(env);
  return edgeCached(json(payload, 200, { "cache-control": "public, max-age=60" }), 60);
}

// Hand the response to the edge cache. Without this every reader of /sub/all
// costs one D1 row read and one Worker request against the 100k/day budget.
function edgeCached(response, ttl) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=" + ttl);
  return new Response(response.body, {
    status: response.status,
    headers,
    cf: { cacheEverything: true, cacheTtl: ttl },
  });
}

function apiInfo(env, url) {
  const base = publicBase(env, url.origin);
  return json(
    {
      ok: true,
      version: 1,
      base,
      site: env.SITE_URL || "",
      subs: { all: base + "/sub/all", global: base + "/sub/global", ir: base + "/sub/ir" },
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

async function apiState(env, url) {
  const limit = Number(url.searchParams.get("limit") || 200);
  const offset = Number(url.searchParams.get("offset") || 0);
  const rows = await getState(env, limit, offset);
  return json({ count: rows.length, configs: rows });
}

async function apiClaim(env, url) {
  const vantage = (url.searchParams.get("vantage") || "ir").toLowerCase();
  if (vantage === "global") return json({ error: "global_vantage_collects_locally" }, 400);
  const limit = Number(url.searchParams.get("limit") || env.MAX_IR_CLAIM || 120);
  const rows = await claimIr(env, limit);
  return json({ vantage, count: rows.length, configs: rows });
}

async function apiIngest(env, body) {
  if (!body || typeof body !== "object") return json({ error: "bad_body" }, 400);
  const vantage = String(body.vantage || "global").toLowerCase().slice(0, 24);
  const runId = String(body.run_id || "unknown").slice(0, 64);
  const cap = Number(env.MAX_RESULTS_PER_INGEST || 200);
  const rawResults = Array.isArray(body.results) ? body.results.slice(0, cap) : [];
  const results = rawResults.map(sanitizeResult).filter(Boolean);
  if (!results.length) return json({ stored: 0, alive: 0, dropped: rawResults.length });
  const stored = await upsertResults(env, vantage, runId, results);
  const alive = results.filter((r) => r.ok).length;
  await insertRun(env, {
    run_id: runId,
    vantage,
    tested: results.length,
    alive,
    ir: vantage === "global" ? 0 : alive,
    sources_ok: body.sources_ok || 0,
    sources_fail: body.sources_fail || 0,
  });
  return json({ stored, alive, dropped: rawResults.length - results.length });
}

async function apiPublish(env, body, url) {
  if (!body || typeof body !== "object") return json({ error: "bad_body" }, 400);
  const origin = url.origin;
  const base = publicBase(env, origin);
  const subs = body.subs || {};
  const counts = body.counts || {};
  // 0 when no vantage point inside Iran has run yet: the mirror is then hidden rather than empty.
  const irCount = Number(counts.ir || (subs.ir && subs.ir.count) || 0);

  for (const name of ["ir", "global", "all"]) {
    const sub = subs[name];
    if (!sub || typeof sub.body !== "string") continue;
    await setSub(env, name, sub.body, String(sub.plain || ""), Number(sub.count) || 0);
  }
  if (Array.isArray(body.top)) {
    await setTop(env, { generated_at: nowSec(), items: body.top.slice(0, 60) });
  }

  const now = nowSec();
  const lastPost = Number(await getMeta(env, "last_post", "0")) || 0;
  const cooldown = Number(env.POST_COOLDOWN_MIN || 55) * 60;
  const canPost = body.force === true || now - lastPost >= cooldown;

  let telegram = { posted: false, reason: "cooldown" };
  if (canPost) {
    const html =
      body.digest_html ||
      buildDigest({
        stats: body.stats || {},
        best: body.best || [],
        subs: {
          global: subUrl(env, origin, "global"),
          ir: irCount > 0 ? subUrl(env, origin, "ir") : "",
        },
        generated_at: now,
      });
    const sent = await sendTelegram(env, html, replyMarkup(env, origin, irCount));
    if (sent.ok) {
      await setMeta(env, "last_post", String(now));
      telegram = { posted: true, message_id: sent.message_id };
    } else {
      telegram = { posted: false, reason: sent.err, retry_after: sent.retry_after || 0 };
    }
  } else {
    telegram = { posted: false, reason: "cooldown", next_in: cooldown - (now - lastPost) };
  }

  const github = await pushSubsToGithub(env, subs);
  const readme = "# Subscription mirrors\n\n- all: " + base + "/sub/all\n- ir: " + base + "/sub/ir\n- global: " + base + "/sub/global\n";
  await commitFile(env, "subs/README.md", readme, "subs: refresh mirror readme");

  return json({ ok: true, telegram, github, counts, base });
}

async function apiDispatch(env) {
  const result = await dispatchWorkflow(env);
  if (result.ok) await setMeta(env, "last_dispatch", String(nowSec()));
  return json(result, result.ok ? 200 : 502);
}

async function apiProbe(env, url) {
  const target = url.searchParams.get("u") || "";
  if (!isPublicHttpUrl(target)) return json({ error: "bad_url" }, 400);
  const started = Date.now();
  const res = await fetchTimeout(target, { headers: { "user-agent": "vpnbot-probe" } }, 15000);
  const body = await res.text();
  const matches = body.match(/(?:vless|vmess|trojan|ss):\/\/[^\s<>"]+/g) || [];
  return json({
    status: res.status,
    ms: Date.now() - started,
    bytes: body.length,
    configs: matches.length,
    sample: matches.slice(0, 3).map((item) => item.slice(0, 60) + "..."),
  });
}

async function tick(env) {
  const now = nowSec();
  const lastDispatch = Number(await getMeta(env, "last_dispatch", "0")) || 0;
  const interval = Number(env.DISPATCH_INTERVAL_MIN || 55) * 60;
  if (now - lastDispatch >= interval) {
    const result = await dispatchWorkflow(env);
    if (result.ok) await setMeta(env, "last_dispatch", String(now));
  }
  const lastPrune = Number(await getMeta(env, "last_prune", "0")) || 0;
  if (now - lastPrune >= 3600) await prune(env);
}

function landing(env, url) {
  const base = publicBase(env, url.origin);
  const html = `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vpnbot</title><style>
body{font-family:system-ui,sans-serif;background:#0b0d10;color:#e8eaed;margin:0;padding:48px 20px;line-height:1.9}
main{max-width:640px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{color:#9aa0a6;margin:0 0 24px}
a.card{display:block;background:#14171c;border:1px solid #232830;border-radius:14px;padding:16px 18px;margin-bottom:10px;text-decoration:none;color:#e8eaed}
a.card span{display:block;color:#9aa0a6;font-size:12px;direction:ltr;text-align:left;margin-top:4px}
</style></head><body><main><h1>vpnbot</h1><p>کانفیگ‌های تست‌شده، هر ساعت تازه.</p>
<a class="card" href="/sub/all">سابسکریپشن کامل<span>${base}/sub/all</span></a>
<a class="card" href="/sub/global">ساب جهانی<span>${base}/sub/global</span></a>
<a class="card" href="/sub/ir">ساب سازگار با ایران<span>${base}/sub/ir</span></a>
<a class="card" href="/api/configs">API زنده<span>${base}/api/configs</span></a>
<a class="card" href="/health">وضعیت سرویس<span>${base}/health</span></a>
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}