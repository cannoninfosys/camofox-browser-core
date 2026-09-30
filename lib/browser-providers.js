/**
 * Browser providers: plugins can supply a browser other than the built-in Camoufox.
 *
 *   ctx.registerBrowserProvider({
 *     name: 'chromium',                             // [a-z][a-z0-9-]{0,31}; 'camoufox' is the built-in
 *     async launch(env) { ... },                    // -> Browser | { browser, pid?, display?, ownedPids?() }
 *     async close(browser, { reason, pid, timeoutMs }) { ... },  // optional; default browser.close()
 *   });
 *
 * `env` = { options, playwright: { chromium, firefox }, VirtualDisplay, createVirtualDisplay, interactiveMode, log }.
 * `options` is the object `browser:launching` listeners filled in (e.g. a launch proxy). Displays created with
 * `env.createVirtualDisplay()` and the pids `ownedPids()` lists belong to the provider: the built-in browser's
 * survivor cleanup never kills them. `close` should finish within `timeoutMs`.
 *
 * The built-in Camoufox keeps its own lifecycle in server.js; a provider's browser is managed here: launched on
 * first use, idled out when no session uses it, closed on stop and shutdown.
 */

export const BUILTIN_BROWSER = 'camoufox';
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function createBrowserProviderRegistry() {
  const providers = new Map();
  return {
    register(pluginName, provider) {
      if (!provider || typeof provider !== 'object') throw new Error('browser provider must be an object');
      const { name, launch, close } = provider;
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`invalid browser provider name: ${name}`);
      if (name === BUILTIN_BROWSER) throw new Error(`browser provider name "${name}" is reserved for the built-in browser`);
      if (typeof launch !== 'function') throw new Error(`browser provider "${name}" needs a launch() function`);
      if (close !== undefined && typeof close !== 'function') throw new Error(`browser provider "${name}": close must be a function`);
      if (providers.has(name)) {
        throw Object.assign(
          new Error(`browser provider "${name}" is already registered by plugin "${providers.get(name).pluginName}"`),
          { code: 'browser_provider_conflict' },
        );
      }
      providers.set(name, { name, launch, close, pluginName });
    },
    get(name) { return providers.get(name) || null; },
    has(name) { return name === BUILTIN_BROWSER || providers.has(name); },
    names() { return [BUILTIN_BROWSER, ...providers.keys()]; },
  };
}

/** A provider's launch() may return the Browser itself or a descriptor. */
export function normalizeLaunchResult(result) {
  if (result && typeof result === 'object' && result.browser) {
    return {
      browser: result.browser,
      pid: Number.isInteger(result.pid) ? result.pid : null,
      display: result.display,
      ownedPids: typeof result.ownedPids === 'function' ? result.ownedPids : () => [],
    };
  }
  return { browser: result, pid: null, display: undefined, ownedPids: () => [] };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Lifecycle of the provider browsers (one per provider name).
 *
 * deps: registry, emit(event, payload), emitAsync(event, payload), log(level, msg, fields),
 *   launchEnv() -> the env fields shared by every launch (playwright, VirtualDisplay, interactiveMode, log),
 *   createVirtualDisplay() -> a new display object, sessionsOn(name) -> open sessions on that browser,
 *   onDisconnected(name) -> closes that browser's sessions (awaited), isShuttingDown(),
 *   launchTimeoutMs, closeTimeoutMs (default budget of a close), idleTimeoutMs,
 *   setTimeoutFn/clearTimeoutFn (tests).
 */
export function createProviderBrowsers(deps) {
  const {
    registry,
    emit = () => {},
    emitAsync = async () => {},
    log = () => {},
    launchEnv = () => ({}),
    createVirtualDisplay = () => null,
    sessionsOn = () => 0,
    onDisconnected = async () => {},
    isShuttingDown = () => false,
    launchTimeoutMs = 60000,
    closeTimeoutMs = 8000,
    idleTimeoutMs = 0,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = deps;
  const entries = new Map();

  function entryOf(name) {
    let entry = entries.get(name);
    if (!entry) {
      entry = {
        browser: null, pid: null, display: undefined, ownedPids: () => [], displays: new Set(),
        launchPromise: null, closePromise: null, idleTimer: null, abortReason: null, lastStopReason: null,
      };
      entries.set(name, entry);
    }
    return entry;
  }

  function clearIdle(entry) {
    if (entry.idleTimer) { clearTimeoutFn(entry.idleTimer); entry.idleTimer = null; }
  }

  function connected(entry) {
    try { return !!entry?.browser && (entry.browser.isConnected?.() ?? true); } catch { return false; }
  }

  async function closeLaunched(provider, launched, reason, timeoutMs) {
    try {
      await withTimeout(
        provider.close ? provider.close(launched.browser, { reason, pid: launched.pid, timeoutMs }) : launched.browser.close(),
        timeoutMs, 'browser close timeout');
    } catch (err) {
      log('warn', 'browser close failed or timed out', { provider: provider.name, reason, error: err.message, pid: launched.pid });
    }
  }

  async function launch(name, provider, entry) {
    if (isShuttingDown()) {
      throw Object.assign(new Error('Server is shutting down'), { statusCode: 503, code: 'server_shutting_down' });
    }
    entry.abortReason = null;
    const options = {};
    await emitAsync('browser:launching', { options, provider: name });
    log('info', 'launching browser', { provider: name, plugin: provider.pluginName });
    const env = {
      ...launchEnv(),
      options,
      createVirtualDisplay: () => {
        const display = createVirtualDisplay();
        if (display) entry.displays.add(display);
        return display;
      },
    };
    const launching = Promise.resolve().then(() => provider.launch(env)).then(normalizeLaunchResult);
    let launched;
    try {
      launched = await withTimeout(launching, launchTimeoutMs, `Browser launch timeout (${Math.round(launchTimeoutMs / 1000)}s)`);
    } catch (err) {
      // A launch that still succeeds after its timeout must not leak a browser.
      launching.then((late) => {
        if (late?.browser) {
          log('warn', 'browser launched after its timeout; closing it', { provider: name });
          return closeLaunched(provider, late, 'launch_timeout', closeTimeoutMs);
        }
      }).catch(() => {}).finally(() => entry.displays.clear());
      throw err;
    }
    if (!launched.browser) throw new Error(`browser provider "${name}" returned no browser`);
    if (entry.abortReason || isShuttingDown()) {
      const reason = entry.abortReason || 'shutdown';
      await closeLaunched(provider, launched, reason, closeTimeoutMs);
      entry.displays.clear();
      entry.lastStopReason = reason;
      throw Object.assign(new Error(`browser launch cancelled (${reason})`), { statusCode: 503, code: 'browser_closed' });
    }
    entry.browser = launched.browser;
    entry.pid = launched.pid;
    entry.display = launched.display;
    entry.ownedPids = launched.ownedPids;
    entry.lastStopReason = null;
    emit('browser:launched', { browser: launched.browser, display: launched.display, provider: name });
    log('info', 'browser launched', { provider: name, pid: launched.pid, display: launched.display || null });
    return launched.browser;
  }

  async function ensure(name) {
    const provider = registry.get(name);
    if (!provider) throw Object.assign(new Error(`Unknown browser: ${name}`), { statusCode: 500, code: 'browser_unknown' });
    const entry = entryOf(name);
    clearIdle(entry);
    if (entry.closePromise) await entry.closePromise;
    if (entry.browser && !connected(entry)) {
      log('warn', 'browser disconnected, clearing its sessions and relaunching', { provider: name, deadSessions: sessionsOn(name) });
      await onDisconnected(name);
      await close(name, 'browser_disconnected');
    }
    if (entry.browser) return entry.browser;
    if (!entry.launchPromise) {
      entry.launchPromise = launch(name, provider, entry).finally(() => { entry.launchPromise = null; });
    }
    return entry.launchPromise;
  }

  /** Closes the provider's browser (also one still launching). `timeoutMs` bounds the whole close. */
  async function close(name, reason, { timeoutMs = closeTimeoutMs } = {}) {
    const entry = entries.get(name);
    if (!entry) return;
    if (entry.closePromise) return entry.closePromise;
    clearIdle(entry);
    const started = Date.now();
    if (entry.launchPromise) {
      entry.abortReason = reason;
      await withTimeout(entry.launchPromise, timeoutMs, 'launch still running').catch(() => {});
    }
    const b = entry.browser;
    if (!b) return;
    const provider = registry.get(name);
    const pid = entry.pid;
    entry.browser = null;
    entry.pid = null;
    entry.display = undefined;
    entry.lastStopReason = reason;
    const left = Math.max(1000, timeoutMs - (Date.now() - started));
    entry.closePromise = (async () => {
      let done = false;
      const closing = Promise.resolve()
        .then(() => (provider?.close ? provider.close(b, { reason, pid, timeoutMs: left }) : b.close()))
        .then(() => { done = true; });
      try {
        await withTimeout(closing, left, 'browser close timeout');
      } catch (err) {
        log('warn', 'browser close failed or timed out', { provider: name, reason, error: err.message, pid });
      }
      // Owned pids stay excluded from the built-in browser's cleanup until the provider's close really ended.
      const release = () => { entry.ownedPids = () => []; entry.displays.clear(); };
      if (done) release(); else closing.catch(() => {}).finally(release);
      emit('browser:closed', { reason, provider: name });
      log('info', 'browser closed fully', { provider: name, reason, pid });
    })().finally(() => { entry.closePromise = null; });
    return entry.closePromise;
  }

  function closeAll(reason, options = {}) {
    const names = [...entries.entries()].filter(([, e]) => e.browser || e.launchPromise).map(([n]) => n);
    return Promise.allSettled(names.map((n) => close(n, reason, options)));
  }

  function scheduleIdle() {
    if (idleTimeoutMs <= 0) return;
    for (const [name, entry] of entries) {
      if (entry.idleTimer || !entry.browser || sessionsOn(name) > 0) continue;
      entry.idleTimer = setTimeoutFn(() => {
        entry.idleTimer = null;
        if (entry.browser && sessionsOn(name) === 0) {
          log('info', 'browser idle shutdown (no sessions)', { provider: name });
          close(name, 'idle_shutdown').catch(() => {});
        }
      }, idleTimeoutMs);
      entry.idleTimer?.unref?.();
    }
  }

  /** Pids the built-in browser's survivor cleanup must never kill (provider browsers, their displays, helpers). */
  function ownedPids() {
    const pids = new Set();
    for (const entry of entries.values()) {
      if (entry.pid) pids.add(entry.pid);
      for (const display of entry.displays) {
        const pid = display?.proc?.pid;
        if (Number.isInteger(pid)) pids.add(pid);
      }
      try { for (const pid of entry.ownedPids() || []) if (Number.isInteger(pid)) pids.add(pid); } catch { /* provider bug */ }
    }
    return pids;
  }

  return {
    ensure,
    close,
    closeAll,
    scheduleIdle,
    ownedPids,
    isRunning: (name) => connected(entries.get(name)),
    isLaunching: (name) => !!entries.get(name)?.launchPromise,
    browser: (name) => entries.get(name)?.browser || null,
    pid: (name) => entries.get(name)?.pid ?? null,
    lastStopReason: (name) => entries.get(name)?.lastStopReason ?? null,
    running: () => [...entries.entries()].filter(([, e]) => connected(e)).map(([n, e]) => ({ name: n, browser: e.browser })),
  };
}
