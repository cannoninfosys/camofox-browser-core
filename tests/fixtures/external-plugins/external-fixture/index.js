// Test fixture: an external plugin loaded through CAMOFOX_PLUGIN_PATH.
export async function register(app, ctx, pluginConfig) {
  app.loaded.push({ name: ctx.plugin.name, settings: pluginConfig });
}
