# نصب قدم‌به‌قدم

این سند فرض می‌کند هیچ‌چیز نصب نشده. هر دستور را به ترتیب اجرا کنید؛ بعد از هر مرحله یک «چطور مطمئن شوم درست بود» آمده.

---

## ۰. تصویر کلی

سه چیز می‌سازیم و به هم وصل می‌کنیم:

1. **Cloudflare Worker** + دیتابیس D1 → آدرس اینترنتی، حافظه، تایمر، ساب‌ها
2. **GitHub Actions** → جمع‌آوری و تست ساعت‌به‌ساعت (رایگان و بدون سرور)
3. **بات تلگرام** → انتشار در کانال

**کامپیوتر شما هیچ نقشی در اجرا ندارد.** فقط برای همین یک‌بار نصب لازم است:

| چه‌چیزی | کجا اجرا می‌شود | هر ساعت چند دقیقه |
| --- | --- | --- |
| تایمر، ذخیره، ساب، پست تلگرام | Cloudflare (ابری) | ۲۴ ساعت شبانه‌روز |
| جمع‌آوری و تست کانفیگ | ماشین مجازی GitHub (ابری) | حدود ۴ دقیقه |
| سایت | Cloudflare Pages (ابری) | ۲۴ ساعت شبانه‌روز |
| **کامپیوتر یا گوشی شما** | — | **صفر** |

بعد از پایان بخش ۸، سیستم را خاموش کنید؛ همه‌چیز سر جای خودش کار می‌کند. اگر هرگز سیستم را روشن نکنید هم ساب‌ها
به‌روز می‌مانند، چون تایمر و انتشار سمت ابر است.

تنها استثنا: **تست از داخل ایران** (بخش ۹) که کاملاً اختیاری است و به هیچ دستگاه همیشگی نیاز ندارد؛
اگر انجامش ندهید، همه‌چیز کار می‌کند و فقط دکمهٔ «ساب ایران» نمایش داده نمی‌شود.

---

## ۱. پیش‌نیازها

| ابزار | نسخه | بررسی |
| --- | --- | --- |
| Node.js | ۲۰ یا بالاتر | `node -v` |
| npm | همراه Node | `npm -v` |
| Python | ۳.۱۰ یا بالاتر | `python --version` |
| git | هر نسخه | `git --version` |
| حساب GitHub | — | — |
| حساب Cloudflare | — | رایگان |
| حساب تلگرام + یک کانال | — | — |

> روی ویندوز اگر `python` کار نکرد، `py` را امتحان کنید.

---

## ۲. ریپو را بالا ببرید

```bash
cd vpnbot
git init
git add .
git commit -m "vpnbot: initial"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

**مهم:** ریپو را **Public** بگذارید. برای ریپوی عمومی، دقایق GitHub Actions نامحدود و رایگان است؛
برای ریپوی خصوصی فقط ۲۰۰۰ دقیقه در ماه دارید و این پروژه ماهی حدود ۱۵۰۰ تا ۲۵۰۰ دقیقه مصرف می‌کند.

بررسی: صفحهٔ ریپو باز شود و `worker/` و `tester/` دیده شود.

---

## ۳. کلید مشترک (TESTER_SECRET)

```bash
python scripts/gen_secret.py
```

خروجی یک رشتهٔ ۶۴ کاراکتری hex است. آن را **همین حالا** در جایی امن ذخیره کنید؛
هم در Worker و هم در GitHub Actions و هم در گوشی ایران به همین یک مقدار نیاز است.

(خط `expect-sig` که روی stderr چاپ می‌شود برای تست داخلی است و لازم نیست جایی ذخیره شود.)

---

## ۴. Cloudflare: دیتابیس و انتشار

```bash
cd worker
npm install
npx wrangler login
```

مرورگر باز می‌شود؛ اجازه بدهید. سپس:

```bash
npx wrangler d1 create vpnbot
```

خروجی چیزی شبیه این دارد:

```toml
[[d1_databases]]
binding = "DB"
database_name = "vpnbot"
database_id = "1a2b3c4d-....-....-....-............"
```

آن `database_id` را در `worker/wrangler.toml` جای مقدار صفر بگذارید:

```toml
database_id = "1a2b3c4d-....-....-....-............"
migrations_dir = "migrations"
```

سپس جدول‌ها را روی دیتابیس ابری بسازید:

```bash
npx wrangler d1 migrations apply vpnbot --remote
```

و در همان فایل، دو مقدار را با اطلاعات خودتان عوض کنید:

```toml
GITHUB_REPO = "YOUR_USER/YOUR_REPO"
PUBLIC_BASE = ""   # اگر دامنهٔ اختصاصی دارید، مثل https://vpn.example.com
SITE_URL    = ""   # آدرس سایت Pages، بعد از مرحلهٔ ۸ پر کنید
```

### ۴.۱ رمزها را ثبت کنید

```bash
npx wrangler secret put TESTER_SECRET      # همان کلید مرحلهٔ ۳
npx wrangler secret put TELEGRAM_BOT_TOKEN # مرحلهٔ ۶
npx wrangler secret put TELEGRAM_CHAT_ID   # مرحلهٔ ۶
npx wrangler secret put GITHUB_TOKEN       # مرحلهٔ ۷
npx wrangler secret put WORKFLOW_FILE      # مقدار: hourly.yml
```

هر دستور مقدار را از ورودی می‌خواند؛ در ترمینال چیزی نمایش داده نمی‌شود، طبیعی است.
می‌توانید بعد از مرحلهٔ ۶ و ۷ این‌ها را هم بزنید؛ Worker بدون آن‌ها هم بالا می‌آید و فقط تلگرام/گیت‌هاب را رد می‌کند.

### ۴.۲ انتشار

```bash
npx wrangler deploy
```

خروجی آدرسی مثل `https://vpnbot.YOUR-SUBDOMAIN.workers.dev` می‌دهد. این را **WORKER_URL** بنامید و ذخیره کنید.

### ۴.۳ بررسی

```bash
curl https://vpnbot.YOUR-SUBDOMAIN.workers.dev/health
```

باید JSON با `"ok": true` ببینید. اگر ۱۰۱۵ یا `error 1016` گرفتید، `database_id` هنوز صفر است.

---

## ۵. GitHub: دو Secret و اولین اجرا

در GitHub → ریپو → **Settings → Secrets and variables → Actions → New repository secret**:

| نام | مقدار |
| --- | --- |
| `WORKER_URL` | `https://vpnbot.YOUR-SUBDOMAIN.workers.dev` |
| `TESTER_SECRET` | همان کلید ۶۴ کاراکتری |

سپس **Actions → hourly-digest → Run workflow** را بزنید و لاگ را باز کنید. باید ببینید:

```
harvesting 6 telegram channels + 9 raw feeds
tg:v2ray_configs  OK  456 links
...
unique configs after parsing: 3000+
candidates: ... total
xray: .../bin/xray
tested 200/280 | alive 15 | 340s
ingested 280 results
published: {global: N, ir: 0, all: N}
```

اگر `401` دیدید یعنی `TESTER_SECRET` دو طرف یکی نیست. اگر `HTTP 404` دیدید `WORKER_URL` غلط است.

---

## ۶. بات تلگرام و کانال

### ۶.۱ ساخت بات

در تلگرام به **@BotFather** پیام دهید → `/newbot` → یک نام و یک نام کاربری (که به `bot` ختم شود) بدهید.
توکنی مثل `123456789:AAH...` می‌گیرید.

### ۶.۲ اضافه کردن به کانال

کانال → **Administrators → Add Administrator** → بات را جست‌وجو و اضافه کنید.
حتماً گزینهٔ **Post Messages** روشن باشد (ارسال پیام، نه فقط خواندن).

### ۶.۳ پیدا کردن chat id

ساده‌ترین راه برای کانال عمومی: از `@username` استفاده کنید:

```
TELEGRAM_CHAT_ID = @my_channel_username
```

اگر کانال خصوصی است، در کانال یک پیام بفرستید و بعد:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

در بخش `channel_post` مقدار `chat.id` چیزی مثل `-1001234567890` است. همان را بگذارید.

### ۶.۴ ثبت

```bash
cd worker
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

> کانال‌های تلگرام را نمی‌شود با حساب بات خواند؛ به همین دلیل جمع‌آوری از صفحهٔ عمومی `t.me/s/...` انجام می‌شود، نه از API.

---

## ۷. توکن GitHub برای کامیت خودکار ساب‌ها

Worker هر ساعت نسخهٔ پشتیبان ساب‌ها را در ریپو کامیت می‌کند؛ این هم آینه است و هم باعث می‌شود
GitHub پس از ۶۰ روز بی‌کاری، ورک‌فلوی زمان‌بندی‌شده را خودش خاموش نکند.

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:

- Repository access: **Only select repositories** → همان ریپو
- Permissions:
  - **Contents: Read and write** (کامیت فایل‌ها)
  - **Actions: Read and write** (صدا زدن workflow_dispatch)
  - **Metadata: Read** (خودکار)

توکن را با نام `GITHUB_TOKEN` ثبت کنید:

```bash
npx wrangler secret put GITHUB_TOKEN
```

> توکن را در فایل یا ریپو ذخیره نکنید. فقط Secret ورکر.

---

## ۸. سایت (Cloudflare Pages)

1. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git**
2. ریپو را انتخاب کنید
3. Framework preset: **None** — Build command: خالی — Build output directory: `site`
4. Save and Deploy

آدرس `https://YOUR-PROJECT.pages.dev` را بگیرید و در `site/config.js` بگذارید:

```js
window.VPNBOT_CONFIG = {
  apiBase: "https://vpnbot.YOUR-SUBDOMAIN.workers.dev",
  refreshSeconds: 90,
};
```

کامیت و پوش کنید؛ Pages خودش دوباره می‌سازد. همان آدرس را در `wrangler.toml` داخل `SITE_URL` بگذارید
و `npx wrangler deploy` را یک‌بار دیگر بزنید.

**چرا ساب‌ها روی Pages نیستند؟** چون Pages با هر کامیت بیلد می‌شود و سقف رایگان ۵۰۰ بیلد در ماه است؛
با کامیت ساعتی، ۷۲۰ بیلد می‌شد و سهمیه می‌سوخت. پس ساب‌ها سرو می‌شوند ولی سایت فقط UI است.

---

## ۹. نقطهٔ ایران — کاملاً اختیاری

**اگر این بخش را رد کنید، هیچ‌چیز خراب نمی‌شود.** ساب جهانی، پست تلگرام، سایت و آینه‌ها همه کار می‌کنند؛
فقط دکمهٔ «ساب ایران» و برچسب 🇮🇷 ساخته نمی‌شود (به‌جای فایل خالی، اصلاً نمایش داده نمی‌شود).

چرا این یک قطعه جدا است: برای این‌که بفهمیم یک کانفیگ از **داخل ایران** جواب می‌دهد، باید درخواست واقعاً از یک
شبکهٔ ایرانی بیرون برود. هیچ سرویس ابری رایگانی گرهٔ شبکه در ایران ندارد (check-host.net هم برای اجرای خودکار ساعتی
محدودیت نرخ سختی دارد)، پس این تنها بخشی است که به یک دستگاه در ایران نیاز دارد.

سه انتخاب دارید:

| انتخاب | هزینه | نتیجه |
| --- | --- | --- |
| هیچ‌کدام — ابری خالص | صفر | همه‌چیز کار می‌کند، ساب ایران وجود ندارد |
| گوشی قدیمی اندروید در ایران (روشن و به برق) | صفر | ساب ایران واقعی از داخل کشور |
| یک دوست/همکار در ایران که گاهی اجرا کند | صفر | همان، با داده کمتر |

مهم: این دستگاه **کامپیوتر شخصی شما نیست** و لازم نیست جای شما باشد؛ داخل ایران باید باشد.

### روی اندروید با Termux

```bash
pkg update -y
pkg install -y python git curl
cd $HOME
git clone https://github.com/YOUR_USER/YOUR_REPO.git vpnbot
cd vpnbot
python tester/agent.py selftest
python tester/agent.py loop \
  --worker https://vpnbot.YOUR-SUBDOMAIN.workers.dev \
  --secret <همان کلید> \
  --vantage ir \
  --interval 45
termux-wake-lock
```

نکته‌ها:

- ریپو را داخل حافظهٔ داخلی (`$HOME`) کلون کنید، نه روی `/sdcard`؛ اندروید اجازهٔ اجرای باینری از آنجا نمی‌دهد.
- Xray باینری مناسب `aarch64` خودش دانلود می‌شود (`tester/bin/xray`).
- در تنظیمات باتری، Termux را از بهینه‌سازی مستثنی کنید وگرنه سیستم آن را می‌خواباند.
- اگر روی گوشی بالا نیامد، هر دستگاهی که داخل ایران و روشن است کافی است؛ لازم نیست کامپیوتر اصلی شما باشد.

### اگر چنین دستگاهی ندارید

کاری نکنید. سیستم بدون آن هم کامل کار می‌کند. اگر بعداً خواستید، همین یک دستور را هر جا که هست اجرا کنید:

```bash
python tester/agent.py loop --worker https://... --secret ... --vantage ir --interval 45
```

هر بار که اجرا شود، کانفیگ‌هایی که از داخل ایران جواب داده‌اند علامت 🇮🇷 می‌خورند و دکمهٔ ساب ایران خودش ظاهر می‌شود.
اگر یک ماه هم اجرا نشود، فقط همان دکمه پنهان می‌ماند؛ بقیهٔ سیستم دست‌نخورده است.

---

## ۱۰. آینه‌ها (برای کاربران ایران حیاتی)

`*.workers.dev` در ایران بارها فیلتر/کند شده است. علاوه بر آدرس ورکر، این‌ها را هم به کاربر بدهید:

| آینه | آدرس | نکته |
| --- | --- | --- |
| GitHub raw | `https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/subs/all.txt` | همیشه تازه، گاهی کند |
| jsDelivr | `https://cdn.jsdelivr.net/gh/YOUR_USER/YOUR_REPO@main/subs/all.txt` | سریع، اما کش ۱۲ ساعته |
| Worker | `https://vpnbot.xxx.workers.dev/sub/all` | سریع‌ترین، ولی ممکن است در ایران فیلتر شود |
| Pages | `https://YOUR-PROJECT.pages.dev` | فقط لیست زنده و دکمهٔ کپی |

برای خالی کردن کش jsDelivr:

```
https://purge.jsdelivr.net/gh/YOUR_USER/YOUR_REPO@main/subs/all.txt
```

---

## ۱۱. چک‌لیست نهایی

```bash
# ۱) ورکر زنده است
curl https://vpnbot.xxx.workers.dev/health

# ۲) امضا و دسترسی درست است
python tester/agent.py selftest --worker https://vpnbot.xxx.workers.dev --secret <secret>

# ۳) ساب سرو می‌شود
curl https://vpnbot.xxx.workers.dev/sub/all | head -c 120

# ۴) داده در D1 هست
cd worker && npx wrangler d1 execute vpnbot --remote --command "SELECT COUNT(*) AS n, SUM(works_global) AS alive FROM configs"

# ۵) ارسال تلگرام
curl -X POST https://vpnbot.xxx.workers.dev/api/dispatch -H "X-Ts: $(date +%s)" -H "X-Sig: ..."
```

برای قدم ۵ بهتر است از خود پایتون استفاده کنید:

```bash
python -c "import sys; sys.path.insert(0, 'tester'); from agent import WorkerClient; print(WorkerClient('https://vpnbot.xxx.workers.dev', '<secret>').post('/api/dispatch', {}))"
```

---

## ۱۲. هزینه و نگهداری

| کار | هر چند وقت |
| --- | --- |
| نگاه کردن به Actions (اجراها سبز هستند؟) | هفتگی |
| اجرای workflow `probe-sources` و حذف منابع مرده | ماهانه |
| بررسی `wrangler tail` برای خطاهای تلگرام | ماهانه |
| بروزرسانی Xray (خودکار: نسخهٔ latest در هر اجرا کش می‌شود) | — |

هزینهٔ ماهانه در حالت استاندارد: **صفر**. جزئیات سقف‌ها در [`FREE-TIERS.md`](FREE-TIERS.md).