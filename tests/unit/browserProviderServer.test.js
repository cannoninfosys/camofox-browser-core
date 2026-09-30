import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { createClient } from '../helpers/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const FIXTURES = path.join(__dirname, '../fixtures/browser-provider-plugins');
const ADMIN_KEY = 'browser-provider-test-admin-key';

// The fixture provider launches Playwright's own Chromium build; without it these tests cannot run.
let chromiumInstalled = false;
try { chromiumInstalled = fs.existsSync(chromium.executablePath()); } catch { /* not installed */ }
const describeWithChromium = chromiumInstalled ? describe : describe.skip;

const fixtureEnv = (extra = {}) => ({
  CAMOFOX_PLUGIN_PATH: FIXTURES,
  CAMOFOX_CONFIG: path.join(FIXTURES, 'camofox.config.json'),
  CAMOFOX_ADMIN_KEY: ADMIN_KEY,
  ...extra,
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describeWithChromium('browser providers: CAMOFOX_BROWSER selects a plugin browser', () => {
  let serverUrl;
  let site;
  let siteUrl;

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>provider</title><h1>Provider page ${req.url}</h1>`);
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${site.address().port}`;
    await startServer(0, fixtureEnv({ CAMOFOX_BROWSER: 'fixture-chromium' }));
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
    await new Promise((resolve) => site.close(resolve));
  }, 30000);

  const seen = async () => (await fetch(`${serverUrl}/browser-fixture/seen`)).json();

  test('the default browser is pre-warmed and reported by /health; Camoufox is never started', async () => {
    const health = await (await fetch(`${serverUrl}/health`)).json();
    expect(health.ok).toBe(true);
    expect(health.browserRunning).toBe(true);
    expect(health.browsers).toEqual({ camoufox: false, 'fixture-chromium': true });
    const { events } = await seen();
    expect(events.filter((e) => e.event === 'browser:launching').map((e) => e.provider)).toEqual(['fixture-chromium']);
    expect(events.find((e) => e.event === 'browser:launched')?.provider).toBe('fixture-chromium');
  });

  test('sessions run on the default browser and their events name it', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${siteUrl}/one`);
      await client.navigate(tabId, `${siteUrl}/two`);
      const ua = await client.request('POST', `/tabs/${tabId}/evaluate`, { userId: client.userId, expression: 'navigator.userAgent' });
      expect(ua.result).toMatch(/Chrome\//);
      expect(ua.result).not.toMatch(/Firefox\//);
      const { events } = await seen();
      expect(events.filter((e) => e.event.startsWith('session:')).map((e) => e.provider)).toEqual(
        expect.arrayContaining(['fixture-chromium']),
      );
      expect(events.some((e) => e.provider === 'camoufox')).toBe(false);
      const health = await (await fetch(`${serverUrl}/health`)).json();
      expect(health.browsers.camoufox).toBe(false);
    } finally {
      await client.cleanup();
    }
  });

  test('POST /stop closes the provider browser through its close(), within a budget', async () => {
    const res = await fetch(`${serverUrl}/stop`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.status).toBe(200);
    const { closes, events, displayPids } = await seen();
    expect(closes).toEqual([{ reason: 'admin_stop', timeoutMs: expect.any(Number) }]);
    expect(events.at(-1)).toMatchObject({ event: 'browser:closed', provider: 'fixture-chromium', reason: 'admin_stop' });
    const health = await (await fetch(`${serverUrl}/health`)).json();
    expect(health.status ?? 200).toBe(200);
    expect(health.browsers['fixture-chromium']).toBe(false);
    // The provider killed its own display.
    await new Promise((r) => setTimeout(r, 500));
    for (const pid of displayPids) expect(alive(pid)).toBe(false);
  });

  test('/start launches the default browser again', async () => {
    const res = await fetch(`${serverUrl}/start`, { method: 'POST' });
    expect(res.status).toBe(200);
    const health = await (await fetch(`${serverUrl}/health`)).json();
    expect(health.browsers).toEqual({ camoufox: false, 'fixture-chromium': true });
  });
});

describe('browser providers: startup', () => {
  test('an unknown CAMOFOX_BROWSER stops the server with exit code 78', async () => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CAMOFOX_PORT: String(3100 + Math.floor(Math.random() * 900)),
        ...fixtureEnv({ CAMOFOX_BROWSER: 'no-such-browser' }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    expect(code).toBe(78);
    expect(output).toMatch(/unknown browser: no-such-browser/);
  }, 60000);
});
