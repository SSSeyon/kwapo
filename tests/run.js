// apowo money tests. Pulls the real functions out of ../app.js by name and runs
// them against small fakes, so the tests can't drift from the shipped code.
// Add a case: write t('what it checks', () => { ... eq(actual, expected) ... }).
(async function () {
  const src = await (await fetch('../app.js?t=' + Date.now(), { cache: 'no-store' })).text();

  // Source of `function name(...) {...}` (or async), found by brace matching.
  function fnSrc(name) {
    const re = new RegExp('(^|\\n)(async\\s+)?function\\s+' + name.replace(/\$/g, '\\$') + '\\s*\\(');
    const m = re.exec(src);
    if (!m) throw new Error('function not found in app.js: ' + name);
    const start = m.index + m[1].length;
    let i = src.indexOf('{', src.indexOf(')', start)), depth = 0, q = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('unbalanced braces in ' + name);
  }
  // Builds the named functions inside one scope with the given globals.
  function load(names, env) {
    const keys = Object.keys(env);
    const body = names.map(fnSrc).join('\n') + '\nreturn {' + names.join(',') + '};';
    return new Function(...keys, body)(...keys.map(k => env[k]));
  }

  const results = [];
  async function t(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e && e.message || String(e) }); }
  }
  function eq(a, b, msg) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error((msg ? msg + ': ' : '') + 'expected ' + B + ', got ' + A);
  }
  const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Error((msg ? msg + ': ' : '') + `expected ${b} ±${tol}, got ${a}`); };

  const toLocalISO = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  // ── Amount fields ───────────────────────────────────────────────────────
  const A = load(['_arith', '_evalExpr'], {});
  await t('plain numbers pass through', () => { eq(A._evalExpr('1500'), '1500'); eq(A._evalExpr(''), ''); });
  await t('commas and currency signs are ignored', () => { eq(A._evalExpr('₦1,250,000'), '1250000'); eq(A._evalExpr('$12.50'), '12.50'); });
  await t('k and m shorthands', () => { eq(A._evalExpr('5k'), '5000'); eq(A._evalExpr('2.5m'), '2500000'); eq(A._evalExpr('1.5k+500'), '2000'); });
  await t('sums follow operator precedence', () => { eq(A._evalExpr('2+3*4'), '14'); eq(A._evalExpr('(2+3)*4'), '20'); eq(A._evalExpr('10/4'), '2.5'); eq(A._evalExpr('-5+10'), '5'); });
  await t('results round to kobo', () => { eq(A._evalExpr('10/3'), '3.33'); eq(A._evalExpr('0.1+0.2'), '0.3'); });
  await t('malformed input is left as typed, never evaluated', () => {
    eq(A._evalExpr('5*'), '5*'); eq(A._evalExpr('(2'), '(2'); eq(A._evalExpr('1.2.3'), '1.2.3'); eq(A._evalExpr('alert(1)'), 'alert(1)');
  });
  await t('division by zero does not produce a number', () => { eq(A._evalExpr('5/0'), '5/0'); });

  // ── Repeating bills ─────────────────────────────────────────────────────
  let today = '2026-11-10';
  const R = load(['_parseYmd', 'nextRunDate', 'isDueThisMonth', '_recurMonthly'], {
    toLocalISO, todayStr: () => today,
  });
  await t('monthly bills keep their day, clamped to short months', () => {
    eq(R.nextRunDate('monthly', '2026-01-31', 31), '2026-02-28');
    eq(R.nextRunDate('monthly', '2026-02-28', 31), '2026-03-31');
    eq(R.nextRunDate('monthly', '2028-01-31', 31), '2028-02-29');
  });
  await t('weekly, quarterly and yearly steps, across year ends', () => {
    eq(R.nextRunDate('weekly', '2026-12-29', 29), '2027-01-05');
    eq(R.nextRunDate('quarterly', '2026-11-15', 15), '2027-02-15');
    eq(R.nextRunDate('annually', '2026-03-01', 1), '2027-03-01');
  });
  await t('due this month includes overdue, excludes next month', () => {
    eq(R.isDueThisMonth('2026-10-01'), true); eq(R.isDueThisMonth('2026-11-30'), true);
    eq(R.isDueThisMonth('2026-12-01'), false); eq(R.isDueThisMonth(''), false);
  });
  await t('monthly equivalents of repeating amounts', () => {
    eq(R._recurMonthly({ amount: 1200, frequency: 'annually' }), 100);
    eq(R._recurMonthly({ amount: 300, frequency: 'quarterly' }), 100);
    near(R._recurMonthly({ amount: 100, frequency: 'weekly' }), 433.33, 0.01);
  });

  // ── Interest ────────────────────────────────────────────────────────────
  const days = (m, y) => new Date(y, m, 0).getDate();
  const I = load(['_interestRange'], {
    _ymd: ymd,
    _dayBalances: (key, m, y) => new Array(days(m, y)).fill(1000000),   // a steady ₦1m
  });
  await t('simple daily interest on a steady balance', () => {
    near(I._interestRange('cash:X', 18.25, 'daily', '2026-01-01', '2026-01-11'), 1000000 * 0.1825 / 365 * 10, 0.001);
  });
  await t('interest spans month ends and stops before the end date', () => {
    near(I._interestRange('cash:X', 36.5, 'daily', '2026-01-30', '2026-02-02'), 1000000 * 0.365 / 365 * 3, 0.001);
  });
  await t('daily compounding earns slightly more than simple', () => {
    const s = I._interestRange('cash:X', 20, 'daily', '2026-01-01', '2026-07-01');
    const c = I._interestRange('cash:X', 20, 'daily_compound', '2026-01-01', '2026-07-01');
    if (!(c > s)) throw new Error(`compound ${c} should exceed simple ${s}`);
  });
  await t('no interest for zero rate, empty or reversed ranges', () => {
    eq(I._interestRange('cash:X', 0, 'daily', '2026-01-01', '2026-02-01'), 0);
    eq(I._interestRange('cash:X', 10, 'daily', '2026-02-01', '2026-01-01'), 0);
    eq(I._interestRange('cash:X', 10, 'daily', '', '2026-01-01'), 0);
  });

  // ── Balance corrections carry into later months ─────────────────────────
  // A fake Firestore holding month docs, with field increments.
  function fakeDb(docs) {
    const INC = Symbol('inc');
    const ref = id => ({
      id,
      async get() { return { exists: id in docs, data: () => ({ ...docs[id] }) }; },
      async set(data, opts) {
        const cur = opts && opts.merge ? { ...(docs[id] || {}) } : {};
        for (const k in data) cur[k] = data[k] && data[k][INC] != null ? (cur[k] || 0) + data[k][INC] : data[k];
        docs[id] = cur;
      },
    });
    return {
      docs, FV: { increment: n => ({ [INC]: n }) },
      db: { collection: () => ({ doc: ref, where: (f, op, v) => ({ async get() {
        const ids = Object.keys(docs).filter(id => id > v).sort();
        return { empty: !ids.length, docs: ids.map(ref).map(r => ({ id: r.id, ref: r })) };
      } }) }) },
    };
  }
  function balanceEnv(docs, cache) {
    const f = fakeDb(docs);
    const store = { ...cache };
    const S = { cashMonth: 11, cashYear: 2026, dashMonth: 11, dashYear: 2026, cash: {} };
    const env = {
      db: f.db, FV: f.FV, S, firebase: { firestore: { FieldPath: { documentId: () => '__id__' } } },
      sid: (m, y) => `${y}-${String(m).padStart(2, '0')}`,
      CK: { cash: (m, y) => `cash_${y}_${m}` },
      cGet: k => store[k] ? JSON.parse(JSON.stringify(store[k])) : null, cSet: (k, v) => { store[k] = v; },
      _dbReady: () => true, _markCashDirty() {}, _clearCashDirty() {}, _rippleQueueAdd() {},
      renderCashPage() {}, renderDashboard() {}, runBalanceAudit() {}, toast() {}, confirm: () => true,
    };
    return { env, docs, store, S };
  }
  await t('audit fix carries the correction into every later month', async () => {
    const { env, docs } = balanceEnv({
      '2026-09': { GTB: 100000 }, '2026-10': { GTB: 50000, Kuda: 7000 },
      '2026-11': { GTB: 80000, Kuda: 9000 }, '2026-12': { GTB: 90000 },
    }, {});
    const B = load(['_rippleCashForward', 'auditFix'], env);
    await B.auditFix('GTB', 60000, 10, 2026);      // October was 10,000 short
    eq(docs['2026-10'].GTB, 60000, 'October');
    eq(docs['2026-11'].GTB, 90000, 'November moves by the same 10,000');
    eq(docs['2026-12'].GTB, 100000, 'December too');
    eq(docs['2026-09'].GTB, 100000, 'earlier months untouched');
    eq(docs['2026-11'].Kuda, 9000, 'other accounts untouched');
  });
  await t('audit fix measures the change against the server, not a stale cache', async () => {
    const { env, docs } = balanceEnv(
      { '2026-10': { GTB: 50000 }, '2026-11': { GTB: 80000 } },
      { cash_2026_10: { GTB: 20000, Kuda: 1 } });   // cached copy out of date
    const B = load(['_rippleCashForward', 'auditFix'], env);
    await B.auditFix('GTB', 60000, 10, 2026);
    eq(docs['2026-11'].GTB, 90000, 'carried +10,000 (not +40,000)');
    eq('Kuda' in docs['2026-10'], false, 'stale cached fields are not written back');
  });

  // ── Report ──────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok).length;
  const sum = document.getElementById('sum');
  sum.textContent = failed ? `${failed} of ${results.length} failed` : `All ${results.length} passed`;
  sum.className = failed ? 'fail' : 'pass';
  document.getElementById('out').innerHTML = results.map(r =>
    `<li class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name.replace(/</g, '&lt;')}</li>` +
    (r.ok ? '' : `<pre>${r.err.replace(/</g, '&lt;')}</pre>`)).join('');
  window.__testResults = { passed: results.length - failed, failed, results };
})().catch(e => {
  document.getElementById('sum').textContent = 'Test harness error: ' + e.message;
  document.getElementById('sum').className = 'fail';
  window.__testResults = { error: e.message };
});
