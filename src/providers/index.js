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

/** Guarantee a uniform snapshot shape so the renderer and storer never have to
    guess at a provider's fields. */
function normalize(p, r) {
  return {
    id: p.id,
    name: p.name,
    glyph: p.glyph,
    kind: r.kind || 'usage',
    state: r.state || 'error',
    fidelity: r.fidelity || 'derived',
    headline: r.headline != null ? r.headline : '\u2014',
    headlineRaw: r.headlineRaw != null ? r.headlineRaw : null,
    fraction: r.fraction != null ? r.fraction : null,
    level: r.level || 'ok',
    badge: r.badge || (r.state === 'ok' ? 'OK' : r.state.toUpperCase()),
    caption: r.caption || '',
    rows: Array.isArray(r.rows) ? r.rows : [],
    plan: r.plan,
    tier: r.tier,
    derived: !!r.derived,
    updatedAt: r.updatedAt || null,
    message: r.message || null,
    hint: r.hint || null,
  };
}

async function fetchAll(settings) {
  const list = enabledProviders(settings);
  const withCancellation = (p, ctrl, ms) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        ctrl.abort(); // genuinely cancel the in-flight request
        finish({ __timeout: true });
      }, ms);
      Promise.resolve()
        .then(() => p.fetchSnapshot(settings, ctrl.signal))
        .then((v) => finish(v))
        .catch((err) => finish({ __error: err }));
    });
  const settled = await Promise.all(list.map((p) => withCancellation(p, new AbortController(), 22000)));
  return list.map((p, i) => {
    const s = settled[i];
    if (s && s.__timeout) {
      return normalize(p, {
        state: 'error', headline: '\u2014', badge: 'TIMEOUT',
        rows: [{ k: 'Provider timed out', v: 'no answer in 22s' }],
        message: 'No answer within 22s',
      });
    }
    if (s && s.__error) {
      return normalize(p, {
        state: 'error', headline: '\u2014', badge: 'ERR',
        rows: [{ k: 'Provider crashed', v: String((s.__error && s.__error.message) || s.__error) }],
        message: String((s.__error && s.__error.message) || s.__error),
      });
    }
    return normalize(p, s);
  });
}

module.exports = { registry, enabledProviders, fetchAll, ENABLED_DEFAULTS };
