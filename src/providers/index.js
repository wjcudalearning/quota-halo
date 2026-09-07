'use strict';

/** Provider registry, in display order. Each module exposes fetchSnapshot(settings). */
const registry = [
  require('./deepseek'),
  require('./openrouter'),
  require('./claude'),
  require('./codex'),
  require('./antigravity'),
];

const ENABLED_DEFAULTS = Object.fromEntries(registry.map((p) => [p.id, true]));

/** Providers the user has enabled, in registry order. */
function enabledProviders(settings) {
  const flags = settings.providers || {};
  return registry.filter((p) => flags[p.id] !== false);
}

async function fetchAll(settings) {
  const list = enabledProviders(settings);
  const withTimeout = (p, ms) =>
    Promise.race([
      Promise.resolve().then(() => p.fetchSnapshot(settings)),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), ms)),
    ]);
  const settled = await Promise.allSettled(list.map((p) => withTimeout(p, 22000)));
  return list.map((p, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      if (s.value && s.value.__timeout) {
        return {
          id: p.id, name: p.name, glyph: p.glyph, kind: 'usage',
          state: 'error', headline: '\u2014', fraction: null, badge: 'TIMEOUT',
          rows: [{ k: 'Provider timed out', v: 'no answer in 22s' }],
          message: 'No answer within 22s',
        };
      }
      return s.value;
    }
    return {
      id: p.id,
      name: p.name,
      glyph: p.glyph,
      kind: 'usage',
      state: 'error',
      headline: '\u2014',
      fraction: null,
      badge: 'ERR',
      rows: [{ k: 'Provider crashed', v: String((s.reason && s.reason.message) || s.reason) }],
      message: String((s.reason && s.reason.message) || s.reason),
    };
  });
}

module.exports = { registry, enabledProviders, fetchAll, ENABLED_DEFAULTS };
