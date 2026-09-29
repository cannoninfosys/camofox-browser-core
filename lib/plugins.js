/**
 * Camofox-browser plugin system.
 *
 * Plugins live in plugins/<name>/index.js (or <dir>/<name>/index.js for each
 * folder in CAMOFOX_PLUGIN_PATH) and export a register(app, ctx) function.
 * The ctx object provides access to sessions, config, logging, auth middleware,
 * core functions, and an EventEmitter for lifecycle hooks.
 *
 * 30 events across 7 categories:
 *
 *   BROWSER LIFECYCLE
 *     browser:launching       { options }                      -- mutate launch options
 *     browser:launched        { browser, display }             -- after launch
 *     browser:restart         { reason }                       -- before restart cycle
 *     browser:closed          { reason }                       -- after browser closed
 *     browser:error           { error }                        -- uncaught browser error
 *
 *   SESSION LIFECYCLE
 *     session:creating        { userId, contextOptions }       -- mutate context options
 *     session:created         { userId, context }              -- after context stored
 *     session:destroying      { userId, reason }               -- before context close (context still alive)
 *     session:destroyed       { userId, reason }               -- after cleanup
 *     session:expired         { userId, idleMs }               -- reaper triggered
 *
 *   TAB LIFECYCLE
 *     tab:created             { userId, tabId, page, url }
 *     tab:navigating          { userId, tabId, url, source, page } -- awaited before every API navigation; a
 *                                                     listener may refuse it (see lib/navigation-block.js)
 *     tab:navigated           { userId, tabId, url, prevUrl }
 *     tab:destroyed           { userId, tabId, reason }
 *     tab:recycled            { userId, tabId }
 *     tab:error               { userId, tabId, error }
 *
 *   CONTENT
 *     tab:snapshot            { userId, tabId, snapshot }
 *     tab:screenshot          { userId, tabId, buffer }
 *     tab:evaluate            { userId, tabId, expression }
 *     tab:evaluated           { userId, tabId, result }
 *
 *   INPUT
 *     tab:click               { userId, tabId, ref, selector }
 *     tab:type                { userId, tabId, textLength, ref, mode }
 *     tab:scroll              { userId, tabId, direction, amount }
 *     tab:press               { userId, tabId, key }
 *
 *   DOWNLOADS
 *     tab:download:start      { userId, tabId, filename, url }
 *     tab:download:complete   { userId, tabId, filename, path, size }
 *
 *   COOKIES / AUTH
 *     session:cookies:import  { userId, count }
 *     session:storage:export  { userId, storageState }
 *
 *   SERVER
 *     server:starting         { port }
 *     server:started          { port, pid }
 *     server:shutdown         { signal }
 *
 * Mutating hooks (browser:launching, session:creating) pass the options object
 * by reference -- plugins can modify it in place before core uses it.
 *
 * tab:navigating is awaited too: a listener that throws { statusCode, code, reason, recovery? } refuses the
 * navigation, and a route answered with ctx.fulfillBlockedNavigation() reports it as blocked. Either is sent
 * to the API caller as { error, code, recovery, blocked } and never counted as a browser failure.
 *
 * Plugins register in "order" (camofox.config.json, default 0, lower first;
 * equal orders keep folder order), so listeners added during register() run in
 * that order and a plugin with a higher order has the final say on mutating
 * hooks. emitAsync() awaits listeners one after another in that order.
 *
 * A plugin marked "required": true must load: if it is missing, disabled, or
 * fails to import or register, loadPlugins() throws and the server does not start.
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const CONFIG_PATH = path.join(ROOT_DIR, 'camofox.config.json');

function envFlagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function readPluginMetadata(pluginsDir, name) {
  try {
    const raw = fs.readFileSync(path.join(pluginsDir, name, 'plugin.json'), 'utf-8');
    const metadata = JSON.parse(raw);
    return metadata && typeof metadata === 'object' ? metadata : {};
  } catch {
    return {};
  }
}

function pluginEnabledByEnv(metadata, env) {
  const { enableEnvVar } = metadata;
  return typeof enableEnvVar === 'string' && enableEnvVar.length > 0 && envFlagEnabled(env[enableEnvVar]);
}

/**
 * Read plugin configuration from camofox.config.json.
 * Supports two formats:
 *   - Array of strings: ["youtube", "persistence"] (no per-plugin config)
 *   - Object with per-plugin config: { "youtube": { "enabled": true }, "persistence": { "enabled": true, "profileDir": "/data" } }
 * In the object format a plugin may also set "required": true (it must load) and
 * "order": <number> (registration order, default 0, lower first).
 *
 * A missing file means "no list" unless mustExist is set; a file that cannot be
 * read or parsed, or an invalid "required"/"order" value, is an error so that a
 * broken config never silently drops a required plugin.
 *
 * Returns { list: string[] | null, configs: Map<string, object>, required: string[],
 *           disabled: Set<string>, order: Map<string, number> }
 */
function readPluginConfig(configPath = CONFIG_PATH, { mustExist = false } = {}) {
  const configs = new Map();
  const result = { list: null, configs, required: [], disabled: new Set(), order: new Map() };
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT' && !mustExist) return result;
    throw pluginError('plugin_config_invalid', `cannot read plugin config ${configPath}: ${err.message}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw pluginError('plugin_config_invalid', `plugin config ${configPath} is not valid JSON: ${err.message}`);
  }
  if (!config || typeof config !== 'object' || !config.plugins) return result;
  if (Array.isArray(config.plugins)) {
    result.list = config.plugins;
    return result;
  }
  if (typeof config.plugins === 'object') {
    const list = [];
    for (const [name, pluginConf] of Object.entries(config.plugins)) {
      const isObjectConfig = pluginConf && typeof pluginConf === 'object';
      if (isObjectConfig) {
        configs.set(name, pluginConf);
        if (pluginConf.required !== undefined && typeof pluginConf.required !== 'boolean') {
          throw pluginError('plugin_config_invalid', `plugin "${name}": "required" must be true or false in ${configPath}`);
        }
        if (pluginConf.order !== undefined) {
          if (typeof pluginConf.order !== 'number' || !Number.isFinite(pluginConf.order)) {
            throw pluginError('plugin_config_invalid', `plugin "${name}": "order" must be a number in ${configPath}`);
          }
          result.order.set(name, pluginConf.order);
        }
        if (pluginConf.required === true) result.required.push(name);
      }
      if (pluginConf === false || (isObjectConfig && pluginConf.enabled === false)) {
        result.disabled.add(name);
        continue;
      }
      list.push(name);
    }
    result.list = list;
  }
  return result;
}

/**
 * Create the plugin event bus.
 */
export function createPluginEvents() {
  const events = new EventEmitter();
  events.setMaxListeners(50); // generous for many plugins

  /**
   * Emit an event and await all listeners (including async ones), sequentially.
   * Use for mutating hooks where plugins must finish before core continues.
   * Regular emit() is still used for fire-and-forget observational events.
   */
  events.emitAsync = async function emitAsync(eventName, payload) {
    // One listener after another, in registration (= plugin) order, so a later
    // plugin's change to a mutable payload wins even if an earlier listener awaits
    // before mutating. Every listener runs; the first error is rethrown at the end.
    let failure = null;
    for (const fn of this.listeners(eventName)) {
      try {
        await fn(payload);
      } catch (err) {
        failure ??= { err };
      }
    }
    if (failure) throw failure.err;
  };

  return events;
}

function pluginError(code, message, extra = {}) {
  const err = new Error(message, extra.cause ? { cause: extra.cause } : undefined);
  err.code = code;
  if (extra.plugin) err.plugin = extra.plugin;
  return err;
}

function requiredPluginError(name, reason, cause) {
  return pluginError('plugin_required_failed', `required plugin "${name}" ${reason}`, { plugin: name, cause });
}

function isDirectoryEntry(dir, entry, ctx) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, entry.name)).isDirectory();
  } catch (err) {
    ctx.log('warn', 'plugin link is broken, skipping', { plugin: entry.name, dir, error: err.message });
    return false;
  }
}

/**
 * Find plugin folders: the built-in plugins/ folder first, then each extra
 * folder (CAMOFOX_PLUGIN_PATH) in order. A plugin is a subfolder (or a symlink
 * to one) whose name does not start with _ or .; it loads only if it has an
 * index.js.
 *
 * A plugin name with an index.js in more than one folder is an error: an external
 * plugin never silently replaces a built-in or an earlier one.
 *
 * @returns {{ name: string, dir: string, pluginsDir: string, hasIndex: boolean }[]}
 */
export function discoverPlugins({ pluginsDir = PLUGINS_DIR, pluginPaths = [] } = {}, ctx = { log() {} }) {
  const found = new Map();
  const roots = [];
  if (fs.existsSync(pluginsDir)) {
    roots.push(pluginsDir);
  } else {
    ctx.log('info', 'no plugins directory found, skipping built-in plugins');
  }
  for (const extraDir of pluginPaths) {
    let stat = null;
    try {
      stat = fs.statSync(extraDir);
    } catch {}
    if (!stat?.isDirectory()) {
      throw pluginError('plugin_path_invalid', `CAMOFOX_PLUGIN_PATH entry is not a directory: ${extraDir}`);
    }
    roots.push(extraDir);
  }

  for (const root of roots) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('_') || name.startsWith('.')) continue;
      if (!isDirectoryEntry(root, entry, ctx)) continue;
      const dir = path.join(root, name);
      const hasIndex = fs.existsSync(path.join(dir, 'index.js'));
      const earlier = found.get(name);
      if (earlier && hasIndex && earlier.hasIndex) {
        throw pluginError(
          'plugin_name_conflict',
          `plugin "${name}" found in both ${earlier.pluginsDir} and ${root}; plugin names must be unique`
        );
      }
      if (earlier && !(hasIndex && !earlier.hasIndex)) continue;
      found.delete(name);
      found.set(name, { name, dir, pluginsDir: root, hasIndex });
    }
  }
  return [...found.values()];
}

/**
 * Load and register all plugins: the built-in plugins/<name>/index.js first,
 * then the ones in each CAMOFOX_PLUGIN_PATH folder.
 *
 * @param {object} app - Express app
 * @param {object} ctx - Shared plugin context. Each registration receives `ctx.plugin`,
 *                       containing that plugin's name, settings, and scoped capabilities.
 * @param {object} [options]
 * @param {string} [options.pluginsDir] - Built-in plugin folder (default: plugins/)
 * @param {string[]} [options.pluginPaths] - Extra plugin folders (default: ctx.config.pluginPaths)
 * @param {string} [options.configPath] - camofox.config.json (default: ctx.config.configPath, then the install folder's)
 * @returns {string[]} - Names of loaded plugins, in registration order
 * @throws {Error} code plugin_required_failed, plugin_config_invalid, plugin_name_conflict,
 *                 plugin_path_invalid or plugin_capability_conflict -- the server must not start
 */
export async function loadPlugins(app, ctx, options = {}) {
  const loaded = [];
  const pluginsDir = options.pluginsDir || PLUGINS_DIR;
  const pluginPaths = options.pluginPaths || ctx.config?.pluginPaths || [];
  const configPath = options.configPath || ctx.config?.configPath || CONFIG_PATH;
  const env = options.env || ctx.config?.pluginEnv || {};

  const discovered = discoverPlugins({ pluginsDir, pluginPaths }, ctx);
  const {
    list: allowList,
    configs: pluginConfigs,
    required,
    disabled,
    order,
  } = readPluginConfig(configPath, { mustExist: path.resolve(configPath) !== CONFIG_PATH });

  // Required plugins must exist before anything registers.
  const requiredSet = new Set(required);
  for (const name of required) {
    const found = discovered.find((p) => p.name === name);
    if (disabled.has(name)) throw requiredPluginError(name, `is disabled in ${configPath}`);
    if (!found) throw requiredPluginError(name, `was not found in ${[pluginsDir, ...pluginPaths].join(', ')}`);
    if (!found.hasIndex) throw requiredPluginError(name, `has no index.js in ${found.dir}`);
  }

  // Lower order registers first; Array.prototype.sort is stable, so equal orders keep folder order.
  const plugins = [...discovered].sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));

  for (const { name, dir, pluginsDir: pluginRoot, hasIndex } of plugins) {
    // If camofox.config.json specifies a plugins list, only load those
    if (allowList && !allowList.includes(name)) {
      const metadata = readPluginMetadata(pluginRoot, name);
      if (pluginEnabledByEnv(metadata, env)) {
        ctx.log('info', 'plugin enabled by environment', { plugin: name, envVar: metadata.enableEnvVar });
      } else {
        ctx.log('debug', `plugin "${name}" not in camofox.config.json plugins list, skipping`);
        continue;
      }
    }

    if (!hasIndex) {
      ctx.log('warn', `plugin "${name}" has no index.js, skipping`);
      continue;
    }
    const indexPath = path.join(dir, 'index.js');

    try {
      const mod = await import(pathToFileURL(indexPath).href);
      const register = mod.default || mod.register;
      if (typeof register !== 'function') {
        if (requiredSet.has(name)) throw requiredPluginError(name, 'does not export a register function');
        ctx.log('warn', `plugin "${name}" does not export a register function, skipping`);
        continue;
      }

      const pluginConfig = pluginConfigs.get(name) || {};
      const pluginCtx = Object.create(ctx);
      pluginCtx.plugin = {
        name,
        settings: pluginConfig,
        registerVirtualDisplayProvider(factory) {
          return ctx.registerVirtualDisplayProvider(name, factory);
        },
      };
      await register(app, pluginCtx, pluginConfig);
      loaded.push(name);
      ctx.log('info', 'plugin loaded', pluginRoot === pluginsDir ? { plugin: name } : { plugin: name, dir });
    } catch (err) {
      if (err?.code === 'plugin_capability_conflict' || err?.code === 'plugin_required_failed') throw err;
      if (requiredSet.has(name)) throw requiredPluginError(name, `failed to load: ${err?.message}`, err);
      ctx.log('error', 'plugin load failed', { plugin: name, error: err.message, stack: err.stack });
    }
  }

  return loaded;
}

export function typeEventPayload({ userId, tabId, text, ref, mode }) {
  return {
    userId,
    tabId,
    textLength: typeof text === 'string' ? text.length : 0,
    ref,
    mode: mode || 'fill',
  };
}
