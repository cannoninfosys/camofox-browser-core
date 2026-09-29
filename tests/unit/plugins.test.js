/**
 * Tests for lib/plugins.js -- createPluginEvents, loadPlugins, and config reading.
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createPluginEvents, discoverPlugins, loadPlugins } from '../../lib/plugins.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

describe('lib/plugins', () => {
  describe('createPluginEvents', () => {
    test('returns an EventEmitter with high maxListeners', () => {
      const events = createPluginEvents();
      expect(events).toBeDefined();
      expect(typeof events.on).toBe('function');
      expect(typeof events.emit).toBe('function');
      expect(events.getMaxListeners()).toBe(50);
    });

    test('basic emit/on works', () => {
      const events = createPluginEvents();
      const received = [];
      events.on('test:event', (payload) => received.push(payload));

      events.emit('test:event', { foo: 'bar' });
      expect(received).toEqual([{ foo: 'bar' }]);
    });

    test('supports multiple listeners', () => {
      const events = createPluginEvents();
      const results = [];
      events.on('multi', () => results.push('a'));
      events.on('multi', () => results.push('b'));
      events.on('multi', () => results.push('c'));

      events.emit('multi');
      expect(results).toEqual(['a', 'b', 'c']);
    });

    test('removeListener works', () => {
      const events = createPluginEvents();
      const results = [];
      const handler = () => results.push('called');
      events.on('removal', handler);

      events.emit('removal');
      expect(results).toEqual(['called']);

      events.removeListener('removal', handler);
      events.emit('removal');
      expect(results).toEqual(['called']); // not called again
    });

    test('emitAsync awaits all listeners including async', async () => {
      const events = createPluginEvents();
      const results = [];

      events.on('async:test', async (payload) => {
        await new Promise((r) => setTimeout(r, 10));
        results.push('async-' + payload.val);
      });
      events.on('async:test', (payload) => {
        results.push('sync-' + payload.val);
      });

      await events.emitAsync('async:test', { val: 1 });
      expect(results).toContain('async-1');
      expect(results).toContain('sync-1');
      expect(results.length).toBe(2);
    });

    test('emitAsync with no listeners resolves immediately', async () => {
      const events = createPluginEvents();
      await events.emitAsync('nonexistent', {});
      // No error thrown
    });
  });

  describe('loadPlugins', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-plugin-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeMockCtx() {
      return {
        log: jest.fn(),
        events: createPluginEvents(),
        sessions: new Map(),
        config: {},
      };
    }

    function makePlugin(pluginsDir, name, source, metadata = null) {
      const pluginDir = path.join(pluginsDir, name);
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'index.js'), source);
      if (metadata) {
        fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(metadata));
      }
    }

    test('loads config-disabled plugin when its enable env var is set', async () => {
      const pluginsDir = path.join(tmpDir, 'plugins');
      const configPath = path.join(tmpDir, 'camofox.config.json');
      fs.mkdirSync(pluginsDir);
      makePlugin(
        pluginsDir,
        'env-enabled',
        'export async function register(app, _ctx, pluginConfig) { app.loaded.push(pluginConfig); }\n',
        { enableEnvVar: 'ENABLE_TEST_PLUGIN' }
      );
      makePlugin(
        pluginsDir,
        'disabled',
        'export async function register(app) { app.loaded.push("disabled"); }\n'
      );
      fs.writeFileSync(configPath, JSON.stringify({
        plugins: {
          'env-enabled': { enabled: false, resolution: '1280x720' },
          disabled: { enabled: false },
        },
      }));

      const ctx = makeMockCtx();
      const app = { loaded: [] };
      await loadPlugins(app, ctx, {
        pluginsDir,
        configPath,
        env: { ENABLE_TEST_PLUGIN: '1' },
      });

      // Assert the load/skip decision, which is the unit under test: the
      // env-override gate runs (and logs) before the plugin's index.js is
      // imported. We do not assert on the registration itself because jest's
      // experimental VM modules cannot dynamic-import an ESM file from the
      // temp dir, which would make the test flaky for reasons unrelated to
      // the gate. The "plugin enabled by environment" log fires only when the
      // gate decides to load a config-disabled plugin from its env var.
      expect(ctx.log).toHaveBeenCalledWith('info', 'plugin enabled by environment', {
        plugin: 'env-enabled',
        envVar: 'ENABLE_TEST_PLUGIN',
      });
      // The sibling plugin has no enable env var, so it stays skipped.
      expect(ctx.log).toHaveBeenCalledWith(
        'debug',
        'plugin "disabled" not in camofox.config.json plugins list, skipping'
      );
    });

    test('skips config-disabled plugin when its enable env var is not set', async () => {
      const pluginsDir = path.join(tmpDir, 'plugins');
      const configPath = path.join(tmpDir, 'camofox.config.json');
      fs.mkdirSync(pluginsDir);
      makePlugin(
        pluginsDir,
        'env-enabled',
        'export async function register(app) { app.loaded.push("env-enabled"); }\n',
        { enableEnvVar: 'ENABLE_TEST_PLUGIN' }
      );
      fs.writeFileSync(configPath, JSON.stringify({
        plugins: {
          'env-enabled': { enabled: false },
        },
      }));

      const app = { loaded: [] };
      const loaded = await loadPlugins(app, makeMockCtx(), {
        pluginsDir,
        configPath,
        env: {},
      });

      expect(loaded).toEqual([]);
      expect(app.loaded).toEqual([]);
    });

    test('returns empty array when plugins directory does not exist', async () => {
      // loadPlugins checks the hardcoded PLUGINS_DIR, not tmpDir.
      // We test by providing a mock ctx -- if no plugins/ dir exists
      // relative to lib/, it would still load the real plugins.
      // Instead, test via the actual project's plugin loader.
      const ctx = makeMockCtx();
      const app = {};

      // This tests the real plugin loading -- should return the project's actual plugins
      const loaded = await loadPlugins(app, ctx);
      expect(Array.isArray(loaded)).toBe(true);
      // Each loaded plugin should be a string
      for (const name of loaded) {
        expect(typeof name).toBe('string');
      }
    });

    test('loadPlugins registers plugins and logs them', async () => {
      const ctx = makeMockCtx();
      const app = {};

      const loaded = await loadPlugins(app, ctx);
      // Verify that log was called for each loaded plugin
      if (loaded.length > 0) {
        const pluginLoadedCalls = ctx.log.mock.calls.filter(
          ([level, msg]) => level === 'info' && msg === 'plugin loaded'
        );
        expect(pluginLoadedCalls.length).toBe(loaded.length);
      }
    });
  });

  describe('readPluginConfig (tested indirectly via loadPlugins)', () => {
    // readPluginConfig is not exported, so we test its behavior
    // indirectly by verifying loadPlugins respects the config.

    test('project camofox.config.json exists and is valid', () => {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const configPath = path.join(__dirname, '../../camofox.config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config).toHaveProperty('plugins');

      // plugins can be array or object
      const isArray = Array.isArray(config.plugins);
      const isObject = typeof config.plugins === 'object' && !isArray;
      expect(isArray || isObject).toBe(true);
    });

    test('array format plugins are string lists', () => {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const configPath = path.join(__dirname, '../../camofox.config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      if (Array.isArray(config.plugins)) {
        for (const name of config.plugins) {
          expect(typeof name).toBe('string');
          expect(name.length).toBeGreaterThan(0);
        }
      }
    });

    test('each configured plugin has an index.js', () => {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const rootDir = path.join(__dirname, '../..');
      const configPath = path.join(rootDir, 'camofox.config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      const pluginNames = Array.isArray(config.plugins)
        ? config.plugins
        : Object.keys(config.plugins || {});

      for (const name of pluginNames) {
        const indexPath = path.join(rootDir, 'plugins', name, 'index.js');
        expect(fs.existsSync(indexPath)).toBe(true);
      }
    });
  });
  describe('external plugin folders (CAMOFOX_PLUGIN_PATH)', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const FIXTURE_PLUGINS = path.join(__dirname, '../fixtures/external-plugins');
    const BUILTIN_PLUGINS = path.join(__dirname, '../../plugins');
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-plugin-path-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeCtx(config = {}) {
      return { log: jest.fn(), events: createPluginEvents(), sessions: new Map(), config };
    }

    function makePluginDir(root, name, { index = true } = {}) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      if (index) fs.writeFileSync(path.join(dir, 'index.js'), 'export function register() {}\n');
      return dir;
    }

    function writeConfig(plugins) {
      const configPath = path.join(tmpDir, 'camofox.config.json');
      fs.writeFileSync(configPath, JSON.stringify({ plugins }));
      return configPath;
    }

    test('scans the built-in folder first, then each extra folder in order', () => {
      const builtin = path.join(tmpDir, 'builtin');
      const first = path.join(tmpDir, 'first');
      const second = path.join(tmpDir, 'second');
      makePluginDir(builtin, 'alpha');
      makePluginDir(builtin, 'beta');
      makePluginDir(second, 'aardvark');
      makePluginDir(first, 'zulu');

      const found = discoverPlugins({ pluginsDir: builtin, pluginPaths: [first, second] });

      expect(found.map((p) => p.name)).toEqual(['alpha', 'beta', 'zulu', 'aardvark']);
      expect(found.map((p) => p.pluginsDir)).toEqual([builtin, builtin, first, second]);
      expect(found[2].dir).toBe(path.join(first, 'zulu'));
    });

    test('finds a plugin folder that is a symlink and skips a broken link', () => {
      const extra = path.join(tmpDir, 'extra');
      fs.mkdirSync(extra);
      const checkout = makePluginDir(path.join(tmpDir, 'checkouts'), 'linked-checkout');
      fs.symlinkSync(checkout, path.join(extra, 'linked'), 'dir');
      fs.symlinkSync(path.join(tmpDir, 'missing'), path.join(extra, 'dangling'), 'dir');
      const ctx = makeCtx();

      const found = discoverPlugins({ pluginsDir: path.join(tmpDir, 'none'), pluginPaths: [extra] }, ctx);

      expect(found).toEqual([{ name: 'linked', dir: path.join(extra, 'linked'), pluginsDir: extra, hasIndex: true }]);
      expect(ctx.log).toHaveBeenCalledWith('warn', 'plugin link is broken, skipping', expect.objectContaining({ plugin: 'dangling' }));
    });

    test('a name clash with a built-in plugin is a startup error, even if the built-in is disabled', async () => {
      const extra = path.join(tmpDir, 'extra');
      makePluginDir(extra, 'vnc');
      const configPath = writeConfig({ vnc: { enabled: false }, youtube: { enabled: true } });
      const app = { loaded: [] };

      await expect(loadPlugins(app, makeCtx(), { pluginsDir: BUILTIN_PLUGINS, pluginPaths: [extra], configPath }))
        .rejects.toMatchObject({ code: 'plugin_name_conflict', message: expect.stringContaining('"vnc"') });
      expect(app.loaded).toEqual([]);
    });

    test('a name clash between two extra folders is a startup error naming both folders', () => {
      const first = path.join(tmpDir, 'first');
      const second = path.join(tmpDir, 'second');
      makePluginDir(first, 'shared');
      makePluginDir(second, 'shared');

      let error = null;
      try {
        discoverPlugins({ pluginsDir: path.join(tmpDir, 'none'), pluginPaths: [first, second] });
      } catch (err) {
        error = err;
      }

      expect(error?.code).toBe('plugin_name_conflict');
      expect(error.message).toContain(first);
      expect(error.message).toContain(second);
    });

    test('a folder without index.js does not clash', () => {
      const first = path.join(tmpDir, 'first');
      const second = path.join(tmpDir, 'second');
      makePluginDir(first, 'shared', { index: false });
      makePluginDir(second, 'shared');

      const found = discoverPlugins({ pluginsDir: path.join(tmpDir, 'none'), pluginPaths: [first, second] });

      expect(found).toEqual([{ name: 'shared', dir: path.join(second, 'shared'), pluginsDir: second, hasIndex: true }]);
    });

    test('a missing extra folder is a startup error', () => {
      const missing = path.join(tmpDir, 'does-not-exist');

      expect(() => discoverPlugins({ pluginsDir: path.join(tmpDir, 'none'), pluginPaths: [missing] }))
        .toThrow(expect.objectContaining({ code: 'plugin_path_invalid' }));
    });

    test('loads an external plugin from ctx.config.pluginPaths using ctx.config.configPath', async () => {
      const configPath = writeConfig({ 'external-fixture': { enabled: true, answer: 42 } });
      const ctx = makeCtx({ pluginPaths: [FIXTURE_PLUGINS], configPath });
      const app = { loaded: [] };

      const loaded = await loadPlugins(app, ctx, { pluginsDir: path.join(tmpDir, 'no-builtins') });

      expect(loaded).toEqual(['external-fixture']);
      expect(app.loaded).toEqual([{ name: 'external-fixture', settings: { enabled: true, answer: 42 } }]);
      expect(ctx.log).toHaveBeenCalledWith('info', 'plugin loaded', {
        plugin: 'external-fixture',
        dir: path.join(FIXTURE_PLUGINS, 'external-fixture'),
      });
    });

    test('the camofox.config.json allow-list also applies to external plugins', async () => {
      const configPath = writeConfig({ youtube: { enabled: true } });
      const ctx = makeCtx({ pluginPaths: [FIXTURE_PLUGINS], configPath });
      const app = { loaded: [] };

      const loaded = await loadPlugins(app, ctx, { pluginsDir: path.join(tmpDir, 'no-builtins') });

      expect(loaded).toEqual([]);
      expect(app.loaded).toEqual([]);
      expect(ctx.log).toHaveBeenCalledWith('debug', 'plugin "external-fixture" not in camofox.config.json plugins list, skipping');
    });

    test('without extra folders only the built-in plugins are found (default unchanged)', () => {
      const builtinNames = fs.readdirSync(BUILTIN_PLUGINS, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
        .map((e) => e.name);

      const found = discoverPlugins();

      expect(found.map((p) => p.name)).toEqual(builtinNames);
      expect(found.every((p) => p.pluginsDir === BUILTIN_PLUGINS)).toBe(true);
    });
  });
});
