'use strict';

/**
 * Single packaging entry point. Version comes from package.json (never
 * hard-coded here), the app icon is assets/icon.ico, and the output lands in
 * dist/Quota Halo-win32-x64/. Run `npm run package`.
 */

const path = require('path');
const packager = require('electron-packager');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

function ignore(re) {
  return (p) => re.test(p);
}

packager({
  dir: ROOT,
  name: 'Quota Halo',
  platform: 'win32',
  arch: 'x64',
  out: path.join(ROOT, 'dist'),
  overwrite: true,
  icon: path.join(ROOT, 'assets', 'icon.ico'),
  appVersion: pkg.version,
  // Keep the shipped app lean: never bundle node_modules dev deps, the dist
  // output itself, debug artifacts, or the source scaffolding.
  ignore: ignore(/^(\/node_modules|\/dist|\/debug|\/\.git|\/research)(\/|$)/i),
  prune: true,
})
  .then((appPaths) => {
    console.log('Packaging complete:');
    for (const p of appPaths) console.log('  ' + p);
  })
  .catch((err) => {
    console.error('Packaging failed:', err);
    process.exit(1);
  });
