'use strict';

/* Generates assets/tray.png without any native dependency: a flat RGBA
   buffer rendered by hand, encoded as PNG via node:zlib. A filled dark
   rounded square with a bright green ring so the tray glyph is visible on
   both dark and light taskbars at 16px. */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 256;
const buf = Buffer.alloc(SIZE * SIZE * 4);

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const na = a / 255;
  buf[i] = Math.round(r * na + buf[i] * (1 - na));
  buf[i + 1] = Math.round(g * na + buf[i + 1] * (1 - na));
  buf[i + 2] = Math.round(b * na + buf[i + 2] * (1 - na));
  buf[i + 3] = Math.max(buf[i + 3], a);
}

function smooth(edge, d) {
  const t = ((d - edge) + 1.0) / 2.0;
  return Math.max(0, Math.min(1, t));
}

const cx = SIZE / 2;
const cy = SIZE / 2;

// --- background rounded square (#0b0d10), radius ~ 24% ---
const R_BG = SIZE * 0.5;
const CORNER = SIZE * 0.24;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const qx = Math.max(Math.abs(dx) - (R_BG - CORNER), 0);
    const qy = Math.max(Math.abs(dy) - (R_BG - CORNER), 0);
    const d = Math.sqrt(qx * qx + qy * qy);
    const a = smooth(CORNER, d);
    if (a <= 0) continue;
    setPx(x, y, 0x0b, 0x0d, 0x10, Math.round(a * 255));
  }
}

// --- green ring (donut), radius ~ 0.30*SIZE, stroke ~ 0.10*SIZE ---
const R_OUT = SIZE * 0.30;
const TH = SIZE * 0.10;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const aOut = smooth(R_OUT + TH / 2, d);
    const aIn = 1 - smooth(R_OUT - TH / 2, d);
    const a = Math.min(aOut, aIn);
    if (a <= 0) continue;
    setPx(x, y, 0x00, 0xff, 0x88, Math.round(a * 255));
  }
}

// --- white notch tick at the very top of the ring (orientation hint) ---
const TICK_R = R_OUT;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - (cy - R_OUT);
    const d = Math.sqrt(dx * dx + dy * dy);
    const a = smooth(TH * 0.35, Math.abs(d - TICK_R * 0.0));
    const band = smooth(TH * 0.35, Math.abs(dy - 0));
    if (a <= 0 || band <= 0) continue;
    if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < R_OUT + TH) continue;
    if (Math.abs(dx) > SIZE * 0.12) continue;
    setPx(x, y, 0xff, 0xff, 0xff, Math.round(a * 200));
  }
}

// ---- minimal PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'tray.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);

// The same 256x256 drawing doubles as the app icon source (converted to .ico
// by scripts/make-ico.ps1).
const icon = path.join(__dirname, '..', 'assets', 'icon.png');
fs.writeFileSync(icon, png);
console.log(`wrote ${icon} (${png.length} bytes)`);
