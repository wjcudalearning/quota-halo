'use strict';

/* Pre-package syntax ("lint") check: node --check every JS file under the
   source, renderer, scripts and tests trees. Fails the build if any would not
   parse. Run via `npm run lint`; `npm run package` runs it first. */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', 'dist', 'debug', '.git', 'research']);

function listJs(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listJs(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = listJs(ROOT, []);
const srcDir = path.join(ROOT, 'src');
// Only syntax-check files we own (skip auto-generated / vendored).
const owned = files.filter((f) => {
  const rel = path.relative(ROOT, f);
  return rel.startsWith('src' + path.sep) ||
    rel.startsWith('renderer' + path.sep) ||
    rel.startsWith('scripts' + path.sep) ||
    rel.startsWith('tests' + path.sep) ||
    rel === 'main.js';
});

let failed = 0;
for (const f of owned) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`FAIL ${path.relative(ROOT, f)}\n${r.stderr || ''}`);
    failed += 1;
  }
}

if (failed) {
  console.error(`\nSyntax check failed (${failed} file(s))`);
  process.exit(1);
}
console.log(`Syntax check OK (${owned.length} files)`);
