// Outbound delivery: Telegram digest, subscription mirrors, GitHub commits, Actions dispatch.
import { b64encodeUtf8, fetchTimeout, nowSec } from "./net.js";

const UA = "vpnbot-worker (https://github.com)";

function ghHeaders(env) {
  return {
    authorization: "Bearer " + env.GITHUB_TOKEN,
    accept: "application/vnd.github+json",
    "user-agent": UA,
    "x-github-api-version": "2022-11-28",
  };
}

export function publicBase(env, origin) {
  const configured = (env.PUBLIC_BASE || "").trim().replace(/\/+$/, "");
  return configured || origin;
}

export function subUrl(env, origin, name) {
  return publicBase(env, origin) + "/sub/" + name;
}

function chunkButtons(env, origin, family, total, icon, label) {
  const rows = [];
  const buttons = [];
  for (let index = 1; index <= total; index += 1) {
    buttons.push({
      text: total === 1 ? icon + " " + label : icon + " بخش " + index,
      url: subUrl(env, origin, family + index),
    });
  }
  for (let index = 0; index < buttons.length; index += 4) rows.push(buttons.slice(index, index + 4));
  return rows;
}

export function replyMarkup(env, origin, chunks) {
  const global = Math.max(1, Math.min(9, Number((chunks && chunks.global) || 1)));
  const ir = Math.max(0, Math.min(9, Number((chunks && chunks.ir) || 0)));
  const rows = chunkButtons(env, origin, "global", global, "🌍", "ساب جهانی");
  // The Iranian mirror only exists once a vantage point inside Iran has run.
  if (ir > 0) rows.push(...chunkButtons(env, origin, "ir", ir, "🇮🇷", "ساب ایران"));
  const site = (env.SITE_URL || "").trim();
  if (site) rows.push([{ text: "📊 لیست زنده و وضعیت", url: site }]);
  return { inline_keyboard: rows.length ? rows : chunkButtons(env, origin, "global", 1, "🌍", "ساب جهانی") };
}

export async function sendTelegram(env, html, markup) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, err: "telegram_not_configured" };
  if (!html) return { ok: false, err: "empty_digest" };
  const text = html.length > 3900 ? html.slice(0, 3890) + "\n…" : html;
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (markup) payload.reply_markup = markup;
  try {
    const res = await fetchTimeout("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, 15000);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const retry = data && data.parameters && data.parameters.retry_after;
      return { ok: false, err: (data && data.description) || "http_" + res.status, retry_after: retry || 0 };
    }
    return { ok: true, message_id: data.result && data.result.message_id };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}

export async function commitFile(env, path, content, message) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || env.GITHUB_REPO.indexOf("/") < 0) {
    return { ok: false, err: "github_not_configured" };
  }
  const branch = env.GITHUB_BRANCH || "main";
  const api = "https://api.github.com/repos/" + env.GITHUB_REPO + "/contents/" + path;
  try {
    let sha = null;
    const head = await fetchTimeout(api + "?ref=" + encodeURIComponent(branch), { headers: ghHeaders(env) }, 12000);
    if (head.ok) {
      const data = await head.json();
      sha = data && data.sha;
      if (sha && data.content) {
        const current = atob(String(data.content).replace(/\s+/g, ""));
        if (current === content) return { ok: true, unchanged: true };
      }
    } else if (head.status !== 404) {
      return { ok: false, err: "head_" + head.status };
    }
    const body = { message, content: b64encodeUtf8(content), branch };
    if (sha) body.sha = sha;
    const put = await fetchTimeout(api, {
      method: "PUT",
      headers: { ...ghHeaders(env), "content-type": "application/json" },
      body: JSON.stringify(body),
    }, 15000);
    if (!put.ok) {
      const data = await put.json().catch(() => ({}));
      return { ok: false, err: "put_" + put.status + ":" + ((data && data.message) || "") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}

export async function dispatchWorkflow(env) {
  const file = (env.WORKFLOW_FILE || "").trim();
  if (!file || !env.GITHUB_TOKEN || env.GITHUB_REPO.indexOf("/") < 0) return { ok: false, err: "dispatch_not_configured" };
  try {
    const res = await fetchTimeout(
      "https://api.github.com/repos/" + env.GITHUB_REPO + "/actions/workflows/" + file + "/dispatches",
      {
        method: "POST",
        headers: { ...ghHeaders(env), "content-type": "application/json" },
        body: JSON.stringify({ ref: env.GITHUB_BRANCH || "main" }),
      },
      12000,
    );
    if (res.status === 204) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, err: "dispatch_" + res.status + ":" + ((data && data.message) || "") };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}

export async function pushSubsToGithub(env, subs) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const results = {};
  const numbered = Object.keys(subs || {})
    .filter((name) => /^(all|global|ir)\d+$/.test(name) && subs[name] && typeof subs[name].body === "string")
    .sort();
  for (const name of numbered) {
    results[name] = await commitFile(
      env,
      "subs/" + name + ".txt",
      subs[name].body,
      "subs(" + name + "): " + (subs[name].count || 0) + " configs @ " + stamp,
    );
  }
  // One flat archive of every published config, so the repo alone can rebuild a sub.
  const archive = numbered
    .filter((name) => name.indexOf("all") === 0)
    .map((name) => String(subs[name].plain || ""))
    .join("\n")
    .split("\n")
    .filter(Boolean)
    .join("\n");
  if (archive) {
    results["all.txt"] = await commitFile(env, "subs/all.txt", archive, "subs(all): archive @ " + stamp);
  }
  return results;
}

export function buildDigest(input) {
  const { stats = {}, best = [], subs = {} } = input;
  const fmt = (n) => (Number(n) || 0).toLocaleString("en-US");
  const lines = [];
  lines.push("🔄 <b>بروزرسانی ساعتی کانفیگ‌ها</b>");
  lines.push("");
  lines.push("🧪 تست‌شده: " + fmt(stats.tested) + " · ✅ سالم: " + fmt(stats.alive) + " · 🇮🇷 سازگار با ایران: " + fmt(stats.ir));
  const families = [
    ["🌍 ساب جهانی", Array.isArray(subs.global) ? subs.global : [subs.global]],
    ["🇮🇷 ساب ایران", Number(stats.ir) > 0 ? (Array.isArray(subs.ir) ? subs.ir : [subs.ir]) : []],
  ];
  for (const [label, urls] of families) {
    const list = (urls || []).filter(Boolean);
    if (!list.length) continue;
    if (list.length === 1) lines.push(label + ": <code>" + list[0] + "</code>");
    else {
      lines.push(label + " (" + list.length + " بخش):");
      list.forEach((url, index) => lines.push((index + 1) + ". <code>" + url + "</code>"));
    }
  }
  lines.push("");
  if (best.length) {
    lines.push("<b>🏆 سریع‌ترین‌ها</b>");
    best.slice(0, 8).forEach((item, i) => {
      const badge = item.works_ir ? "🇮🇷" : "🌍";
      lines.push((i + 1) + ". " + badge + " <code>" + String(item.host || "").slice(0, 40) + ":" + item.port + "</code> · " + (item.latency_ms || 0) + "ms · " + String(item.proto || "").toUpperCase());
    });
  }
  lines.push("");
  lines.push("⏱ زمان تست: " + (input.generated_at ? new Date(input.generated_at * 1000).toISOString().slice(11, 16) + " UTC" : "—"));
  return lines.join("\n");
}

export function armour(uris) {
  const plain = (uris || []).filter(Boolean).join("\n");
  return { body: b64encodeUtf8(plain), plain, count: (uris || []).length };
}