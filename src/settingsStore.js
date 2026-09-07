'use strict';

const fs = require('fs');
const path = require('path');

/** Tiny JSON preference store in Electron's userData dir. */
function defaults() {
  return {
    edge: 'top',                 // 'top' | 'bottom'
    refreshSeconds: 60,          // idle poll interval
    keyName: 'DEEPSEEK_API_KEY', // env/ref name inside the credentials file
    credentialsPath: '',         // '' → default (~/.dsh/.credentials.yaml)
    pinned: false,               // card pinned open instead of hover-expand
    launchAtLogin: false,
    notchPos: null,              // {x,y,displayId} remembered notch position
    locale: 'zh-TW',             // 'zh-TW' | 'en'
  };
}

function load(file) {
  const d = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...d, ...raw };
  } catch {
    return d;
  }
}

function save(file, settings) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('settings save failed', err);
  }
}

module.exports = { defaults, load, save };
