#!/usr/bin/env node
'use strict';

/**
 * Generates build/icon.png (512×512, macOS minimum) + build/icon.ico (256×256, ICO maximum) from
 * scratch (no deps). The icon is a rounded
 * accent-coloured square with a diagonal highlight — not pretty, but far better than Electron's
 * default placeholder. Replace build/icon.* with your real artwork any time; electron-builder
 * picks either up by convention.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PNG_SIZE = 512;
const ICO_SIZE = 256;
const BG = [25, 113, 194, 255];       // #1971c2 — TabSolo brand, same as the website's mark
const INK = [255, 255, 255];          // white — the letter
const HI = [255, 255, 255, 36];       // soft diagonal highlight

/** Writes a solid-rounded-square RGBA pixel buffer with a diagonal highlight overlay. */
function makePixels(SIZE) {
  // Geometry is designed on a 256 grid and scaled to the requested size.
  const k = SIZE / 256;
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const radius = 48 * k;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Rounded-square alpha mask: inside the shape when distance from the nearest corner > radius,
      // or anywhere else; fully transparent outside the inset.
      let a = 255;
      const dx = x < radius ? radius - x : x > SIZE - radius - 1 ? x - (SIZE - radius - 1) : 0;
      const dy = y < radius ? radius - y : y > SIZE - radius - 1 ? y - (SIZE - radius - 1) : 0;
      if (dx > 0 && dy > 0) {
        const d = Math.sqrt(dx * dx + dy * dy);
        a = d > radius ? 0 : Math.round(255 * (1 - (d / radius) ** 3));
      }
      // Diagonal highlight: brighter near the top-left, fading to the bottom-right.
      const t = (x + y) / (SIZE * 2);
      const r = Math.round(BG[0] + (HI[0] - BG[0]) * (1 - t) * (HI[3] / 255));
      const g = Math.round(BG[1] + (HI[1] - BG[1]) * (1 - t) * (HI[3] / 255));
      const b = Math.round(BG[2] + (HI[2] - BG[2]) * (1 - t) * (HI[3] / 255));
      const i = (y * SIZE + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = Math.round(a * (BG[3] / 255));
    }
  }
  // Overlay a bold white letter "T" (TabSolo mark) centred, 160×140.
  const letterTop = 72 * k, letterLeft = 70 * k, letterRight = 186 * k, letterStemLeft = 115 * k, letterStemRight = 141 * k, letterBottom = 192 * k;
  const barThickness = 22 * k;
  const letterA = 240;
  for (let y = letterTop; y < letterBottom; y++) {
    for (let x = letterLeft; x < letterRight; x++) {
      const inBar = y < letterTop + barThickness;
      const inStem = y >= letterTop + barThickness && x >= letterStemLeft && x < letterStemRight;
      if (!inBar && !inStem) continue;
      const i = (y * SIZE + x) * 4;
      // Soft mix so the mark reads as part of the mark, not a flat label.
      buf[i] = Math.round(buf[i] + (INK[0] - buf[i]) * (letterA / 255));
      buf[i + 1] = Math.round(buf[i + 1] + (INK[1] - buf[i + 1]) * (letterA / 255));
      buf[i + 2] = Math.round(buf[i + 2] + (INK[2] - buf[i + 2]) * (letterA / 255));
    }
  }
  return buf;
}

/** Writes a minimal PNG from an RGBA pixel buffer. */
function pixelsToPNG(pixels, width, height) {
  // Image data: one filter byte (0 = none) per row, then RGBA.
  const scan = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    scan[y * (1 + width * 4)] = 0;
    pixels.copy(scan, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(scan, { level: 9 });

  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/** Wraps one PNG into a .ico container. Windows accepts PNG-encoded icons in ICO since Vista. */
function pngToICO(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0;   // width 256 -> 0
  entry[1] = 0;   // height 256 -> 0
  entry[2] = 0;   // palette
  entry[3] = 0;   // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = pixelsToPNG(makePixels(PNG_SIZE), PNG_SIZE, PNG_SIZE);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), pngToICO(pixelsToPNG(makePixels(ICO_SIZE), ICO_SIZE, ICO_SIZE)));
process.stdout.write(`Wrote ${outDir}/icon.png (${png.length} bytes) and ${outDir}/icon.ico\n`);
