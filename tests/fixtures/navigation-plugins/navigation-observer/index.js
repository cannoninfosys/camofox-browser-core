// Test fixture: a later listener; it still runs when an earlier one refuses the navigation.
export async function register(app, ctx) {
  const seen = [];
  ctx.events.on('tab:navigating', ({ url }) => { seen.push(url); });
  app.get('/navigation-observer/seen', (req, res) => res.json(seen));
}
