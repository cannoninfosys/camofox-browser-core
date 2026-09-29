// Test fixture: refuses and blocks navigations through tab:navigating and ctx.fulfillBlockedNavigation.
// /refuse -> structured refusal (451); /crash -> an ordinary listener error; /hold -> answered by a route.
export async function register(app, ctx) {
  const seen = [];
  const routed = new WeakSet();

  ctx.events.on('tab:navigating', async ({ userId, tabId, url, source, page }) => {
    seen.push({ userId, userIdType: typeof userId, tabId, url, source, hasPage: !!page });
    const { pathname } = new URL(url);
    if (pathname === '/refuse') {
      // The reason deliberately contains words the core's error classifiers look for.
      throw { statusCode: 451, code: 'url_refused', reason: 'Refused: Timeout 5000ms exceeded, element is not visible', recovery: 'ask_user' };
    }
    if (pathname === '/crash') throw new Error('guard listener crashed');
    const context = page.context();
    if (!routed.has(context)) {
      routed.add(context);
      await context.route('**/hold*', async (route) => {
        if (!route.request().isNavigationRequest()) return route.fallback();
        await ctx.fulfillBlockedNavigation(route, {
          status: 423,
          code: 'url_on_hold',
          reason: 'This site is on hold',
          recovery: 'wait_and_retry',
          body: '<!doctype html><title>On hold</title><h1>This site is on hold</h1>',
        });
      });
    }
  });

  app.get('/navigation-guard/seen', (req, res) => res.json(seen));
}
