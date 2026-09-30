// Test fixture: a browser provider named "fixture-chromium" (the core's Playwright Chromium, headless, plus a
// virtual display it owns), recording lifecycle events and close calls at GET /browser-fixture/seen.
// Per session: POST /browser-fixture/route { userId, browser } makes session:resolving send that user to
// `browser`. FIXTURE_WARM_BROWSER (env) is the browser:warming answer.
import express from 'express';

export async function register(app, ctx) {
  const seen = { events: [], closes: [], displayPids: [] };
  const routes = new Map();
  const displays = new WeakMap();
  for (const event of ['browser:launching', 'browser:launched', 'browser:closed', 'session:creating', 'session:created']) {
    ctx.events.on(event, (payload) => { seen.events.push({ event, provider: payload.provider, reason: payload.reason }); });
  }
  ctx.events.on('session:resolving', (req) => {
    if (routes.has(req.userId)) req.browser = routes.get(req.userId);
  });
  ctx.events.on('browser:warming', (warming) => {
    seen.events.push({ event: 'browser:warming', reason: warming.reason });
    if (process.env.FIXTURE_WARM_BROWSER) warming.browser = process.env.FIXTURE_WARM_BROWSER;
  });
  ctx.registerBrowserProvider({
    name: 'fixture-chromium',
    async launch(env) {
      const display = process.platform === 'linux' ? env.createVirtualDisplay() : null;
      if (display) await display.get();
      if (display?.proc?.pid) seen.displayPids.push(display.proc.pid);
      const browser = await env.playwright.chromium.launch({ headless: true });
      displays.set(browser, display);
      return { browser, display: display ? `:${display.display}` : undefined };
    },
    async close(browser, info) {
      seen.closes.push({ reason: info.reason, timeoutMs: info.timeoutMs });
      await browser.close();
      displays.get(browser)?.kill();
    },
  });
  app.get('/browser-fixture/seen', (req, res) => res.json(seen));
  app.post('/browser-fixture/route', express.json(), (req, res) => {
    routes.set(String(req.body.userId), req.body.browser);
    res.json({ ok: true });
  });
}
