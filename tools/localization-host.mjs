import fs from 'node:fs';

/** Test-only host contract; gameplay remains unchanged. No network or account access. */
export async function installLocalizationHost(context, { locale, phase = 'play', audioEnabled = false }) {
  await context.addInitScript({ content: fs.readFileSync(new URL('../node_modules/nipplejs/dist/nipplejs.js', import.meta.url), 'utf8') });
  await context.addInitScript(({ locale, phase, audioEnabled }) => {
    const callbacks = {};
    const host = {
      locale, phase, audioEnabled, isPaused: false,
      ready() { window.__TEST_HOST_READY__ = true; },
      onPause(fn) { callbacks.pause = fn; return () => {}; },
      onResume(fn) { callbacks.resume = fn; return () => {}; },
      onAudioPolicyChange(fn) { callbacks.audio = fn; return () => {}; },
    };
    window.__TEST_HOST__ = { host, callbacks };
    window.playdrop = { init: async () => ({
      host,
      device: { controllerAvailability: 'ready', onControllerChange() { return () => {}; } },
      libs: { nipplejs: { load: async () => window.nipplejs } },
    }) };
  }, { locale, phase, audioEnabled });
}
