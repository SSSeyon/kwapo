// apowo API — a Cloudflare Worker at https://api.apowo.app
//
//   POST /gemini/<model>  Forwards a Gemini generateContent request using the
//                         shared key, which lives here as a secret and never
//                         reaches a device.
//   POST /report          Receives crash reports from the app and writes them
//                         to the Worker's logs (Workers → apowo-api → Logs).
//   GET  /logo/search     Finds company logos by name, for category and item
//   GET  /logo/img        icons (see "Logos" below).
//
// Limits (all optional; each one is skipped when its binding is missing):
//   BURST  Rate Limiting binding: requests per minute per person.
//   USAGE  D1 database: AI requests per day per person, and for everyone
//          together (DAILY_TOTAL). Free plan: 100,000 writes a day.
//   LIMITS KV namespace: the older per-day counter, used only when USAGE is
//          missing. Free plan: 1,000 writes a day, after which it stops
//          counting (AI keeps working, unlimited).
// "Person" is the Firebase account when the app sends a valid ID token, and
// the network address otherwise.
//
// Settings (Worker → Settings → Variables and Secrets):
//   GEMINI_KEYS     secret. One or more Gemini API keys, comma separated;
//                   the next one is tried when a key is rate limited.
//   DAILY_SIGNED_IN plain text, default 150. AI requests/day per account.
//   DAILY_SIGNED_OUT plain text, default 30. AI requests/day per address.
//   DAILY_TOTAL     plain text, optional. AI requests/day for everyone
//                   together (needs USAGE). Set it a little under the Gemini
//                   project's daily quota so people get a clear message
//                   instead of Google's errors.
//
// Models (v4.9.9): the app asks for its preferred model; when that one is
// rate limited, missing or failing, this worker tries the rest of MODELS
// itself and says so with x-apowo-cascade, so one question is one request
// against the allowance. x-apowo-model names the model that answered.

const PROJECT_ID = 'spendwise-d6393';
const ALLOWED_ORIGINS = ['https://apowo.app'];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX_AI_BODY = 3 * 1024 * 1024;   // the app sends the user's whole history as context
const MAX_REPORT_BODY = 8 * 1024;
const MODEL_RE = /^gemini-[a-z0-9.\-]{1,40}$/;
// Keep in step with AI_MODELS in app.js (best first).
const MODELS = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin);
    const cors = allowed ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Expose-Headers': 'x-apowo-refusal, x-apowo-model, x-apowo-cascade',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    } : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return json({ error: { message: 'Not allowed from this site.' } }, 403, cors);

    const url = new URL(request.url);
    if (request.method === 'GET') {
      try {
        if (url.pathname === '/logo/search') return await logoSearch(url, request, env, cors);
        if (url.pathname === '/logo/img') return await logoImg(url, cors);
      } catch (e) {
        console.error('logo error', e && e.stack || e);
        return json({ error: { message: 'Logo search hit an error.' } }, 500, cors);
      }
      return json({ error: { message: 'Not found.' } }, 404, cors);
    }
    if (request.method !== 'POST') return json({ error: { message: 'POST only.' } }, 405, cors);

    try {
      if (url.pathname === '/report') return await report(request, env, cors);
      const m = /^\/gemini\/([^/]+)$/.exec(url.pathname);
      if (m) return await gemini(request, env, ctx, cors, decodeURIComponent(m[1]));
      return json({ error: { message: 'Not found.' } }, 404, cors);
    } catch (e) {
      console.error('worker error', e && e.stack || e);
      return json({ error: { message: 'The AI service hit an error.' } }, 500, cors);
    }
  },
};

// ── AI ─────────────────────────────────────────────────────────────────────
async function gemini(request, env, ctx, cors, model) {
  if (!MODEL_RE.test(model)) return json({ error: { message: 'Unknown model.' } }, 400, cors);
  const keys = String(env.GEMINI_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!keys.length) return refuse('The AI service is not set up yet.', 503, cors);

  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_AI_BODY) return json({ error: { message: 'Request too large.' } }, 413, cors);

  // Who is asking: a verified account, or else the network address.
  let who = 'ip:' + (request.headers.get('CF-Connecting-IP') || 'unknown');
  let signedIn = false;
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const uid = await verifyFirebaseToken(auth.slice(7));
    if (!uid) return refuse('Your sign-in has expired. Reopen apowo and try again.', 401, cors);
    who = 'uid:' + uid; signedIn = true;
  }

  if (env.BURST) {
    const { success } = await env.BURST.limit({ key: who });
    if (!success) return refuse('Too many AI requests at once. Wait a minute and try again.', 429, cors);
  }
  const body = await request.text();
  if (body.length > MAX_AI_BODY) return json({ error: { message: 'Request too large.' } }, 413, cors);

  const over = await dailyAllowance(env, ctx, who, signedIn);
  if (over) return refuse(over, 429, cors);

  // Try the asked-for model, then the rest of MODELS after it. Within a model,
  // try each key; a rate-limited (429) or rejected (401/403) key moves to the
  // next key, a missing model (404) or a server error (5xx) to the next model.
  // A bad request (400) is the request's fault: return it as it is.
  const start = MODELS.indexOf(model);
  const chain = start < 0 ? [model] : MODELS.slice(start);
  let res = null, keyTrouble = false;
  for (const m of chain) {
    for (const key of keys) {
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body,
        });
      } catch (e) { res = null; break; }   // Google unreachable: try the next model
      if (res.ok) return answer(res, m, cors);
      if (res.status === 400) return answer(res, m, cors);
      if (res.status === 401 || res.status === 403) {
        keyTrouble = true;
        console.error('Gemini rejected a shared key', res.status, m, await res.text());
        continue;
      }
      if (res.status !== 429) break;       // 404 / 5xx: this model, whatever the key
    }
  }
  // Problems with the shared key are ours, not the user's: don't let the app
  // tell them to fix "their" key.
  if (keyTrouble && (!res || res.status === 401 || res.status === 403)) {
    return json({ error: { message: 'The shared AI key needs attention.' } }, 502, { ...cors, 'x-apowo-cascade': '1' });
  }
  if (!res) return json({ error: { message: 'The AI service could not reach Google.' } }, 502, { ...cors, 'x-apowo-cascade': '1' });
  return answer(res, chain[chain.length - 1], cors);
}
function answer(res, model, cors) {
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'x-apowo-model': model, 'x-apowo-cascade': '1', ...cors,
    },
  });
}

// ── Daily allowance ────────────────────────────────────────────────────────
// Returns a refusal message when today's allowance is used up, else ''.
// Counters reset at midnight UTC. A storage failure never blocks AI: it is
// logged and the request goes through (the per-minute limit still applies).
let usageTableReady = false;
async function dailyAllowance(env, ctx, who, signedIn) {
  const cap = Number(signedIn ? env.DAILY_SIGNED_IN || 150 : env.DAILY_SIGNED_OUT || 30);
  const total = Number(env.DAILY_TOTAL || 0);
  const day = new Date().toISOString().slice(0, 10);
  const mine = signedIn
    ? `You've used today's ${cap} AI requests. They reset at midnight UTC, or add your own free Gemini key under Keys….`
    : `Today's AI allowance for signed-out use is used up. Sign in for more, or add your own free Gemini key under Keys….`;
  const everyone = `apowo's AI has reached today's limit for everyone. It resets at midnight UTC, or add your own free Gemini key under Keys….`;

  if (env.USAGE) {
    try {
      const db = env.USAGE;
      if (!usageTableReady) {
        await db.prepare('CREATE TABLE IF NOT EXISTS ai_usage (k TEXT PRIMARY KEY, n INTEGER NOT NULL, day TEXT NOT NULL)').run();
        usageTableReady = true;
      }
      // One statement adds one and returns the new count, so two requests at
      // the same moment can't both slip under the cap.
      const bump = k => db.prepare('INSERT INTO ai_usage (k, n, day) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n').bind(k, day).first('n');
      if ((await bump(`ai:${day}:${who}`)) > cap) return mine;
      if (total > 0 && (await bump(`ai:${day}:all`)) > total) return everyone;
      // Now and then, clear counters older than yesterday.
      if (Math.random() < 0.02) {
        const old = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);
        ctx.waitUntil(db.prepare('DELETE FROM ai_usage WHERE day < ?1').bind(old).run().catch(e => console.warn('usage cleanup failed', e && e.message)));
      }
      return '';
    } catch (e) {
      console.warn('daily limit not recorded (D1)', e && e.message);
      return '';
    }
  }
  if (env.LIMITS) {
    const k = `ai:${day}:${who}`;
    const used = Number(await env.LIMITS.get(k)) || 0;
    if (used >= cap) return mine;
    // Approximate (KV is eventually consistent), which is fine for a daily cap.
    // A failed write (e.g. the free tier's 1,000 writes/day) must not block AI.
    try { await env.LIMITS.put(k, String(used + 1), { expirationTtl: 2 * 86400 }); }
    catch (e) { console.warn('daily limit not recorded', e && e.message); }
  }
  return '';
}

// ── Crash reports ──────────────────────────────────────────────────────────
async function report(request, env, cors) {
  if (env.BURST) {
    const { success } = await env.BURST.limit({ key: 'report:' + (request.headers.get('CF-Connecting-IP') || '') });
    if (!success) return new Response(null, { status: 204, headers: cors });
  }
  const text = (await request.text()).slice(0, MAX_REPORT_BODY);
  let r;
  try { r = JSON.parse(text); } catch { return new Response(null, { status: 400, headers: cors }); }
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
  // Logged, not stored: view under Workers → apowo-api → Logs.
  console.error(JSON.stringify({
    kind: 'apowo-crash',
    v: clip(r.v, 20), msg: clip(r.msg, 500), src: clip(r.src, 200), stack: clip(r.stack, 2000),
    mode: clip(r.mode, 12), ua: clip(request.headers.get('User-Agent'), 200),
    country: clip(request.cf && request.cf.country, 4),
  }));
  return new Response(null, { status: 204, headers: cors });
}

// ── Logos for categories and items ─────────────────────────────────────────
// GET /logo/search?q=cloudflare → {results:[{name, domain, desc}]}
//   Names are matched to official websites through Wikidata (free, no key),
//   plus the query itself if it looks like a web address, plus name.com /
//   name.ng / name.com.ng guesses. The app shows a tile per result and drops
//   any whose image doesn't load.
// GET /logo/img?d=cloudflare.com → the site's icon (Google's favicon service,
//   128px), with CORS so the app can shrink it and store it with the user's
//   data. Searches run here rather than in the app so people's typed names go
//   to Wikidata and Google from this server, not from their device.
const WIKIDATA_UA = { 'User-Agent': 'apowo-logo-search/1.0 (https://apowo.app)' };
const DOMAIN_RE = /^(?=.{3,100}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
function bareHost(s) {
  try { return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}
async function logoSearch(url, request, env, cors) {
  if (env.BURST) {
    const { success } = await env.BURST.limit({ key: 'logo:' + (request.headers.get('CF-Connecting-IP') || '') });
    if (!success) return refuse('Too many searches at once. Wait a minute and try again.', 429, cors);
  }
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
  const out = [], seen = new Set();
  const add = (name, domain, desc) => {
    const d = bareHost(domain);
    if (d && DOMAIN_RE.test(d) && !seen.has(d)) { seen.add(d); out.push({ name: String(name).slice(0, 60), domain: d, desc: String(desc || '').slice(0, 90) }); }
  };
  if (!q) return json({ results: [] }, 200, cors);
  if (DOMAIN_RE.test(q.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))) add(q, q, '');
  try {
    const s = await (await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&limit=10&format=json`, { headers: WIKIDATA_UA })).json();
    const hits = (s.search || []).slice(0, 10);
    if (hits.length) {
      const e = await (await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${hits.map(h => h.id).join('|')}&props=claims&format=json`, { headers: WIKIDATA_UA })).json();
      for (const h of hits) {
        const site = e.entities && e.entities[h.id] && e.entities[h.id].claims && e.entities[h.id].claims.P856;
        const v = site && site[0] && site[0].mainsnak && site[0].mainsnak.datavalue && site[0].mainsnak.datavalue.value;
        if (v) add(h.label || q, v, h.description);
      }
    }
  } catch (e) { console.warn('wikidata search failed', e && e.message); }
  const slug = q.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (slug) for (const tld of ['.com', '.ng', '.com.ng', '.io']) add(q, slug + tld, '');
  return json({ results: out.slice(0, 12) }, 200, { ...cors, 'Cache-Control': 'public, max-age=86400' });
}
async function logoImg(url, cors) {
  const d = bareHost(String(url.searchParams.get('d') || ''));
  if (!DOMAIN_RE.test(d)) return new Response(null, { status: 400, headers: cors });
  const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`, { cf: { cacheTtl: 604800 } });
  // 404 means Google has no icon for the site (it sends a generic globe).
  if (!res.ok) return new Response(null, { status: 404, headers: { ...cors, 'Cache-Control': 'public, max-age=86400' } });
  return new Response(res.body, {
    status: 200,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'image/png', 'Cache-Control': 'public, max-age=604800', ...cors },
  });
}

// ── Firebase ID token check (RS256, Google's published keys) ───────────────
let jwks = null, jwksExp = 0;
async function googleKeys() {
  if (jwks && Date.now() < jwksExp) return jwks;
  const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const data = await res.json();
  const maxAge = Number((/max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '') || [])[1] || 3600);
  jwks = data.keys || []; jwksExp = Date.now() + maxAge * 1000;
  return jwks;
}
function b64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function verifyFirebaseToken(token) {
  try {
    const [h, p, sig] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
    if (header.alg !== 'RS256') return null;
    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== PROJECT_ID || claims.iss !== 'https://securetoken.google.com/' + PROJECT_ID) return null;
    if (!(claims.exp > now) || !(claims.iat <= now + 300) || !claims.sub) return null;
    const jwk = (await googleKeys()).find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(h + '.' + p));
    return ok ? claims.sub : null;
  } catch { return null; }
}

function refuse(message, status, cors) {
  return json({ error: { message } }, status, { ...cors, 'x-apowo-refusal': '1' });
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}
