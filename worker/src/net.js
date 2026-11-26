// Tiny dependency-free helpers: hashing, HMAC, base64, HTML -> text, fetch with timeout.
const TE = new TextEncoder();
const TD = new TextDecoder();

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

export function text(body, contentType = "text/plain; charset=utf-8", cache = "public, max-age=300") {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "access-control-allow-origin": "*",
      "cache-control": cache,
    },
  });
}

export function toHex(buf) {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", TE.encode(str));
  return toHex(digest);
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", TE.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, TE.encode(message));
  return toHex(sig);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Signature scheme (mirrored in tester/agent.py):
//   X-Ts  = unix seconds
//   X-Sig = hex(hmac_sha256(secret, X-Ts + "." + rawBody))
export const MAX_SKEW_SEC = 900;

export async function verifySignature(request, rawBody, secret) {
  if (!secret) return false;
  const ts = request.headers.get("x-ts") || "";
  const sig = (request.headers.get("x-sig") || "").toLowerCase();
  if (!ts || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(nowSec() - tsNum) > MAX_SKEW_SEC) return false;
  const expected = await hmacHex(secret, ts + "." + rawBody);
  return timingSafeEqual(expected, sig);
}

export function b64encodeUtf8(str) {
  const bytes = TE.encode(str);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  }
  return btoa(binary);
}

export function b64decodeUtf8(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return TD.decode(bytes);
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: String.fromCharCode(39), nbsp: " " };

export function decodeEntities(str) {
  return str.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name) => {
    const known = ENTITIES[name];
    if (known !== undefined) return known;
    if (name[0] === "#") {
      const isHex = name[1] === "x" || name[1] === "X";
      const code = parseInt(isHex ? name.slice(2) : name.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code < 0x110000) {
        try { return String.fromCodePoint(code); } catch (e) { return match; }
      }
    }
    return match;
  });
}

export function htmlToText(html) {
  if (!html) return "";
  let out = String(html);
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  out = out.replace(/<[^>]*>/g, "");
  out = decodeEntities(out);
  return out;
}

export async function fetchTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Accepts only http(s) targets; used by /api/probe so the Worker cannot be turned into an SSRF gadget.
export function isPublicHttpUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch (e) { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname;
  if (!host || host === "localhost" || host.endsWith(".local")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\])/.test(host)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false;
  return true;
}