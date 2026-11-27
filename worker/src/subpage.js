// Browsers get a human page; clients keep the exact same URL and still receive the
// raw subscription. Detection is UA + Sec-Fetch-Mode, with ?format=raw|html as an override.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

const LABELS = { global: "جهانی", ir: "ایران", all: "کامل" };
const PROTO_COLOR = { VLESS: "#3ddc97", VMESS: "#6aa8ff", TROJAN: "#ffb454", SS: "#b48cff" };
const PROTO_ORDER = ["VLESS", "VMESS", "TROJAN", "SS"];

function protoOf(uri) {
  const cut = String(uri).indexOf("://");
  return cut > 0 ? String(uri).slice(0, cut).toUpperCase() : "";
}

function nameOf(uri) {
  const text = String(uri);
  const cut = text.indexOf("#");
  if (cut < 0) return "";
  try {
    return decodeURIComponent(text.slice(cut + 1));
  } catch (error) {
    return text.slice(cut + 1);
  }
}

function hostOf(uri) {
  const core = String(uri).split("#")[0];
  const match = core.match(/@([^@/?#]+):([0-9]+)/);
  if (match) return match[1] + ":" + match[2];
  if (core.slice(0, 8).toLowerCase() === "vmess://") {
    try {
      const b64 = core.slice(8).replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const parsed = JSON.parse(atob(padded));
      if (parsed && parsed.add) return String(parsed.add) + ":" + String(parsed.port || "");
    } catch (error) {
      // Not a payload we understand; fall through to the tag.
    }
  }
  return "";
}

function flagOf(uri) {
  const parts = nameOf(uri).split("|");
  const last = (parts[parts.length - 1] || "").trim();
  if (!last || last.length > 12) return "🌐";
  const point = last.codePointAt(0) || 0;
  return point >= 0x1f1e6 && point <= 0x1f1ff ? last : "🌐";
}

function isStatus(uri) {
  return String(uri).indexOf("127.0.0.1:1") > 0;
}

// The synthetic entry carries the publish time in its name: "NargolVPN | ⏱ 2026-11-27 04:30 UTC".
function statusText(uri) {
  const name = nameOf(uri).split("|").pop().trim();
  return name.replace(/^⏱\s*/, "") || name;
}

export function renderSubPage(input) {
  const { name, plain, updatedAt, base, site } = input;
  const all = String(plain || "").split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
  const status = all.find(isStatus) || "";
  const lines = all.filter((line) => !isStatus(line));
  const count = lines.length;
  const match = String(name).match(/^([a-z]+)([0-9]*)$/);
  const family = match ? match[1] : "";
  const familyLabel = LABELS[family] || name;
  const isFull = !(match && match[2]);
  const label = isFull ? familyLabel + " · همه سرورها" : familyLabel + " · بخش " + match[2];
  const siblings = Array.isArray(input.siblings) ? input.siblings : [];
  const activeIndex = Number(input.index || 1);
  const fullName = input.fullName || family || name;
  const note = String(input.note || "");
  const total = Number(input.total || count);
  const subUrl = base + "/sub/" + name;

  const protos = {};
  for (const line of lines) {
    const proto = protoOf(line);
    protos[proto] = (protos[proto] || 0) + 1;
  }
  const keys = Object.keys(protos).sort((a, b) => PROTO_ORDER.indexOf(a) - PROTO_ORDER.indexOf(b));
  const countries = new Set(lines.map(flagOf).filter((flag) => flag !== "🌐")).size;
  const bars = keys.map((proto) =>
    '<span class="seg" style="width:' + ((protos[proto] / count) * 100).toFixed(1) + "%;background:" +
    (PROTO_COLOR[proto] || "#7f8899") + '"></span>').join("");
  const chips = keys.map((proto) =>
    '<span class="chip"><i style="background:' + (PROTO_COLOR[proto] || "#7f8899") + '"></i>' +
    esc(proto) + " <b>" + protos[proto] + "</b></span>").join("");

  const navParts = [];
  if (siblings.length > 1) {
    navParts.push('<a class="pill' + (isFull ? " on" : "") + '" href="/sub/' + esc(fullName) + '">همه <b>' + total + "</b></a>");
    for (const item of siblings) {
      navParts.push('<a class="pill' + (!isFull && Number(item.index) === activeIndex ? " on" : "") +
        '" href="/sub/' + esc(item.name) + '">بخش ' + esc(item.index) + " <b>" + esc(item.count) + "</b></a>");
    }
  }
  const navHtml = navParts.length ? '<nav class="nav">' + navParts.join("") + "</nav>" : "";
  const fullLink = isFull ? "" : '<a class="btn" href="/sub/' + esc(fullName) + '">همه سرورها<small>ALL IN ONE LINK</small></a>';

  const rows = lines.map((line) => {
    const proto = protoOf(line);
    const color = PROTO_COLOR[proto] || "#7f8899";
    return '<div class="row" data-proto="' + esc(proto) + '" data-find="' + esc((hostOf(line) + " " + nameOf(line)).toLowerCase()) + '">' +
      '<span class="flag">' + esc(flagOf(line)) + "</span>" +
      '<span class="p" style="color:' + color + ";border-color:" + color + '33;background:' + color + '14">' + esc(proto) + "</span>" +
      '<span class="hwrap"><span class="h">' + esc(hostOf(line) || "—") + "</span>" +
      '<span class="lat" data-host="' + esc(hostOf(line)) + '"></span></span>' +
      '<button class="c" data-u="' + esc(line) + '" aria-label="کپی">⧉</button></div>';
  }).join("");

  const body = [
    "<!doctype html>",
    '<html lang="fa" dir="rtl"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="theme-color" content="#080a0d">',
    '<meta name="robots" content="noindex">',
    "<title>NargolVPN | ساب " + esc(label) + "</title>",
    "<style>",
    ":root{--bg:#080a0d;--card:#12161d;--card2:#171c25;--line:#242b37;--text:#eef2f7;--muted:#8b95a6;--accent:#3ddc97;--radius:18px}",
    "*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}",
    "body{margin:0;color:var(--text);line-height:1.65;padding:0 0 40px;",
    'font-family:"Vazirmatn",system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;',
    "background:radial-gradient(900px 420px at 80% -8%,#12281f 0%,transparent 60%),radial-gradient(700px 360px at 10% 0%,#131b2c 0%,transparent 55%),var(--bg)}",
    ".wrap{max-width:680px;margin:0 auto;padding:16px 14px}",
    ".top{position:sticky;top:0;z-index:9;backdrop-filter:blur(14px);background:#080a0dcc;border-bottom:1px solid var(--line);margin:0 -14px 14px;padding:10px 14px;display:flex;align-items:center;gap:10px}",
    ".brand{display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;letter-spacing:.2px}",
    ".dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}",
    ".live{margin-inline-start:auto;font-size:11.5px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 11px;white-space:nowrap}",
    ".live b{color:var(--accent);font-weight:700}",
    ".card{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:var(--radius);padding:18px}",
    ".hero{display:flex;align-items:flex-end;gap:12px;justify-content:space-between}",
    ".num{font-size:46px;font-weight:800;line-height:1;letter-spacing:-1px}",
    ".num small{font-size:13px;font-weight:600;color:var(--muted);margin-inline-start:7px;letter-spacing:0}",
    ".lbl{color:var(--muted);font-size:12.5px;margin-top:6px}",
    ".badge{font-size:11px;color:var(--accent);background:#0f2a20;border:1px solid #1d4a3a;border-radius:999px;padding:3px 10px;white-space:nowrap}",
    ".bar{display:flex;height:9px;border-radius:999px;overflow:hidden;margin:16px 0 10px;background:#0c1017;gap:2px}",
    ".seg{height:100%;display:block}",
    ".note{margin:0 0 10px;font-size:11px;color:#c9a86a;background:#1d1708;border:1px solid #3a2f12;border-radius:10px;padding:8px 10px;line-height:1.7}",
    ".chips{display:flex;flex-wrap:wrap;gap:6px}",
    ".chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:3px 9px;background:#0e131b}",
    ".chip i{width:7px;height:7px;border-radius:50%;display:block}",
    ".chip b{color:var(--text);font-weight:700}",
    ".meta{display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:14px;padding-top:14px;border-top:1px dashed var(--line);font-size:11.5px;color:var(--muted)}",
    ".meta span{white-space:nowrap}",
    ".meta b{color:var(--text);font-weight:700}",
    ".actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px}",
    ".btn{display:flex;flex-direction:column;align-items:center;gap:2px;padding:11px 8px;border-radius:13px;border:1px solid var(--line);background:#1a202b;color:var(--text);font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;text-decoration:none;transition:.15s}",
    ".btn small{font-size:9.5px;font-weight:500;color:var(--muted);letter-spacing:.4px}",
    ".btn:active{transform:scale(.98)}",
    ".btn.primary{grid-column:1/-1;background:linear-gradient(180deg,#3ddc97,#2ab97c);color:#06231a;border-color:transparent}",
    ".btn.primary small{color:#0b3d2c}",
    ".nav{display:flex;gap:7px;overflow-x:auto;padding:14px 2px 4px;scrollbar-width:none}",
    ".nav::-webkit-scrollbar{display:none}",
    ".pill{flex:0 0 auto;font-size:12px;text-decoration:none;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:5px 12px;background:#0e131b}",
    ".pill b{color:var(--text);font-weight:700;margin-inline-start:3px}",
    ".pill.on{background:#10241c;border-color:#1d4a3a;color:var(--accent)}",
    ".pill.on b{color:var(--accent)}",
    ".tools{display:flex;gap:8px;margin:18px 0 10px;align-items:center}",
    ".search{flex:1;display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:9px 12px}",
    ".search input{flex:1;background:none;border:0;outline:0;color:var(--text);font:inherit;font-size:13px}",
    ".search span{color:var(--muted);font-size:13px}",
    ".filters{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;scrollbar-width:none}",
    ".filters::-webkit-scrollbar{display:none}",
    ".f{flex:0 0 auto;font-size:11.5px;border:1px solid var(--line);background:#0e131b;color:var(--muted);border-radius:999px;padding:4px 10px;cursor:pointer;font-family:inherit}",
    ".f.on{color:#06231a;background:var(--accent);border-color:transparent;font-weight:700}",
    ".list{display:flex;flex-direction:column;gap:7px;margin-top:4px}",
    ".row{display:grid;grid-template-columns:22px 54px 1fr 30px;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:13px;padding:9px 10px;content-visibility:auto;contain-intrinsic-size:44px}",
    ".hwrap{min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px;line-height:1.35}",
    ".flag{font-size:16px;line-height:1;text-align:center}",
    ".p{font-size:9.5px;font-weight:800;letter-spacing:.5px;border:1px solid;border-radius:7px;text-align:center;padding:3px 0}",
    ".h{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;direction:ltr;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dfe6ef}",
    ".lat{font-size:10px;color:var(--muted);white-space:nowrap}",
    ".lat:empty{display:none}",
    ".c{background:#1a202b;border:1px solid var(--line);color:var(--text);border-radius:9px;width:32px;height:30px;font-size:13px;cursor:pointer;padding:0}",
    ".c:active{transform:scale(.94)}",
    ".status{display:flex;align-items:center;gap:10px;background:#0f1a25;border:1px solid #1d3a4a;border-radius:13px;padding:11px 13px;margin-bottom:9px}",
    ".status .big{font-size:16px;color:#7fd4ff}",
    ".status div{font-size:12px;color:#a9c6d8;line-height:1.5;flex:1;min-width:0}",
    ".status span.big{flex:0 0 auto}",
    ".status b{color:#e7f4ff;font-weight:700;display:block;font-size:12.5px}",
    ".empty{padding:26px 10px;text-align:center;color:var(--muted);font-size:13px}",
    "footer{margin-top:24px;color:var(--muted);font-size:11px;text-align:center;line-height:1.9}",
    "footer b{color:#c9d2de;font-weight:600}",
    ".toast{position:fixed;inset-inline:0;bottom:20px;margin:auto;width:max-content;max-width:88%;background:var(--accent);color:#06231a;font-weight:800;font-size:12.5px;padding:9px 18px;border-radius:999px;opacity:0;transform:translateY(10px);transition:.2s;pointer-events:none;z-index:20}",
    ".toast.show{opacity:1;transform:translateY(0)}",
    "@media(max-width:430px){.num{font-size:38px}.actions{grid-template-columns:1fr}}",
    "</style></head><body><div class=\"wrap\">",
    '<div class="top"><div class="brand"><span class="dot"></span>NargolVPN</div><span class="live">بروزرسانی <b>' + esc(agoText(updatedAt)) + "</b></span></div>",
    '<section class="card">',
    '<div class="hero"><div><div class="num">' + count + '<small>سرور سالم</small></div><div class="lbl">ساب ' + esc(label) + '</div></div><span class="badge">✅ تست واقعی با Xray</span></div>',
    '<div class="bar">' + bars + "</div>",
    note ? '<div class="note">' + esc(note) + "</div>" : "",
    '<div class="chips">' + chips + "</div>",
    '<div class="meta"><span style="flex-basis:100%">⏱ <b>' + esc(stampText(updatedAt)) + "</b></span><span>🌍 <b>" + (countries || "—") + "</b> کشور</span><span>🔗 <b>" + total + "</b> سرور در کل ساب</span></div>",
    '<div class="actions">',
    '<button class="btn primary" id="copysub">کپی لینک ساب<small>COPY SUBSCRIPTION LINK</small></button>',
    '<a class="btn" href="/sub/' + esc(name) + '/plain" download="nargolvpn-' + esc(name) + '.txt">دانلود فایل<small>DOWNLOAD</small></a>',
    '<a class="btn" href="/sub/' + esc(name) + '/plain">متن خام<small>RAW TEXT</small></a>',
    fullLink,
    "</div>",
    navHtml,
    '<div class="tools"><label class="search"><span>⌕</span><input id="q" type="search" placeholder="جستجوی کشور یا آدرس…" autocomplete="off"></label></div>',
    '<div class="filters" id="filters"></div>',
    '<section class="list" id="list">',
    status ? '<div class="status"><span class="big">⏱</span><div><b>آخرین بروزرسانی ساب</b>' + esc(statusText(status)) + "</div></div>" : "",
    rows,
    '<div class="empty" id="empty" hidden>چیزی با این فیلتر پیدا نشد.</div>',
    "</section>",
    "<footer>هر سرور با اجرای واقعی Xray و یک درخواست HTTP از داخل تونل تست شده، نه پینگ ساده.<br><b>NargolVPN</b>" + (site ? " · " + esc(site) : "") + "</footer>",
    '<div class="toast" id="toast">کپی شد</div>',
    "</div><script>",
    "function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show')},1500)}",
    "function put(text){if(navigator.clipboard&&window.isSecureContext){return navigator.clipboard.writeText(text)}return new Promise(function(res,rej){var a=document.createElement('textarea');a.value=text;a.style.position='fixed';a.style.opacity=0;document.body.appendChild(a);a.select();try{document.execCommand('copy')?res():rej(new Error('copy'))}catch(e){rej(e)}document.body.removeChild(a)})}",
    "document.getElementById('copysub').addEventListener('click',function(){put(" + JSON.stringify(subUrl) + ").then(function(){toast('لینک ساب کپی شد')},function(){toast('کپی نشد، دستی انتخاب کن')})});",
    "var rows=[].slice.call(document.querySelectorAll('.row'));",
    "document.querySelectorAll('.c').forEach(function(b){b.addEventListener('click',function(){put(b.dataset.u).then(function(){toast('کانفیگ کپی شد')},function(){toast('کپی نشد')})})});",
    "var protos={};rows.forEach(function(r){protos[r.dataset.proto]=(protos[r.dataset.proto]||0)+1});",
    "var filters=document.getElementById('filters'),active='*';",
    "function chip(label,key){var b=document.createElement('button');b.className='f'+(key===active?' on':'');b.textContent=label;b.onclick=function(){active=key;[].forEach.call(filters.children,function(c){c.classList.remove('on')});b.classList.add('on');apply()};return b}",
    "filters.appendChild(chip('همه ('+rows.length+')','*'));Object.keys(protos).sort().forEach(function(p){filters.appendChild(chip(p+' ('+protos[p]+')',p))});",
    "var q=document.getElementById('q');function apply(){var term=q.value.trim().toLowerCase(),seen=0;rows.forEach(function(r){var ok=(active==='*'||r.dataset.proto===active)&&(!term||r.dataset.find.indexOf(term)>=0);r.hidden=!ok;if(ok)seen++});document.getElementById('empty').hidden=seen>0}",
    "q.addEventListener('input',apply);",
    "fetch('/api/configs').then(function(r){return r.json()}).then(function(d){var map={};(d.items||[]).forEach(function(it){map[(it.host||'')+':'+(it.port||'')]=it.latency_ms});document.querySelectorAll('.lat').forEach(function(s){var ms=map[s.dataset.host];if(!ms)return;var tone=ms<350?'#3ddc97':(ms<800?'#ffb454':'#8b95a6');s.textContent=Math.round(ms)+'ms';s.style.color=tone})}).catch(function(){});",
    "</script></body></html>",
  ].join(String.fromCharCode(10));

  return body;
}

function agoText(updatedAt) {
  const ts = Number(updatedAt) * 1000;
  if (!ts) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (minutes < 1) return "همین حالا";
  if (minutes < 60) return minutes + " دقیقه پیش";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + " ساعت پیش";
  return Math.round(hours / 24) + " روز پیش";
}

function stampText(updatedAt) {
  const ts = Number(updatedAt) * 1000;
  if (!ts) return "—";
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate()) +
    " " + pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes()) + " UTC";
}

export function wantsHtml(request) {
  const url = new URL(request.url);
  const forced = url.searchParams.get("format");
  if (forced === "raw") return false;
  if (forced === "html") return true;
  const ua = request.headers.get("user-agent") || "";
  if (CLIENT_UA.test(ua)) return false;
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  const low = ua.toLowerCase();
  return BROWSER_HINTS.some((hint) => low.includes(hint));
}

const BROWSER_HINTS = ["mozilla", "chrome", "safari", "firefox", "edg", "opr"];

const CLIENT_UA = /(v2ray|clash|sing-?box|mihomo|shadowrocket|stash|quantumult|surge|loon|hiddify|nekobox|nekoray|karing|streisand|surfboard|foxray|shadowsocks|trojan|wireguard|openvpn|husi|sagernet)/i;