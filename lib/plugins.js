/**
 * Camofox-browser plugin system.
 *
 * Plugins live in plugins/<name>/index.js (or <dir>/<name>/index.js for each
 * folder in CAMOFOX_PLUGIN_PATH) and export a register(app, ctx) function.
 * The ctx object provides access to sessions, config, logging, auth middleware,
 * core functions, and an EventEmitter for lifecycle hooks.
 *
 * 29 events across 7 categories:
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
 * Returns { list: string[] | null, configs: Map<string, object> }
 */
function readPluginConfig(configPath = CONFIG_PATH) {
  const configs = new Map();
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    if (!config.plugins) return { list: null, configs };
    if (Array.isArray(config.plugins)) {
      return { list: config.plugins, configs };
    }
    if (typeof config.plugins === 'object') {
      const list = [];
      for (const [name, pluginConf] of Object.entries(config.plugins)) {
        const isObjectConfig = pluginConf && typeof pluginConf === 'object';
        if (isObjectConfig) configs.set(name, pluginConf);
        if (pluginConf === false || (isObjectConfig && pluginConf.enabled === false)) continue;
        list.push(name);
      }
      return { list, configs };
    }
  } catch {}
  return { list: null, configs };
}

/**
 * Create the plugin event bus.
 */
export function createPluginEvents() {
  const events = new EventEmitter();
  events.setMaxListeners(50); // generous for many plugins

  /**
   * Emit an event and await all listeners (including async ones).
   * Use for mutating hooks where plugins must finish before core continues.
   * Regular emit() is still used for fire-and-forget observational events.
   */
  events.emitAsync = async function emitAsync(eventName, payload) {
    const listeners = this.listeners(eventName);
    await Promise.all(listeners.map(fn => fn(payload)));
  };

  return events;
}

function pluginError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
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
 * @returns {string[]} - Names of loaded plugins
 */
export async function loadPlugins(app, ctx, options = {}) {
  const loaded = [];
  const pluginsDir = options.pluginsDir || PLUGINS_DIR;
  const pluginPaths = options.pluginPaths || ctx.config?.pluginPaths || [];
  const configPath = options.configPath || ctx.config?.configPath || CONFIG_PATH;
  const env = options.env || ctx.config?.pluginEnv || {};

  const plugins = discoverPlugins({ pluginsDir, pluginPaths }, ctx);
  const { list: allowList, configs: pluginConfigs } = readPluginConfig(configPath);

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
      if (err?.code === 'plugin_capability_conflict') throw err;
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
