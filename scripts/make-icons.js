'use strict';

/**
 * Builds the Windows app and tray assets from assets/logo-source.png.
 * The source is the approved Quota Halo master artwork; PowerShell uses
 * System.Drawing for high-quality alpha-preserving downsampling and writes a
 * PNG-backed ICO that Windows can scale cleanly for Explorer and the tray.
 */

const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.error('Quota Halo icon generation currently requires Windows PowerShell.');
  process.exit(1);
}

const script = path.join(__dirname, 'make-ico.ps1');
const result = spawnSync('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', script,
], { stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
