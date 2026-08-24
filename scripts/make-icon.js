#!/usr/bin/env node
/**
 * Generates assets/icon.png (256x256), assets/tray.png (32x32) and
 * assets/icon.ico (multi-size, for the Windows shortcut) from scratch.
 * Pure Node — no image dependencies. Draws a rounded gradient tile with a
 * two-way arrow glyph, supersampled 4x4 for smooth edges.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');

// ---------------------------------------------------------------- geometry --
// All shapes are defined on a 256x256 design grid and scaled to the target.

const PAD = 6;
const RADIUS = 56;

function inRoundedRect(x, y) {
  const min = PAD;
  const max = 256 - PAD;
  if (x < min || y < min || x > max || y > max) return false;
  const cx = Math.min(Math.max(x, min + RADIUS), max - RADIUS);
  const cy = Math.min(Math.max(y, min + RADIUS), max - RADIUS);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

// An arrow lying flat: shaft rectangle plus a triangular head.
// dir = +1 points right (head at x1), dir = -1 points left (head at x0).
function inArrow(x, y, x0, x1, cy, half, headLen, headHalf, dir) {
  const headBase = dir > 0 ? x1 - headLen : x0 + headLen;
  const tip = dir > 0 ? x1 : x0;

  // shaft
  const shaftFrom = dir > 0 ? x0 : headBase;
  const shaftTo = dir > 0 ? headBase : x1;
  if (x >= shaftFrom && x <= shaftTo && Math.abs(y - cy) <= half) return true;

  // head
  const within = dir > 0 ? x >= headBase && x <= tip : x >= tip && x <= headBase;
  if (!within) return false;
  const t = Math.abs(x - headBase) / headLen; // 0 at base, 1 at tip
  return Math.abs(y - cy) <= headHalf * (1 - t);
}

function inGlyph(x, y) {
  // upper arrow -> right, lower arrow -> left
  if (inArrow(x, y, 62, 196, 104, 11, 30, 30, +1)) return true;
  if (inArrow(x, y, 60, 194, 152, 11, 30, 30, -1)) return true;
  return false;
}

// ------------------------------------------------------------------ colors --

const TOP = [34, 211, 238];   // cyan-400
const BOT = [59, 130, 246];   // blue-500

function background(y) {
  const t = Math.min(Math.max(y / 256, 0), 1);
  return [
    Math.round(TOP[0] + (BOT[0] - TOP[0]) * t),
    Math.round(TOP[1] + (BOT[1] - TOP[1]) * t),
    Math.round(TOP[2] + (BOT[2] - TOP[2]) * t),
  ];
}

// ------------------------------------------------------------------ raster --

const SAMPLES = 4; // per axis

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = 256 / size;
  const step = 1 / SAMPLES;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tileCov = 0;
      let glyphCov = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) * step) * scale;
          const y = (py + (sy + 0.5) * step) * scale;
          if (inRoundedRect(x, y)) {
            tileCov++;
            if (inGlyph(x, y)) glyphCov++;
          }
        }
      }

      const total = SAMPLES * SAMPLES;
      const alpha = tileCov / total;
      const i = (py * size + px) * 4;

      if (alpha === 0) {
        buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0;
        continue;
      }

      const bg = background(py * scale);
      const g = glyphCov / Math.max(tileCov, 1); // glyph share of covered area
      buf[i] = Math.round(bg[0] + (255 - bg[0]) * g);
      buf[i + 1] = Math.round(bg[1] + (255 - bg[1]) * g);
      buf[i + 2] = Math.round(bg[2] + (255 - bg[2]) * g);
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

// -------------------------------------------------------------- png writer --

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------- ico writer --

/**
 * Windows .ico container. Since Vista an entry may hold a PNG verbatim, which
 * saves writing a DIB encoder — the shortcut needs several sizes so Explorer
 * can pick one per view mode.
 */
function toIco(sizes) {
  const images = sizes.map((size) => ({ size, data: toPng(render(size), size) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(images.length, 4);

  const dirSize = 16 * images.length;
  let offset = header.length + dirSize;

  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;         // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;                              // palette colours
    e[3] = 0;                              // reserved
    e.writeUInt16LE(1, 4);                 // colour planes
    e.writeUInt16LE(32, 6);                // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// -------------------------------------------------------------------- main --

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size] of [['icon.png', 256], ['tray.png', 32]]) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, toPng(render(size), size));
  console.log(`[icon] wrote ${file} (${size}x${size})`);
}

const icoPath = path.join(OUT_DIR, 'icon.ico');
fs.writeFileSync(icoPath, toIco([16, 32, 48, 64, 128, 256]));
console.log(`[icon] wrote ${icoPath} (16-256)`);
