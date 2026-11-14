# apowo API worker

`apowo-api.js` runs on Cloudflare at `https://api.apowo.app`. It does two things:

- **AI.** It holds the shared Gemini key as a secret and forwards the app's AI requests to Google, with a per-minute and per-day limit for each person. When the preferred model is busy it tries the fallback models itself, so one question counts once. The key never reaches a device.
- **Crash reports.** The app sends uncaught errors here (`boot.js`). They appear under **Workers → apowo-api → Logs**. Search for `apowo-crash`.

This folder is excluded from the website (`_config.yml`), so it isn't served at apowo.app.

## Set it up in the Cloudflare dashboard (about 10 minutes)

1. **Workers & Pages → Create → Create Worker.** Name it `apowo-api` and deploy the starter.
2. **Edit code.** Replace everything with the contents of `apowo-api.js`, then **Deploy**.
3. **Settings → Domains & Routes → Add → Custom domain:** `api.apowo.app`.
4. **Settings → Variables and Secrets:**
   - Add a **Secret** `GEMINI_KEYS`: your Gemini key. Add more keys separated by commas if you want a fallback when one is rate limited.
   - Optional plain-text variables `DAILY_SIGNED_IN` (default 150) and `DAILY_SIGNED_OUT` (default 30).
5. **Storage & Databases → KV → Create** a namespace called `apowo-limits`. Then in the worker, go to **Settings → Bindings → Add → KV namespace**, set the variable name to `LIMITS`, and pick `apowo-limits`. This turns on the daily limit.
6. **Settings → Bindings → Add → Rate limiting**, name `BURST`, 12 requests per 60 seconds. This turns on the per-minute limit.
7. **Settings → Observability:** turn on Workers Logs, so crash reports are kept.

Check it works: open apowo, go to **Analytics → AI** and ask something, without a key of your own.

## Then, in this order

1. **Publish the new `firestore.rules`** (Firebase console → Firestore → Rules). This stops public reads of the old shared key in `publicConfig/aiKeys`.
2. **Replace the old Gemini key** in Google AI Studio. The old one was public for months, so treat it as leaked. Create a new one, put it in `GEMINI_KEYS`, and delete the old one.

## Free-tier limits

- Workers: 100,000 requests a day.
- D1 (`USAGE`, the daily allowance): 100,000 rows written a day. Each AI request writes one row, two when `DAILY_TOTAL` is set. If D1 fails, the request goes through and the failure is logged.
- KV (`LIMITS`, the older counter, only used without `USAGE`): 1,000 writes a day. Past that the daily limit stops counting until midnight UTC.
- Gemini: the free quota belongs to the Google Cloud project, not the key. More keys from the same project add nothing. To raise it, turn on billing for the project (and set a budget). Set `DAILY_TOTAL` a little under the project's daily quota so people see a clear message instead of Google's errors.

## Adding the D1 daily allowance (v4.9.9)

1. **Storage & Databases → D1 → Create** a database called `apowo-usage`.
2. In the worker: **Settings → Bindings → Add → D1 database**, variable name `USAGE`, pick `apowo-usage`.
3. Optional: **Settings → Variables and Secrets → Add** a plain-text `DAILY_TOTAL`.
4. Deploy the new `apowo-api.js`. The worker creates its `ai_usage` table on first use.

Until `USAGE` is bound, the KV counter keeps working as before.
