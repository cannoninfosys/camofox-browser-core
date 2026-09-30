import {
  BUILTIN_BROWSER,
  createBrowserProviderRegistry,
  createProviderBrowsers,
  normalizeLaunchResult,
} from '../../lib/browser-providers.js';

const tick = () => new Promise((r) => setImmediate(r));

function fakeBrowser() {
  let connected = true;
  return {
    closed: 0,
    isConnected: () => connected,
    disconnect() { connected = false; },
    async close() { this.closed++; connected = false; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup({ provider, deps = {} } = {}) {
  const registry = createBrowserProviderRegistry();
  const events = [];
  registry.register('test-plugin', provider);
  const manager = createProviderBrowsers({
    registry,
    emit: (event, payload) => events.push({ event, ...payload }),
    emitAsync: async (event, payload) => { events.push({ event, ...payload }); },
    ...deps,
  });
  return { registry, manager, events };
}

describe('browser provider registry', () => {
  test('registers valid providers and lists the built-in first', () => {
    const registry = createBrowserProviderRegistry();
    registry.register('p', { name: 'other', launch: async () => fakeBrowser() });
    expect(registry.names()).toEqual([BUILTIN_BROWSER, 'other']);
    expect(registry.has('camoufox')).toBe(true);
    expect(registry.has('other')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(registry.get('other').pluginName).toBe('p');
  });

  test('rejects invalid names, the reserved name, missing launch and a bad close', () => {
    const registry = createBrowserProviderRegistry();
    expect(() => registry.register('p', null)).toThrow(/must be an object/);
    expect(() => registry.register('p', { name: 'Bad Name', launch() {} })).toThrow(/invalid browser provider name/);
    expect(() => registry.register('p', { name: 'camoufox', launch() {} })).toThrow(/reserved/);
    expect(() => registry.register('p', { name: 'x' })).toThrow(/launch\(\)/);
    expect(() => registry.register('p', { name: 'x', launch() {}, close: 1 })).toThrow(/close must be a function/);
  });

  test('a second registration of a name is a conflict naming the first plugin', () => {
    const registry = createBrowserProviderRegistry();
    registry.register('first', { name: 'x', launch() {} });
    let err;
    try { registry.register('second', { name: 'x', launch() {} }); } catch (e) { err = e; }
    expect(err.code).toBe('browser_provider_conflict');
    expect(err.message).toMatch(/first/);
  });

  test('normalizeLaunchResult accepts a Browser or a descriptor', () => {
    const b = fakeBrowser();
    expect(normalizeLaunchResult(b)).toMatchObject({ browser: b, pid: null });
    const d = normalizeLaunchResult({ browser: b, pid: 42, display: ':5', ownedPids: () => [7] });
    expect(d).toMatchObject({ browser: b, pid: 42, display: ':5' });
    expect(d.ownedPids()).toEqual([7]);
    expect(normalizeLaunchResult({ browser: b, pid: 'x' }).pid).toBeNull();
  });
});

describe('provider browsers lifecycle', () => {
  test('launches once for concurrent callers, with events naming the provider', async () => {
    let launches = 0;
    const { manager, events } = setup({
      provider: { name: 'x', launch: async (env) => { launches++; env.options.seen = true; return { browser: fakeBrowser(), pid: 11, display: ':9' }; } },
    });
    const [a, b] = await Promise.all([manager.ensure('x'), manager.ensure('x')]);
    expect(a).toBe(b);
    expect(launches).toBe(1);
    expect(manager.isRunning('x')).toBe(true);
    expect(manager.pid('x')).toBe(11);
    expect(events.map((e) => [e.event, e.provider])).toEqual([['browser:launching', 'x'], ['browser:launched', 'x']]);
    expect(events[1].display).toBe(':9');
  });

  test('the launch env carries the launching options, the shared env and an owned createVirtualDisplay', async () => {
    let env;
    const display = { proc: { pid: 99 } };
    const { manager } = setup({
      provider: { name: 'x', launch: async (e) => { env = e; e.createVirtualDisplay(); return fakeBrowser(); } },
      deps: { launchEnv: () => ({ interactiveMode: 'off', playwright: { chromium: 'c' } }), createVirtualDisplay: () => display },
    });
    await manager.ensure('x');
    expect(env.interactiveMode).toBe('off');
    expect(env.playwright.chromium).toBe('c');
    expect(env.options).toEqual({});
    expect(manager.ownedPids().has(99)).toBe(true);
  });

  test('a display created during a launch in flight is already owned', async () => {
    const gate = deferred();
    const { manager } = setup({
      provider: { name: 'x', launch: async (e) => { e.createVirtualDisplay(); await gate.promise; return fakeBrowser(); } },
      deps: { createVirtualDisplay: () => ({ proc: { pid: 1234 } }) },
    });
    const p = manager.ensure('x');
    await tick(); await tick();
    expect(manager.ownedPids().has(1234)).toBe(true);
    gate.resolve();
    await p;
  });

  test('close calls the provider close with reason, pid and a time budget, then emits browser:closed', async () => {
    const calls = [];
    const browser = fakeBrowser();
    const { manager, events } = setup({
      provider: { name: 'x', launch: async () => ({ browser, pid: 5, ownedPids: () => [6] }), close: async (b, info) => { calls.push(info); await b.close(); } },
    });
    await manager.ensure('x');
    expect(manager.ownedPids()).toEqual(new Set([5, 6]));
    await manager.close('x', 'admin_stop', { timeoutMs: 4000 });
    expect(calls).toEqual([{ reason: 'admin_stop', pid: 5, timeoutMs: expect.any(Number) }]);
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(4000);
    expect(browser.closed).toBe(1);
    expect(manager.isRunning('x')).toBe(false);
    expect(manager.lastStopReason('x')).toBe('admin_stop');
    expect(manager.ownedPids().size).toBe(0);
    expect(events.at(-1)).toMatchObject({ event: 'browser:closed', provider: 'x', reason: 'admin_stop' });
  });

  test('without a provider close, the browser is closed directly', async () => {
    const browser = fakeBrowser();
    const { manager } = setup({ provider: { name: 'x', launch: async () => browser } });
    await manager.ensure('x');
    await manager.close('x', 'idle_shutdown');
    expect(browser.closed).toBe(1);
  });

  test('a close during a launch waits for it and closes what it produced', async () => {
    const gate = deferred();
    const browser = fakeBrowser();
    const closes = [];
    const { manager } = setup({
      provider: { name: 'x', launch: async () => { await gate.promise; return browser; }, close: async (b, info) => { closes.push(info.reason); await b.close(); } },
    });
    const launching = manager.ensure('x');
    await tick();
    const closing = manager.close('x', 'shutdown:SIGTERM', { timeoutMs: 2000 });
    gate.resolve();
    await expect(launching).rejects.toMatchObject({ code: 'browser_closed' });
    await closing;
    expect(closes).toEqual(['shutdown:SIGTERM']);
    expect(browser.closed).toBe(1);
    expect(manager.isRunning('x')).toBe(false);
  });

  test('a launch that finishes after its timeout is closed, not leaked', async () => {
    const gate = deferred();
    const browser = fakeBrowser();
    const { manager } = setup({
      provider: { name: 'x', launch: async () => { await gate.promise; return browser; } },
      deps: { launchTimeoutMs: 20 },
    });
    await expect(manager.ensure('x')).rejects.toThrow(/launch timeout/);
    gate.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(browser.closed).toBe(1);
    expect(manager.isRunning('x')).toBe(false);
  });

  test('no launch once shutdown began', async () => {
    const { manager } = setup({
      provider: { name: 'x', launch: async () => fakeBrowser() },
      deps: { isShuttingDown: () => true },
    });
    await expect(manager.ensure('x')).rejects.toMatchObject({ statusCode: 503, code: 'server_shutting_down' });
  });

  test('a disconnected browser clears its sessions, is closed and relaunched', async () => {
    const browsers = [fakeBrowser(), fakeBrowser()];
    let n = 0;
    const cleared = [];
    const { manager } = setup({
      provider: { name: 'x', launch: async () => browsers[n++] },
      deps: { onDisconnected: async (name) => { cleared.push(name); } },
    });
    await manager.ensure('x');
    browsers[0].disconnect();
    expect(await manager.ensure('x')).toBe(browsers[1]);
    expect(cleared).toEqual(['x']);
    expect(manager.lastStopReason('x')).toBeNull();
  });

  test('closeAll closes every browser in parallel within the budget', async () => {
    const registry = createBrowserProviderRegistry();
    const started = [];
    const slow = (name) => ({
      name,
      launch: async () => fakeBrowser(),
      close: async (b) => { started.push(name); await new Promise((r) => setTimeout(r, 50)); await b.close(); },
    });
    registry.register('p', slow('a'));
    registry.register('p', slow('b'));
    const manager = createProviderBrowsers({ registry });
    await manager.ensure('a');
    await manager.ensure('b');
    const t0 = Date.now();
    await manager.closeAll('shutdown', { timeoutMs: 1000 });
    expect(started.sort()).toEqual(['a', 'b']);
    expect(Date.now() - t0).toBeLessThan(95);
    expect(manager.running()).toEqual([]);
  });

  test('a close that overruns its budget is abandoned but its pids stay owned until it ends', async () => {
    const gate = deferred();
    const { manager } = setup({
      provider: { name: 'x', launch: async () => ({ browser: fakeBrowser(), pid: 77, ownedPids: () => [78] }), close: async () => { await gate.promise; } },
    });
    await manager.ensure('x');
    await manager.close('x', 'shutdown', { timeoutMs: 1000 }); // the budget floor is 1 s
    expect(manager.ownedPids().has(78)).toBe(true);
    gate.resolve();
    await tick(); await tick();
    expect(manager.ownedPids().has(78)).toBe(false);
  }, 10000);

  test('each browser idles out on its own when it has no sessions', async () => {
    const timers = [];
    const sessions = { x: 1 };
    const browser = fakeBrowser();
    const { manager } = setup({
      provider: { name: 'x', launch: async () => browser },
      deps: {
        idleTimeoutMs: 1000,
        sessionsOn: (name) => sessions[name] || 0,
        setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} }; },
        clearTimeoutFn: () => {},
      },
    });
    await manager.ensure('x');
    manager.scheduleIdle();
    expect(timers).toHaveLength(0); // still has a session
    sessions.x = 0;
    manager.scheduleIdle();
    manager.scheduleIdle(); // idempotent
    expect(timers).toHaveLength(1);
    timers[0]();
    await tick(); await tick();
    expect(browser.closed).toBe(1);
    expect(manager.lastStopReason('x')).toBe('idle_shutdown');
  });

  test('an unknown provider name is a 500 browser_unknown', async () => {
    const { manager } = setup({ provider: { name: 'x', launch: async () => fakeBrowser() } });
    await expect(manager.ensure('nope')).rejects.toMatchObject({ statusCode: 500, code: 'browser_unknown' });
  });
});
