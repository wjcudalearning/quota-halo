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
  assert.equal(auth.management, false);
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

// ---- YAML parser robustness (P2 114) ----
test('parseCredentialsYaml: comments, inline comments, quoted spaces, empty', () => {
  const yaml = [
    '# a comment line',
    '',
    'A_KEY: sk-plain',
    'B_KEY: sk-with-#-inside # trailing',
    "C_KEY: 'value with # and spaces'",
    'D_KEY: ""',
    'E_KEY: null',
    '  F_KEY: indented value # note',
  ].join('\n');
  const p = credentials.parseCredentialsYaml(yaml);
  assert.equal(p.A_KEY, 'sk-plain');
  assert.equal(p.B_KEY, 'sk-with-#-inside');
  assert.equal(p.C_KEY, 'value with # and spaces');
  assert.equal(p.D_KEY, undefined); // empty → omitted
  assert.equal(p.E_KEY, undefined); // null → omitted
  assert.equal(p.F_KEY, 'indented value');
});

// ---- parser contract tests against fixtures (P2 117) ----
const fs = require('node:fs');
const path = require('node:path');
const FIX = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

test('openrouter parseCredits matches credits fixture', () => {
  const c = openrouter.parseCredits(FIX('openrouter-credits.json'));
  assert.equal(c.total, 40);
  assert.ok(Math.abs(c.used - 20.6338) < 0.001);
  assert.ok(Math.abs(c.remaining - 19.3662) < 0.001);
  assert.equal(c.free, false);
});

test('openrouter parseAuthKey matches auth-key fixture (limit null, no cap)', () => {
  const a = openrouter.parseAuthKey(FIX('openrouter-authkey.json'));
  assert.equal(a.limit, null);
  assert.equal(a.remaining, null);
  assert.equal(a.free, false);
  assert.equal(a.management, false);
});

async function withFetch(fetchImpl, work) {
  const saved = global.fetch;
  global.fetch = fetchImpl;
  try {
    return await work();
  } finally {
    global.fetch = saved;
  }
}

test('OpenRouter uses the current key endpoint before account credits', async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(String(url));
    if (url === openrouter.CURRENT_KEY_URL) {
      return new Response(JSON.stringify({
        data: { label: 'balance reader', is_management_key: true, is_free_tier: false, limit: null, usage: 0, limit_remaining: null },
      }), { status: 200 });
    }
    if (url === openrouter.CREDITS_URL) {
      return new Response(JSON.stringify({ data: { total_credits: 40, total_usage: 20.63 } }), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  }, async () => {
    const result = await openrouter.fetchSnapshot({ openrouterApiKey: 'sk-or-test' });
    assert.equal(result.state, 'ok');
    assert.equal(result.headline, '$19.37');
    assert.equal(result.rows.find((r) => r.k === 'Purchased').v, '$40.00');
  });
  assert.deepEqual(calls, [openrouter.CURRENT_KEY_URL, openrouter.CREDITS_URL]);
});

test('OpenRouter identifies a normal key without an account-credit scope', async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      data: { label: 'inference only', is_management_key: false, is_free_tier: false, limit: null, usage: 0, limit_remaining: null },
    }), { status: 200 });
  }, async () => {
    const result = await openrouter.fetchSnapshot({ openrouterApiKey: 'sk-or-test' });
    assert.equal(result.state, 'needsManagementKey');
    assert.equal(result.badge, 'MANAGEMENT');
  });
  assert.deepEqual(calls, [openrouter.CURRENT_KEY_URL]);
});

test('Claude OAuth uses the current token host and normalizes epoch seconds', () => {
  assert.equal(claude.OAUTH_TOKEN_URL, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(claude.usageEndpoint(), 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(claude.epochMs(1787116079), 1787116079000);
  assert.equal(claude.epochMs(1787116079567), 1787116079567);
  assert.equal(claude.epochMs('bad'), 0);
});

test('Claude Desktop usage cache selects the newest fresh sample', () => {
  const now = Date.UTC(2026, 8, 7, 8, 0, 0);
  const usage = claude.parseDesktopUsageHistory({
    version: 2,
    samples: [
      { t: now - 20 * 60 * 1000, u: { fh: 80, sd: 20 } },
      { t: now - 5 * 60 * 1000, u: { fh: 100, sd: 34 } },
    ],
  }, now);
  assert.equal(usage.updatedAtMs, now - 5 * 60 * 1000);
  assert.deepEqual(usage.windows.map((w) => [w.id, w.usedFraction]), [
    ['session', 1],
    ['weekly_all', 0.34],
  ]);
  assert.equal(claude.parseDesktopUsageHistory({ samples: [{ t: now - 2 * 60 * 60 * 1000, u: { fh: 10 } }] }, now), null);
});

test('codex windows from wham fixture invert to used', () => {
  const w = FIX('codex-wham.json');
  const used = codex.usedFromRemaining(w.rate_limit.primary_window.used_percent);
  assert.equal(used, 1); // 0 remaining → 100% used
  const weekly = codex.usedFromRemaining(w.rate_limit.secondary_window.used_percent);
  assert.ok(Math.abs(weekly - 0.28) < 0.001);
  assert.equal(codex.windowLabel(w.rate_limit.primary_window.limit_window_seconds, 'primary'), '5h limit');
  assert.equal(codex.windowLabel(w.rate_limit.secondary_window.limit_window_seconds, 'secondary'), 'Weekly limit');
});

// ---- wincred error/timeout behaviour (P2 120) ----
test('wincred: a missing credential resolves null without hanging', async () => {
  const { readCredentialManager } = require('../src/providers/wincred');
  const value = await readCredentialManager('codenotch-no-such-credential-xyz');
  assert.equal(value, null);
});
