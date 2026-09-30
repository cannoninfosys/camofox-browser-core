// Test fixture: a browser provider named "fixture-chromium" (the core's Playwright Chromium, headless, plus a
// virtual display it owns), recording lifecycle events and close calls at GET /browser-fixture/seen.
export async function register(app, ctx) {
  const seen = { events: [], closes: [], displayPids: [] };
  const displays = new WeakMap();
  for (const event of ['browser:launching', 'browser:launched', 'browser:closed', 'session:creating', 'session:created']) {
    ctx.events.on(event, (payload) => { seen.events.push({ event, provider: payload.provider, reason: payload.reason }); });
  }
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
}
