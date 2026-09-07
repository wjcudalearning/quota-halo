'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PillDisplay = api;
})(typeof window !== 'undefined' ? window : null, () => {
  const clamp = (value) => Math.max(0, Math.min(1, value));

  function tension(provider) {
    const reading = provider && provider.stale && provider.staleOf ? provider.staleOf : provider;
    if (!reading) return 0;
    if (reading.fraction != null) return clamp(Number(reading.fraction) || 0);
    if (reading.headlineRaw != null) return 1 - clamp(Number(reading.headlineRaw) || 0);
    return 0;
  }

  function choose(providers, preferredId) {
    if (!providers || !providers.length) return null;
    if (preferredId && preferredId !== 'auto') {
      const preferred = providers.find((provider) => provider.id === preferredId);
      if (preferred) return preferred;
    }
    const ok = providers.filter((provider) => provider.state === 'ok');
    if (!ok.length) return providers[0];
    return ok.reduce((a, b) => (tension(b) > tension(a) ? b : a));
  }

  function metric(provider) {
    const reading = provider && provider.stale && provider.staleOf ? provider.staleOf : provider;
    if (!reading) return { text: '\u2014', fraction: 0 };
    if (reading.kind === 'money' && Number.isFinite(Number(reading.headlineRaw))) {
      const fraction = clamp(Number(reading.headlineRaw) / 100);
      return { text: `${Math.round(fraction * 100)}%`, fraction };
    }
    return {
      text: String(reading.headline == null ? '\u2014' : reading.headline),
      fraction: reading.fraction == null ? 1 : clamp(Number(reading.fraction) || 0),
    };
  }

  return { choose, metric, tension };
});
