// apowo boot (v4.9). Runs first thing in <body>, before the deferred scripts.
// Kept tiny and dependency-free.
(function () {
  // 1. Refuse to run inside another site's frame (clickjacking). GitHub Pages
  //    can't send X-Frame-Options/frame-ancestors, so this is the fallback.
  try {
    if (window.top !== window.self) {
      let foreign = false;
      try { foreign = window.top.location.origin !== location.origin; } catch (e) { foreign = true; }
      if (foreign) {
        document.documentElement.style.display = 'none';
        try { window.top.location = location.href; } catch (e) {}
        return;
      }
    }
  } catch (e) {}

  // 2. Apply the saved light/dark theme before anything paints, so the
  //    deferred app scripts can't cause a flash of the wrong theme.
  try {
    const t = localStorage.getItem('sw3_theme');
    const light = t ? t === 'light' : !!(window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
    if (light) document.body.classList.add('light');
  } catch (e) {}

  // 3. Crash reports. Uncaught errors and rejected promises are sent (at most
  //    5 per session, no duplicates) to the apowo API, which logs them for the
  //    owner. Only the error text, file/line and app version are sent: no
  //    financial data, no account details.
  const ENDPOINT = 'https://api.apowo.app/report';
  const sent = new Set();
  function report(msg, src, stack) {
    try {
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
      msg = String(msg || '').slice(0, 500);
      const sig = msg + '|' + src;
      if (!msg || sent.has(sig) || sent.size >= 5) return;
      sent.add(sig);
      const body = JSON.stringify({
        v: typeof APP_VERSION === 'string' ? APP_VERSION : '',
        mode: typeof DATA_MODE === 'string' ? DATA_MODE : '',
        msg, src: String(src || '').replace(location.origin, '').slice(0, 200),
        stack: String(stack || '').split(location.origin).join('').slice(0, 2000),
      });
      // text/plain keeps this a "simple" request: no CORS preflight needed.
      const blob = new Blob([body], { type: 'text/plain' });
      if (!(navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob))) {
        fetch(ENDPOINT, { method: 'POST', body: blob, mode: 'no-cors', keepalive: true }).catch(function () {});
      }
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    if (!e || !e.message) return;   // resource load errors (images etc.) carry no message
    if (/^Script error\.?$/.test(e.message)) return;   // opaque cross-origin errors: nothing useful
    report(e.message, (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0), e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    const r = e && e.reason;
    report('Unhandled: ' + (r && r.message ? r.message : String(r)), '', r && r.stack);
  });
  window.apowoReport = report;
})();
