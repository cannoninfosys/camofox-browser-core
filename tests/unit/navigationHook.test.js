import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { createClient } from '../helpers/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '../fixtures/navigation-plugins');

// tab:navigating and plugin navigation blocks, end to end: two fixture plugins loaded from
// CAMOFOX_PLUGIN_PATH (navigation-guard refuses /refuse, throws on /crash, answers /hold from a route).
describe('tab:navigating hook and navigation blocks', () => {
  let serverUrl;
  let siteUrl;
  let site;
  const hits = [];

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      hits.push(req.url);
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      // A site pretending to be a plugin block: must be treated as an ordinary page.
      if (req.url.startsWith('/forged')) headers['x-camofox-blocked'] = 'url_on_hold';
      res.writeHead(200, headers);
      res.end(`<!doctype html><title>${req.url}</title><h1>Page ${req.url}</h1>`);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${site.address().port}`;
    await startServer(0, {
      CAMOFOX_PLUGIN_PATH: FIXTURES,
      CAMOFOX_CONFIG: path.join(FIXTURES, 'camofox.config.json'),
    });
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
    await new Promise((resolve) => site.close(resolve));
  }, 30000);

  const seen = async (name) => (await fetch(`${serverUrl}/${name}/seen`)).json();
  const post = async (p, body) => {
    const res = await fetch(`${serverUrl}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  test('every API navigation route emits the hook with a normalized userId, tabId, url and page', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/one`);
      await client.navigate(tabId, `${siteUrl}/two`);
      const opened = await post('/tabs/open', { userId: client.userId, url: `${siteUrl}/three` });
      expect(opened.status).toBe(200);
      const nav = await post('/navigate', { userId: client.userId, targetId: opened.body.tabId, url: `${siteUrl}/four` });
      expect(nav.status).toBe(200);
      const events = (await seen('navigation-guard')).filter((e) => e.userId === client.userId);
      expect(events.map((e) => new URL(e.url).pathname)).toEqual(['/one', '/two', '/three', '/four']);
      for (const e of events) {
        expect(e).toMatchObject({ source: 'api', hasPage: true, userIdType: 'string' });
        expect(e.tabId).toBeTruthy();
      }
      expect(events[0].tabId).toBe(tabId);
      expect(events[1].tabId).toBe(tabId);
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('a numeric userId reaches the hook as a string', async () => {
    const userId = 4242000 + Math.floor(Math.random() * 1000);
    const res = await post('/tabs', { userId, sessionKey: 'numeric', url: `${siteUrl}/numeric` });
    expect(res.status).toBe(200);
    const events = (await seen('navigation-guard')).filter((e) => e.url.endsWith('/numeric'));
    expect(events.at(-1)).toMatchObject({ userId: String(userId), userIdType: 'string' });
    await fetch(`${serverUrl}/sessions/${userId}`, { method: 'DELETE' });
  }, 60000);

  test('a refusal answers with the plugin status, code and recovery; nothing is navigated or counted', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/start`);
      const before = hits.length;
      // More refusals than the consecutive-failure threshold: the session must survive them.
      for (let i = 0; i < 4; i++) {
        const res = await post(`/tabs/${tabId}/navigate`, { userId: client.userId, url: `${siteUrl}/refuse` });
        expect(res.status).toBe(451);
        expect(res.body).toMatchObject({
          code: 'url_refused',
          recovery: 'ask_user',
          retryable: true,
          blocked: { code: 'url_refused', reason: 'Refused: Timeout 5000ms exceeded, element is not visible' },
        });
        expect(res.body.error).toBe('Refused: Timeout 5000ms exceeded, element is not visible');
      }
      expect(hits.slice(before).filter((u) => u === '/refuse')).toEqual([]);
      // The later plugin's listener still ran for the refused navigations.
      expect((await seen('navigation-observer')).filter((u) => u.endsWith('/refuse')).length).toBeGreaterThanOrEqual(4);
      // Same tab, same session, still usable.
      const ok = await client.navigate(tabId, `${siteUrl}/after`);
      expect(ok.ok).toBe(true);
    } finally {
      await client.cleanup();
    }
  }, 90000);

  test('a refused POST /tabs and /tabs/open leave no blank tab behind', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/keep`);
      const created = await post('/tabs', { userId: client.userId, sessionKey: client.sessionKey, url: `${siteUrl}/refuse` });
      expect(created.status).toBe(451);
      expect(created.body.code).toBe('url_refused');
      const opened = await post('/tabs/open', { userId: client.userId, url: `${siteUrl}/refuse` });
      expect(opened.status).toBe(451);
      const list = await (await fetch(`${serverUrl}/tabs?userId=${encodeURIComponent(client.userId)}`)).json();
      const ids = (list.tabs || []).map((t) => t.tabId || t.targetId);
      expect(ids).toEqual([tabId]);
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('a route answered with fulfillBlockedNavigation shows its page and answers the block', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/start`);
      for (let i = 0; i < 4; i++) {
        const res = await post(`/tabs/${tabId}/navigate`, { userId: client.userId, url: `${siteUrl}/hold` });
        expect(res.status).toBe(423);
        expect(res.body).toMatchObject({
          error: 'This site is on hold',
          code: 'url_on_hold',
          recovery: 'wait_and_retry',
          retryable: true,
          blocked: { code: 'url_on_hold', reason: 'This site is on hold' },
        });
      }
      expect(hits.filter((u) => u === '/hold')).toEqual([]);
      const snap = await client.getSnapshot(tabId);
      expect(snap.snapshot).toContain('This site is on hold');
      // A new tab straight onto the held URL: 423, and the tab stays (it shows the page).
      const created = await post('/tabs', { userId: client.userId, sessionKey: client.sessionKey, url: `${siteUrl}/hold` });
      expect(created.status).toBe(423);
      const ok = await client.navigate(tabId, `${siteUrl}/after-hold`);
      expect(ok.ok).toBe(true);
    } finally {
      await client.cleanup();
    }
  }, 90000);

  test('a site sending the block header itself is an ordinary page', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/start`);
      const res = await client.navigate(tabId, `${siteUrl}/forged`);
      expect(res.ok).toBe(true);
      expect(res.blocked).toBeUndefined();
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('an ordinary listener error fails the navigation (fail closed)', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/start`);
      const res = await post(`/tabs/${tabId}/navigate`, { userId: client.userId, url: `${siteUrl}/crash` });
      expect(res.status).toBe(500);
      expect(res.body.blocked).toBeUndefined();
      expect(hits).not.toContain('/crash');
    } finally {
      await client.cleanup();
    }
  }, 60000);
});
