# رفع اشکال

هر مورد: نشانه، علت، درمان. اگر چیزی اینجا نبود، اول `npx wrangler tail` و لاگ Actions را نگاه کنید؛
تقریباً همهٔ خطاها پیام دقیق دارند.

---

## Worker

### `D1_ERROR: no such table: configs`
مایگریشن اجرا نشده. `cd worker && npx wrangler d1 migrations apply vpnbot --remote`

### `500` روی همهٔ مسیرها
`npx wrangler tail` را باز کنید. شایع‌ترین علت: `database_id` هنوز مقدار صفر است یا مایگریشن اعمال نشده.

### `401 unauthorized` از سمت تستر
سه علت به ترتیب احتمال:

1. `TESTER_SECRET` در Worker و GitHub یکی نیست. دوباره `npx wrangler secret put TESTER_SECRET` بزنید.
2. ساعت اجراکنندهٔ تستر بیش از ۱۵ دقیقه اختلاف دارد (ویندوز بدون sync). `w32tm /resync` یا NTP.
3. بدنه در میانهٔ راه تغییر کرده (پراکسی که JSON را بازنویسی می‌کند). مستقیم به `workers.dev` بزنید.

### `1102 Worker exceeded CPU time limit`
یعنی چیزی سنگین در Worker اجرا شده. این پروژه نباید چنین چیزی داشته باشد؛ اگر `src/index.js` را دستکاری کرده‌اید،
پارس/حلقه در Worker را برگردانید به تستر.

### `1027` یا `1015`
سقف روزانهٔ رایگان. تا نیمه‌شب UTC صبر کنید یا کش لبه را فعال‌تر کنید (TTL ساب را بالا ببرید).

### `Address already in use` در `wrangler dev`
پورت ۸۷۸۷ اشغال است: `npx wrangler dev --port 8791 --local`.

---

## تستر (GitHub Actions / گوشی)

### اجرا با `HTTP 404` تمام می‌شود
`WORKER_URL` غلط است. باید بدون اسلش انتهایی و با `https://` باشد.

### `curl_missing`
روی رانر گیت‌هاب همیشه هست. روی اندروید: `pkg install curl`. روی ویندوز: ویندوز ۱۰+ خودش `curl.exe` دارد.

### `xray_start: ...` برای همهٔ کانفیگ‌ها
باینری اجرا نمی‌شود. روی Termux یعنی ریپو در `/sdcard` است (به `$HOME` منتقل کنید)،
یا معماری پشتیبانی نمی‌شود. دستی امتحان کنید:

```bash
./tester/bin/xray version
```

### `alive 0` در حالی که هزاران کانفیگ تست شد
طبیعی است که نرخ بقا پایین باشد (اغلب ۳ تا ۱۰ درصد)، اما صفرِ مطلق یعنی:

- تست از شبکه‌ای اجرا می‌شود که خودش خروجی محدود دارد (بعضی رانرها).
- یا `--timeout` خیلی کم است (زیر ۴ ثانیه). پیش‌فرض ۶ ثانیه است.
- یا منبع‌ها مرده‌اند: `python tester/agent.py sources` و بعد workflow `probe-sources`.

### «همان کانفیگ‌ها دوباره تست می‌شوند»
`tester/state/seen.json` پاک شده (کش Actions منقضی شده). بی‌ضرر است، فقط چند تست تکراری می‌شود.
برای پایدار ماندن، کش `tester/state` را در workflow نگه دارید.

### ورک‌فلوی زمان‌بندی‌شده خودش اجرا نمی‌شود
۱) ۶۰ روز بی‌فعالیتی → ورک‌فلو غیرفعال شده؛ از تب Actions دوباره Enable کنید.
۲) `WORKER_URL`/`TESTER_SECRET` در Secrets نیستند و dispatch خطا می‌دهد؛ `wrangler tail` را ببینید.
۳) توکن گیت‌هاب مجوز **Actions: write** ندارد.

---

## تلگرام

### `telegram_not_configured` در پاسخ publish
`TELEGRAM_BOT_TOKEN` یا `TELEGRAM_CHAT_ID` ثبت نشده‌اند. هر دو را با `wrangler secret put` بگذارید.

### `chat not found`
- کانال خصوصی است و شناسه با `-100` شروع نمی‌شود.
- بات هنوز عضو/ادمین کانال نیست.

### `not enough rights to send text messages`
بات ادمین است ولی گزینهٔ **Post Messages** خاموش است.

### پیام نمی‌آید ولی خطا هم نیست
`POST_COOLDOWN_MIN` (پیش‌فرض ۵۵ دقیقه) فعال است. برای تست فوری `force: true` بفرستید:

```bash
python -c "import sys; sys.path.insert(0, 'tester'); from agent import WorkerClient; print(WorkerClient('https://...', '<secret>').post('/api/publish', {'force': True, 'digest_html': '<b>تست</b>'}))"
```

---

## GitHub

### `github_not_configured`
`GITHUB_TOKEN` ثبت نشده. این خطا کشنده نیست؛ ساب‌ها روی Worker کار می‌کنند.

### `403 Resource not accessible by personal access token`
توکن دسترسی **Contents: Read and write** روی همین ریپو را ندارد. توکن را دوباره بسازید و
`GITHUB_REPO` را با `owner/repo` دقیق تنظیم کنید.

### `404` هنگام dispatch
`WORKFLOW_FILE` باید فقط نام فایل باشد (`hourly.yml`)، نه مسیر کامل. همچنین ورک‌فلو باید روی برنچ پیش‌فرض باشد.

---

## کاربران نهایی

### کاربر ایرانی می‌گوید لینک باز نمی‌شود
`workers.dev` در ایران ناپایدار است. آینه‌های GitHub raw و jsDelivr را بدهید (بخش ۱۰ در DEPLOY).

### کلاینتی ساب را نمی‌خواند
- فایل باید base64 یک متن ساده با خط جدید بین لینک‌ها باشد؛ `/sub/all` همین است.
- اگر کلاینت base64 نمی‌خواهد، `/sub/all/plain` را بدهید.
- کلاینت‌های قدیمی `reality` را نمی‌شناسند؛ آن‌ها را از ساب ایران حذف نکنید، فقط نسخهٔ کلاینت را بگویید.

### کانفیگ‌ها در کلاینت «تایم‌اوت» می‌دهند ولی سایت سالم نشان می‌دهد
سایت از دید سرور خارج تست شده. برای کاربر داخل ایران، `/sub/ir` را بدهید.

---

## ویندوز

### `python` شناخته نمی‌شود
`py` را استفاده کنید، یا هنگام نصب Python گزینهٔ Add to PATH را بزنید.

### `curl` در PowerShell خطا می‌دهد
در PowerShell، `curl` به `Invoke-WebRequest` معنا می‌شود. `curl.exe` بنویسید.