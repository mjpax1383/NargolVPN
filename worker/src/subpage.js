// Browsers get a human page; clients keep the exact same URL and still receive the
// raw subscription. Detection is UA + Sec-Fetch-Mode, with ?format=raw|html as an override.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

const LABELS = { global: "جهانی", ir: "ایران", all: "کامل" };

function protoOf(uri) {
  const cut = String(uri).indexOf("://");
  return cut > 0 ? String(uri).slice(0, cut).toUpperCase() : "";
}

function hostOf(uri) {
  const text = String(uri);
  const core = text.split("#")[0];
  const match = core.match(/@([^@\/?#]+):(\d+)/);
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
  return text.split("#")[1] || "";
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

export function renderSubPage(input) {
  const { name, plain, updatedAt, base, site } = input;
  const lines = String(plain || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const count = lines.length;
  const familyMatch = String(name).match(/^([a-z]+)(\d*)$/);
  const familyLabel = familyMatch ? (LABELS[familyMatch[1]] || familyMatch[1]) : name;
  const label = familyMatch && familyMatch[2] && familyMatch[2] !== "1"
    ? familyLabel + " · بخش " + familyMatch[2]
    : familyLabel;
  const siteSuffix = site ? " · " + esc(site) : "";
  const siblings = Array.isArray(input.siblings) ? input.siblings : [];
  const activeIndex = Number(input.index || 1);
  const navHtml = siblings.length > 1
    ? '<nav class="nav">' + siblings.map((item) =>
        '<a class="pill' + (Number(item.index) === activeIndex ? " on" : "") + '" href="/sub/' + esc(item.name) + '">بخش ' +
        esc(item.index || "") + ' <b>' + esc(item.count) + "</b></a>").join("") + "</nav>"
    : "";
  const multiTip = siblings.length > 1
    ? '<div class="tip">این ساب به چند بخش تقسیم شده است. کلاینت فقط همین یک لینک را اضافه می‌کند؛ برای داشتن همهٔ سرورها، بخش‌های دیگر را هم جداگانه اضافه کن.</div>'
    : "";
  const subUrl = base + "/sub/" + name;
  const protos = {};
  for (const line of lines) protos[protoOf(line)] = (protos[protoOf(line)] || 0) + 1;
  const chips = Object.keys(protos).sort().map((p) => '<span class="chip">' + esc(p) + ' <b>' + protos[p] + "</b></span>").join("");
  const rows = lines.slice(0, 80).map((line) => {
    const proto = protoOf(line);
    const host = hostOf(line) || "—";
    return '<div class="row"><span class="p">' + esc(proto) + '</span><span class="h">' + esc(host) +
      '</span><button class="c" data-u="' + esc(line) + '">کپی</button></div>';
  }).join("");

  const body = [
    "<!doctype html>",
    '<html lang="fa" dir="rtl"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="theme-color" content="#0b0d10">',
    "<title>NargolVPN | ساب " + esc(label) + "</title>",
    "<style>",
    ":root{--bg:#0b0d10;--card:#141821;--line:#232a36;--text:#e9edf3;--muted:#8d97a8;--accent:#3ddc97;--radius:16px}",
    "*{box-sizing:border-box}",
    "body{margin:0;background:radial-gradient(1200px 500px at 50% -10%,#14202b 0%,var(--bg) 60%);color:var(--text);",
    'font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;line-height:1.7;padding:22px 16px 44px}',
    ".wrap{max-width:640px;margin:0 auto}",
    ".brand{display:flex;align-items:center;gap:9px;font-weight:800;font-size:20px;letter-spacing:.2px}",
    ".dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 14px var(--accent)}",
    ".subtitle{color:var(--muted);font-size:13px;margin:6px 0 14px}",
    ".nav{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 16px}",
    ".pill{font-size:12.5px;text-decoration:none;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 12px}",
    ".pill b{color:var(--text);font-weight:700}",
    ".pill.on{background:#10241c;border-color:#1d4a3a;color:var(--accent)}",
    ".pill.on b{color:var(--accent)}",
    ".card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;text-align:center}",
    ".num{font-size:44px;font-weight:800;line-height:1.1}",
    ".num small{font-size:14px;color:var(--muted);font-weight:600;margin-inline-start:6px}",
    ".lbl{color:var(--muted);font-size:13px;margin-top:2px}",
    ".time{color:var(--muted);font-size:12px;margin-top:10px}",
    ".chips{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;margin-top:14px}",
    ".chip{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:3px 9px}",
    ".chip b{color:var(--text)}",
    ".actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:18px}",
    ".btn{display:flex;flex-direction:column;align-items:center;gap:1px;padding:11px 8px;border-radius:12px;border:1px solid var(--line);",
    "background:#1b2130;color:var(--text);font:inherit;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none}",
    ".btn small{font-size:10px;font-weight:500;color:var(--muted);letter-spacing:.3px}",
    ".btn.primary{grid-column:1/-1;background:linear-gradient(180deg,#3ddc97,#2bb87c);color:#06231a;border-color:transparent}",
    ".btn.primary small{color:#0b3d2c}",
    ".tip{background:#101720;border:1px dashed var(--line);border-radius:12px;padding:13px 15px;margin-top:16px;font-size:12.5px;color:var(--muted)}",
    ".tip b{color:var(--text);direction:ltr;unicode-bidi:isolate}",
    "h2{font-size:14px;margin:26px 0 10px;color:var(--muted);font-weight:700}",
    ".list{display:flex;flex-direction:column;gap:7px}",
    ".row{display:grid;grid-template-columns:64px 1fr auto;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);",
    "border-radius:12px;padding:9px 12px}",
    ".p{font-size:10px;font-weight:800;letter-spacing:.4px;color:var(--accent);border:1px solid #1d4a3a;background:#10241c;",
    "border-radius:8px;text-align:center;padding:3px 0}",
    ".h{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;direction:ltr;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".c{background:#1b2130;border:1px solid var(--line);color:var(--text);border-radius:9px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer}",
    ".c:active{transform:scale(.96)}",
    "footer{margin-top:26px;color:var(--muted);font-size:11.5px;text-align:center;line-height:1.9}",
    ".toast{position:fixed;inset-inline:0;bottom:22px;margin:auto;width:max-content;max-width:90%;background:#3ddc97;color:#06231a;",
    "font-weight:800;font-size:13px;padding:9px 18px;border-radius:999px;opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none}",
    ".toast.show{opacity:1;transform:translateY(0)}",
    "@media(max-width:420px){.actions{grid-template-columns:1fr}}",
    "</style></head><body><div class=\"wrap\">",
    '<div class="brand"><span class="dot"></span>NargolVPN</div>',
    '<div class="subtitle">کانفیگ‌های تست‌شده با اتصال واقعی · به‌روزرسانی خودکار هر ساعت</div>',
    navHtml,
    '<section class="card">',
    '<div class="num">' + count + '<small>کانفیگ</small></div>',
    '<div class="lbl">ساب ' + esc(label) + "</div>",
    '<div class="time">آخرین بروزرسانی: ' + esc(agoText(updatedAt)) + "</div>",
    '<div class="chips">' + chips + "</div>",
    '<div class="actions">',
    '<button class="btn primary" id="copysub">کپی لینک ساب<small>COPY SUBSCRIPTION LINK</small></button>',
    '<a class="btn" href="/sub/' + esc(name) + '/plain">متن خام<small>RAW TEXT</small></a>',
    '<a class="btn" href="data:text/plain;charset=utf-8,' + esc(encodeURIComponent(String(plain || ""))) + '" download="nargol-' + esc(name) + '.txt">دانلود فایل<small>DOWNLOAD</small></a>',
    "</div>",
    "</section>",
    multiTip,
    '<div class="tip">این صفحه را مرورگر می‌بیند. اگر همین لینک را در <b>v2rayNG</b>، <b>NekoBox</b>، <b>Hiddify</b> یا <b>Clash</b> به‌عنوان «سابسکریپشن» اضافه کنی، خودِ فایل را دریافت می‌کند.</div>',
    "<h2>کانفیگ‌ها</h2>",
    '<section class="list">' + rows + "</section>",
    "<footer>سالم‌بودن هر کانفیگ با اجرای واقعی Xray بررسی شده، نه پینگ ساده.<br>NargolVPN" + siteSuffix + "</footer>",
    '<div class="toast" id="toast">کپی شد</div>',
    "</div><script>",
    "function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},1400)}",
    "function put(text){if(navigator.clipboard&&window.isSecureContext){return navigator.clipboard.writeText(text)}",
    "return new Promise(function(res,rej){var a=document.createElement('textarea');a.value=text;a.style.position='fixed';a.style.opacity=0;",
    "document.body.appendChild(a);a.select();try{document.execCommand('copy')?res():rej()}catch(e){rej(e)}document.body.removeChild(a)})}",
    "document.getElementById('copysub').addEventListener('click',function(){put(" + JSON.stringify(subUrl) + ").then(function(){toast('لینک ساب کپی شد')},function(){toast('کپی نشد؛ دستی انتخاب کن')})});",
    "document.querySelectorAll('.c').forEach(function(b){b.addEventListener('click',function(){put(b.dataset.u).then(function(){toast('کانفیگ کپی شد')},function(){toast('کپی نشد')})})});",
    "</script></body></html>",
  ].join("\n");

  return body;
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