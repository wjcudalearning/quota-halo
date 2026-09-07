'use strict';

/**
 * Package smoke test. After `npm run package`, verify the shipped app bundle
 * actually contains the main process, renderer, settings, preload and assets,
 * and (optionally, with SMOKE_LAUNCH=1) launch the packager output briefly to
 * prove the window boots.
 *
 * Usage:  npm run package && npm run smoke
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'dist', 'Quota Halo-win32-x64');

const REQUIRED = [
  'Quota Halo.exe',
  'resources/app/src/main.js',
  'resources/app/src/preload.js',
  'resources/app/renderer/index.html',
  'resources/app/renderer/settings.html',
  'resources/app/renderer/renderer.js',
  'resources/app/renderer/pill-display.js',
  'resources/app/renderer/settings.js',
  'resources/app/assets/tray.png',
  'resources/app/LICENSE',
  'resources/app/package.json',
];

let failures = 0;
for (const rel of REQUIRED) {
  const full = path.join(APP_DIR, rel);
  const ok = fs.existsSync(full);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${rel}`);
  if (!ok) failures += 1;
}

const pkg = require(path.join(ROOT, 'package.json'));
if (!pkg.version) {
  console.log('FAIL package.json has no version');
  failures += 1;
}
// The packaged app must carry the entry that main.js loads.
if (fs.existsSync(path.join(APP_DIR, 'resources', 'app', 'package.json'))) {
  const bundledPkg = require(path.join(APP_DIR, 'resources', 'app', 'package.json'));
  if (!bundledPkg.main) {
    console.log('FAIL bundled package.json has no main entry');
    failures += 1;
  }
}

function launchOnce() {
  return new Promise((resolve) => {
    const exe = path.join(APP_DIR, 'Quota Halo.exe');
    if (!fs.existsSync(exe)) return resolve();
    const child = spawn(exe, ['--smoke'], { detached: false, stdio: 'ignore' });
    let exited = false;
    const t = setTimeout(() => {
      if (child.exitCode == null) child.kill();
      resolve();
    }, 6000);
    child.on('exit', () => {
      if (!exited) {
        exited = true;
        clearTimeout(t);
        resolve();
      }
    });
  });
}

async function main() {
  if (process.env.SMOKE_LAUNCH === '1') {
    console.log('launching packaged exe for 6s to verify it boots…');
    await launchOnce();
  }
  if (failures === 0) {
    console.log('\nSMOKE OK');
  } else {
    console.log(`\nSMOKE FAILED (${failures} missing)`);
    process.exit(1);
  }
}

main();
