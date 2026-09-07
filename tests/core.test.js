'use strict';

/* Core unit tests (node:test). Run: npm test  */

const test = require('node:test');
const assert = require('node:assert');

const credentials = require('../src/credentials');
const deepseek = require('../src/providers/deepseek');
const openrouter = require('../src/providers/openrouter');
const codex = require('../src/providers/codex');
const claude = require('../src/providers/claude');
const providers = require('../src/providers');

// ---- credentials YAML parser ----
test('parseCredentialsYaml: indented keys + quoted values', () => {
  const yaml = [
    'version: 1',
    '',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-abc123',
    "  AGNES_API_KEY: 'sk-quoted'",
    '  NVIDIA_API_KEY: "nvap-xyz"',
    '  OLLAMA_API_KEY: placeholder',
  ].join('\n');
  const p = credentials.parseCredentialsYaml(yaml);
  assert.equal(p.DEEPSEEK_API_KEY, 'sk-abc123');
  assert.equal(p.AGNES_API_KEY, 'sk-quoted');
  assert.equal(p.NVIDIA_API_KEY, 'nvap-xyz');
  assert.equal(p.OLLAMA_API_KEY, 'placeholder');
});

// ---- money formatting / thresholds ----
test('deepseek money + thresholds', () => {
  assert.equal(deepseek.money(30.45, 'USD'), '$30.45');
  assert.equal(deepseek.money(0, 'USD'), '$0.00');
  assert.equal(deepseek.levelFor(30), 'ok');
  assert.equal(deepseek.levelFor(3), 'low');
  assert.equal(deepseek.levelFor(0.5), 'crit');
});

test('openrouter money + levelFor', () => {
  assert.equal(openrouter.money(19.37), '$19.37');
  assert.equal(openrouter.levelFor(19), 'ok');
  assert.equal(openrouter.levelFor(2), 'low');
  assert.equal(openrouter.levelFor(0.5), 'crit');
});

test('openrouter parseAuthKey + parseCredits (live shapes)', () => {
  // auth/key: limit null, no per-key cap
  const auth = openrouter.parseAuthKey({ data: { label: 'k', is_free_tier: false, limit: null, usage: 0, limit_remaining: null } });
  assert.equal(auth.remaining, null);
  assert.equal(auth.free, false);
  // credits: { data: { total_credits, total_usage } }
  const credits = openrouter.parseCredits({ data: { total_credits: 40, total_usage: 20.63 } });
  assert.equal(credits.free, false);
  assert.equal(credits.total, 40);
  assert.equal(credits.used, 20.63);
  assert.ok(Math.abs(credits.remaining - 19.37) < 0.001);
  // legacy shape
  const legacy = openrouter.parseCredits({ credits: { total: 40, used: 10, limit: 40 } });
  assert.equal(legacy.remaining, 30);
});

// ---- percent / remaining inversion ----
test('codex usedFromRemaining inverts remaining → used', () => {
  assert.equal(codex.usedFromRemaining(0), 1);        // 0 remaining → 100% used
  assert.equal(codex.usedFromRemaining(72), 0.28);    // 72 remaining → 28% used
  assert.equal(codex.usedFromRemaining(100), 0);      // 100 remaining → 0% used
});

test('codex windowLabel derives from seconds', () => {
  assert.equal(codex.windowLabel(18000, 'primary'), '5h limit');
  assert.equal(codex.windowLabel(604800, 'secondary'), 'Weekly limit');
  assert.equal(codex.windowLabel(2592000, 'secondary'), 'Monthly limit');
  assert.equal(codex.windowLabel(0, 'primary'), 'Current session');
});

// ---- reset time formatting ----
test('claude fmtReset: absolute clock for future, empty for none', () => {
  const now = Date.now();
  const rel = claude.fmtReset(now + 5 * 60 * 1000);
  assert.ok(typeof rel === 'string' && rel.length > 0, 'returns a time string');
  const abs = claude.fmtReset(now + 30 * 24 * 3600 * 1000);
  assert.ok(typeof abs === 'string' && abs.length > 0);
  assert.equal(claude.fmtReset(null), '');
});

// ---- stale cache ----
test('applyStale attaches last good reading only for non-ok', () => {
  const cache = new Map();
  const ok = { id: 'codex', state: 'ok', headline: '10%', updatedAt: 't1' };
  const results = providers.applyStale([ok], cache);
  assert.equal(results[0].state, 'ok');
  assert.equal(cache.get('codex').headline, '10%');
  const bad = { id: 'codex', state: 'error', headline: '\u2014' };
  const after = providers.applyStale([bad], cache);
  assert.equal(after[0].stale, true);
  assert.ok(after[0].staleOf && after[0].staleOf.headline === '10%');
  const fresh = { id: 'claude', state: 'needsAuth' };
  const noCache = providers.applyStale([fresh], new Map());
  assert.equal(noCache[0].staleOf, undefined);
});

// ---- provider enable flags / normalize ----
test('enabledProviders respects flags', () => {
  const all = providers.enabledProviders({});
  assert.equal(all.length, 5);
  const some = providers.enabledProviders({ providers: { claude: false, openrouter: false } });
  assert.deepEqual(some.map((p) => p.id).sort(), ['antigravity', 'codex', 'deepseek']);
});

test('normalize fills a uniform snapshot shape', () => {
  const n = providers.normalize({ id: 'x', name: 'X', glyph: 'X' }, { state: 'ok', headline: '$1', fidelity: 'official' });
  assert.equal(n.id, 'x');
  assert.equal(n.state, 'ok');
  assert.equal(n.headline, '$1');
  assert.equal(n.kind, 'usage');
  assert.ok(Array.isArray(n.rows));
  assert.ok(Array.isArray(n.windows));
  assert.equal(n.fidelity, 'official');
});
