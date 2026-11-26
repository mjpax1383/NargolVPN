# معماری و قراردادها

## ۱. تقسیم مسئولیت

| جزء | مسئول | عمداً مسئول نیست |
| --- | --- | --- |
| Cloudflare Worker | ذخیره در D1، سرو ساب، ارسال تلگرام، کامیت گیت‌هاب، تایمر | جمع‌آوری، تست، پارس انبوه |
| GitHub Actions | جمع‌آوری منابع، تست Xray، امتیازدهی، ساخت ساب و متن پست | نگهداری وضعیت بین اجراها |
| دستگاه ایران | تست مجدد از داخل ایران | انتشار |
| Cloudflare Pages | نمایش لیست زنده | سرو ساب |

دلیل سخت‌افزاری: Worker روی V8 Isolate اجرا می‌شود؛ نه `child_process` دارد نه سوکت خام، و سقف CPU آن ۱۰ میلی‌ثانیه
در هر فراخوانی است. حتی `JSON.parse` روی چند هزار کانفیگ می‌تواند آن را بترکاند (خطای 1102). پس کار سنگین بیرون است.

## ۲. جریان یک ساعت

```
T+00:00  cron */15 در Worker بیدار می‌شود (۱۶ بار در ساعت
        tick() می‌بیند از آخرین dispatch بیشتر از ۵۵ دقیقه گذشته
        → POST /repos/.../actions/workflows/hourly.yml/dispatches

T+00:05  GitHub Actions شروع می‌شود
          ۱. selftest آفلاین (پارس و ساخت کانفیگ Xray)
          ۲. harvest: کانال‌های تلگرام + فیدهای GitHub
          ۳. parse: vless/vmess/trojan/ss → Canonical ID
          ۴. فیلتر seen-cache (۳۶ ساعت اخیر را دوباره تست نکن)
          ۵. GET /api/state → لیست زنده‌های ساعت قبل (پیرترین تست اول)
          ۶. تست موازی با Xray + curl — اول تست مجدد، بعد تازه‌ها
          ۷. POST /api/ingest در بسته‌های ۱۰۰تایی
          ۸. GET /api/state + GeoIP زنده‌ها و ساخت ساب‌ها (هر ۵۰ تا یک بخش)
          ۹. POST /api/publish

T+00:20  Worker: upsert در D1، آپدیت subs، ارسال پیام (با cooldown)،
        کامیت subs/*.txt در ریپوی گیت‌هاب

اختیاری: هر ۴۵ دقیقه  دستگاه داخل ایران → GET /api/claim?vantage=ir → تست → POST /api/ingest
اگر چنین دستگاهی نباشد، ستون ir خالی می‌ماند و دکمهٔ ساب ایران در تلگرام و سایت ساخته نمی‌شود.
```

## ۳. احراز هویت (HMAC)

هر درخواست محافظت‌شده دو هدر دارد:

```
X-Ts  = ثانیهٔ یونیکس (رشته)
X-Sig = hex( HMAC-SHA256( secret, X-Ts + "." + rawBody ) )
```

- برای `GET`، بدنهٔ خام رشتهٔ خالی است.
- اختلاف زمانی بیش از **۹۰۰ ثانیه** رد می‌شود (جلوگیری از replay).
- مقایسه با `timingSafeEqual` انجام می‌شود.

همین فرمول در سه جا تکرار شده و هر سه باید یکی بمانند:

| فایل | خط |
| --- | --- |
| `worker/src/net.js` | `verifySignature()` |
| `tester/agent.py` | `WorkerClient._headers()` |
| `scripts/gen_secret.py` | تست خودکار `expect-sig` |

## ۴. مسیرهای عمومی

| مسیر | خروجی |
| --- | --- |
| `GET /` | صفحهٔ راهنمای کوتاه |
| `GET /health` | شمارش‌ها، وضعیت ساب‌ها، آخرین dispatch/post |
| `GET /api/info` | آدرس پایه + همهٔ بخش‌های ساب با تعداد هر کدام |
| `GET /api/configs` | JSON برای سایت (top 60) |
| `GET /sub/all` \| `/sub/global` \| `/sub/ir` | فایل base64 استاندارد ساب — مگر اینکه درخواست از مرورگر باشد (`Sec-Fetch-Mode: navigate` یا UA مرورگر)، که آن‌وقت صفحهٔ HTML برمی‌گردد. `?format=raw` یا `?format=html` این را مجبور می‌کند. عمداً edge-cache نمی‌شود چون کلید کش فقط URL است. |
| `GET /sub/<name>/plain` | همان، بدون base64 |
| `GET /sub/global2` … | بخش‌های بعدی یک خانواده؛ نام با `^(all\|global\|ir)[1-9]?\d?$` اعتبارسنجی می‌شود و بخش ناموجود ۴۰۴ می‌دهد. `/sub/global` همیشه alias بخش اول است. |

## ۵. مسیرهای امضاشده

| مسیر | بدنه | کار |
| --- | --- | --- |
| `GET /api/state?limit=300` | — | کانفیگ‌های زندهٔ ۴ ساعت اخیر، مرتب بر اساس score |
| `GET /api/claim?vantage=ir&limit=120` | — | کانفیگ‌هایی که باید از ایران تست شوند |
| `POST /api/ingest` | `{vantage, run_id, results[], sources_ok, sources_fail}` | ثبت نتیجهٔ تست |
| `POST /api/publish` | `{subs, counts, chunks, top, digest_html, stats, force}` | ذخیرهٔ بخش‌ها + حذف بخش‌های قدیمی + پست تلگرام + کامیت |
| `POST /api/dispatch` | `{}` | صدا زدن دستی ورک‌فلو |
| `POST /api/probe?u=<url>` | — | بررسی سریع یک منبع (SSRF-safe) |

### ۵.۱ شکل `results[]`

```json
{
  "id": "9f2c...e1",
  "uri": "vless://....",
  "proto": "vless",
  "host": "example.com",
  "port": 443,
  "sni": "example.com",
  "tag": "channel-name",
  "ok": true,
  "ok_count": 2,
  "tries": 2,
  "latency_ms": 210,
  "err": "",
  "score": 0.87
}
```

سقف هر درخواست `MAX_RESULTS_PER_INGEST` (پیش‌فرض ۲۰۰) است؛ عامل خودش بسته‌های ۱۰۰تایی می‌فرستد.

### ۵.۲ شکل `subs`

```json
{
  "global": { "body": "<base64>", "plain": "vless://...\nvless://...", "count": 40 },
  "ir":     { "body": "...", "plain": "...", "count": 25 },
  "all":    { "body": "...", "plain": "...", "count": 50 }
}
```

## ۶. هویت کانفیگ (Canonical ID)

```
id = sha256( proto | lower(host) | port | secret | network | path | lower(sni) )  → 32 hex
```

- `secret` برای vless/vmess همان UUID، برای trojan/ss همان رمز عبور است.
- این رشته **نباید** تغییر کند؛ کلید اصلی D1 و کلید dedupe است.
- دو لینک با تگ متفاوت ولی مشخصات یکسان، یک کانفیگ حساب می‌شوند.

## ۷. جدول‌ها

| جدول | نقش |
| --- | --- |
| `configs` | یک ردیف برای هر کانفیگ یکتا: وضعیت، score، streak، آخرین موفقیت |
| `attempts` | تاریخچهٔ هر تلاش (برای دیباگ)، ۷ روز نگه داشته می‌شود |
| `subs` | بدنهٔ سه ساب |
| `top` | ۶۰ مورد برتر برای سایت |
| `runs` | خلاصهٔ هر اجرای تستر |
| `meta` | `last_dispatch`، `last_post` و ... |

### منطق streak (داخل SQL، نه در کد)

```sql
ok_streak   = CASE WHEN excluded.last_ok_at IS NOT NULL THEN ok_streak + 1 ELSE 0 END
fail_streak = CASE WHEN excluded.last_ok_at IS NOT NULL THEN 0 ELSE fail_streak + 1 END
works_global = CASE WHEN fail_streak + 1 >= 2 THEN 0 ELSE 1 END
```

یعنی:

- یک موفقیت → `ok_streak++` و `fail_streak=0`، کانفیگ بلافاصله وارد ساب می‌شود.
- یک شکست → `ok_streak=0` و `fail_streak++`.
- **دو شکست پشت‌سرهم → بازنشسته** (`works_global=0`).
- کانفیگی که ۴ ساعت موفقیتی ثبت نکند، از `/api/state` حذف می‌شود (TTL) و خودبه‌خود از ساب بیرون می‌رود.

## ۸. امتیازدهی

```
success = ok_count / tries            (۰..۱)
speed   = max(0, 1 - latency_ms / 2500)
score   = 0.55*success + 0.40*speed + 0.05*(سازگار با ایران)
```

- `latency_ms` زمان کل درخواست از داخل تونل است (`time_total` در curl)، نه TCP handshake.
- هدف تست `http://cp.cloudflare.com/generate_204` است؛ اگر جواب نداد `gstatic.com/generate_204` امتحان می‌شود.
- انتخاب ساب: مرتب‌سازی نزولی بر اساس score، حذف هاست‌های تکراری، سقف ۴۰ (جهانی/ایران) و ۵۰ (کامل).

## ۹. رفتار در خرابی‌ها

| خرابی | واکنش |
| --- | --- |
| Worker down | ورک‌فلوی زمان‌بندی‌شدهٔ خود GitHub هر ساعت اجرا می‌شود؛ `sleep` و `publish` شکست می‌خورند ولی تست هدر نمی‌رود |
| GitHub Actions down | دادهٔ ساعت قبل همان‌جا می‌ماند؛ ساب‌ها فقط تازه نمی‌شوند |
| منبع ۴۰۴ | رد می‌شود، بقیه ادامه می‌دهند؛ در `probe-sources` دیده می‌شود |
| Xray بالا نیامد | آن کانفیگ شکست می‌خورد (`err=xray_start:...`) |
| Telegram 429 | `retry_after` رعایت می‌شود و پیام بعدی دیرتر می‌رود |
| D1 سقف نوشتن | ingest خطا می‌دهد؛ اجرای بعدی جبران می‌کند (idempotent بر اساس id) |
| cooldown پست | `POST_COOLDOWN_MIN` جلوی دو پیام در یک ساعت را می‌گیرد؛ `force: true` آن را دور می‌زند |

## ۱۰. چرا فقط Cloudflare کافی نیست

| محدودیت | نتیجه |
| --- | --- |
| بدون اجرای باینری | نمی‌توان Xray را بالا آورد |
| بدون سوکت خام | نمی‌توان TCP واقعی به پورت دلخواه زد |
| ۱۰ms CPU | پارس و هش هزاران کانفیگ ممکن نیست |
| cron دقیق نیست | برای «هر ساعت» باید با اختلاف زمانی gate کرد، که همین کار شده |

به همین دلیل Worker «مغز کوچک» است و بازوی اجرایی روی GitHub Actions و دستگاه ایران است.