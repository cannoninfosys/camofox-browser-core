// Test fixture: refuses input actions through tab:acting.
// click on an element whose text is "Refuse me" -> structured refusal (451); "Crash me" -> an ordinary listener error;
// press "F9" -> refused; type with submit -> refused; evaluate on a page titled "No scripts" -> refused.
export async function register(app, ctx) {
  const seen = [];

  ctx.events.on('tab:acting', async ({ userId, tabId, action, page, locator, ref, selector, key, submit, mode, hasEnter, hasSpace, fallback }) => {
    const entry = { userId, userIdType: typeof userId, tabId, action, hasPage: !!page, hasLocator: !!locator, ref, selector, key, submit, mode, hasEnter, hasSpace, fallback };
    seen.push(entry);
    if (action === 'click') {
      const text = (await locator.textContent({ timeout: 2000 }).catch(() => '')) || '';
      if (text.includes('Refuse me')) throw { statusCode: 451, code: 'action_refused', reason: 'Refused: this button is off limits', recovery: 'ask_user' };
      if (text.includes('Crash me')) throw new Error('guard listener crashed');
    }
    if (action === 'press' && key === 'F9') throw { statusCode: 451, code: 'action_refused', reason: 'Refused key' };
    if (action === 'type' && submit) throw { statusCode: 451, code: 'action_refused', reason: 'Refused submit' };
    if (action === 'evaluate' && (await page.title()) === 'No scripts') throw { statusCode: 403, code: 'scripts_off' };
  });

  app.get('/action-guard/seen', (req, res) => res.json(seen));
}
