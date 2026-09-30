import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { createClient } from '../helpers/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '../fixtures/action-plugins');

const PAGE = `<!doctype html><title>Buttons</title>
<button id="ok" onclick="document.title='clicked ok'">Fine</button>
<button id="no" onclick="document.title='clicked no'">Refuse me</button>
<button id="crash" onclick="document.title='clicked crash'">Crash me</button>
<form onsubmit="event.preventDefault(); document.title='submitted'"><input id="q" name="q"></form>`;

// tab:acting end to end: the fixture plugin action-guard refuses some clicks, keys, submits and scripts.
describe('tab:acting hook and action refusals', () => {
  let serverUrl;
  let siteUrl;
  let site;

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url.startsWith('/noscripts') ? '<!doctype html><title>No scripts</title><p>Quiet</p>' : PAGE);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${site.address().port}`;
    await startServer(0, {
      NODE_ENV: 'production',
      CAMOFOX_PLUGIN_PATH: FIXTURES,
      CAMOFOX_CONFIG: path.join(FIXTURES, 'camofox.config.json'),
    });
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
    await new Promise((resolve) => site.close(resolve));
  }, 30000);

  const seen = async () => (await fetch(`${serverUrl}/action-guard/seen`)).json();
  const post = async (p, body) => {
    const res = await fetch(`${serverUrl}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const title = async (client, tabId) => (await post(`/tabs/${tabId}/evaluate`, { userId: client.userId, expression: 'document.title' })).body.result;

  test('a click passes the hook with its locator; a refused click is not performed and answers the block', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/`);
      const ok = await post(`/tabs/${tabId}/click`, { userId: client.userId, selector: '#ok' });
      expect(ok.status).toBe(200);
      expect(await title(client, tabId)).toBe('clicked ok');
      for (let i = 0; i < 4; i++) {
        const res = await post(`/tabs/${tabId}/click`, { userId: client.userId, selector: '#no' });
        expect(res.status).toBe(451);
        expect(res.body).toMatchObject({
          error: 'Refused: this button is off limits',
          code: 'action_refused',
          recovery: 'ask_user',
          blocked: { code: 'action_refused', reason: 'Refused: this button is off limits' },
        });
      }
      expect(await title(client, tabId)).toBe('clicked ok');
      const events = (await seen()).filter((e) => e.userId === client.userId && e.action === 'click');
      expect(events[0]).toMatchObject({ tabId, hasPage: true, hasLocator: true, selector: '#ok', ref: null, fallback: null, userIdType: 'string' });
      // Same tab, still usable.
      expect((await post(`/tabs/${tabId}/click`, { userId: client.userId, selector: '#ok' })).status).toBe(200);
    } finally {
      await client.cleanup();
    }
  }, 90000);

  test('an ordinary listener error fails the click (fail closed)', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/`);
      const res = await post(`/tabs/${tabId}/click`, { userId: client.userId, selector: '#crash' });
      expect(res.status).toBe(500);
      expect(res.body.blocked).toBeUndefined();
      expect(await title(client, tabId)).toBe('Buttons');
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('press, type and evaluate pass the hook; refusals are answered without acting', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/`);
      expect((await post(`/tabs/${tabId}/press`, { userId: client.userId, key: 'Tab' })).status).toBe(200);
      const key = await post(`/tabs/${tabId}/press`, { userId: client.userId, key: 'F9' });
      expect(key.status).toBe(451);
      expect(key.body.code).toBe('action_refused');
      const typed = await post(`/tabs/${tabId}/type`, { userId: client.userId, selector: '#q', text: 'a b\n', mode: 'keyboard' });
      expect(typed.status).toBe(200);
      expect(await title(client, tabId)).toBe('submitted'); // the newline pressed Enter
      const submit = await post(`/tabs/${tabId}/type`, { userId: client.userId, selector: '#q', text: 'x', submit: true });
      expect(submit.status).toBe(451);
      const events = (await seen()).filter((e) => e.userId === client.userId);
      expect(events.find((e) => e.action === 'press')).toMatchObject({ key: 'Tab', hasPage: true });
      expect(events.find((e) => e.action === 'type' && e.mode === 'keyboard')).toMatchObject({ hasLocator: true, hasEnter: true, hasSpace: true, submit: false });
      expect(events.find((e) => e.action === 'type' && e.submit)).toMatchObject({ mode: 'fill', hasEnter: false });
      expect(JSON.stringify(events)).not.toContain('a b');
      expect(events.some((e) => e.action === 'evaluate')).toBe(true);
      await client.navigate(tabId, `${siteUrl}/noscripts`);
      const script = await post(`/tabs/${tabId}/evaluate`, { userId: client.userId, expression: '1 + 1' });
      expect(script.status).toBe(403);
      expect(script.body).toMatchObject({ code: 'scripts_off', error: 'Action refused' });
    } finally {
      await client.cleanup();
    }
  }, 90000);

  test('/act click, type and press go through the hook too', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/`);
      const refused = await post('/act', { kind: 'click', targetId: tabId, userId: client.userId, selector: '#no' });
      expect(refused.status).toBe(451);
      const ok = await post('/act', { kind: 'click', targetId: tabId, userId: client.userId, selector: '#ok' });
      expect(ok.status).toBe(200);
      expect((await post('/act', { kind: 'press', targetId: tabId, userId: client.userId, key: 'F9' })).status).toBe(451);
      expect((await post('/act', { kind: 'type', targetId: tabId, userId: client.userId, selector: '#q', text: 'y', submit: true })).status).toBe(451);
    } finally {
      await client.cleanup();
    }
  }, 60000);
});
