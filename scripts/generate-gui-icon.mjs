// Generates the Actoviq GUI app icon (assets/actoviq-icon.png) with no external
// dependencies: it rasterizes the brand mark (node graph + spark on a blue→green
// rounded tile) into an RGBA buffer and encodes a PNG via zlib. Re-run with
// `node scripts/generate-gui-icon.mjs` after changing the design.
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512; // macOS DMG requires ≥512; Windows/Linux accept this too.
const px = Buffer.alloc(SIZE * SIZE * 4); // transparent RGBA

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// src-over composite of an opaque colour (r,g,b) at coverage `cov` onto pixel (x,y).
function blend(x, y, r, g, b, cov) {
  if (cov <= 0) return;
  cov = clamp(cov, 0, 1);
  const i = (y * SIZE + x) * 4;
  const da = px[i + 3] / 255;
  const outA = cov + da * (1 - cov);
  if (outA <= 0) return;
  px[i] = Math.round((r * cov + px[i] * da * (1 - cov)) / outA);
  px[i + 1] = Math.round((g * cov + px[i + 1] * da * (1 - cov)) / outA);
  px[i + 2] = Math.round((b * cov + px[i + 2] * da * (1 - cov)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

function roundedRectCoverage(x, y, cx, cy, hw, hh, radius) {
  const qx = Math.abs(x + 0.5 - cx) - (hw - radius);
  const qy = Math.abs(y + 0.5 - cy) - (hh - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const dist = outside + inside - radius;
  return clamp(0.5 - dist, 0, 1);
}

function circleCoverage(x, y, cx, cy, radius) {
  const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  return clamp(radius + 0.5 - dist, 0, 1);
}

function segmentCoverage(x, y, ax, ay, bx, by, halfWidth) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x + 0.5 - ax;
  const wy = y + 0.5 - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = clamp((wx * vx + wy * vy) / len2, 0, 1);
  const dist = Math.hypot(x + 0.5 - (ax + t * vx), y + 0.5 - (ay + t * vy));
  return clamp(halfWidth + 0.5 - dist, 0, 1);
}

// 4-point sparkle via a sub-1 superellipse (concave star).
function starCoverage(x, y, cx, cy, size) {
  const dx = Math.abs(x + 0.5 - cx);
  const dy = Math.abs(y + 0.5 - cy);
  const p = 0.62;
  const d = Math.pow(Math.pow(dx, p) + Math.pow(dy, p), 1 / p);
  return clamp(size - d + 0.5, 0, 1);
}

const C = SIZE / 2;
const sat = 58;
const nodes = [
  [C - sat, C],
  [C + sat, C],
  [C, C - sat],
  [C, C + sat],
];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // Background: diagonal blue → green inside a rounded tile.
    const tileCov = roundedRectCoverage(x, y, C, C, C - 6, C - 6, 56);
    if (tileCov > 0) {
      const t = clamp((x + y) / (SIZE * 2), 0, 1);
      const r = Math.round(75 + (106 - 75) * t);
      const g = Math.round(147 + (208 - 147) * t);
      const b = Math.round(247 + (168 - 247) * t);
      blend(x, y, r, g, b, tileCov);
    }
    // White connectors (center → satellites, leaving a gap at both ends).
    let line = 0;
    for (const [nx, ny] of nodes) {
      const dirX = Math.sign(nx - C);
      const dirY = Math.sign(ny - C);
      line = Math.max(line, segmentCoverage(x, y, C + dirX * 24, C + dirY * 24, nx - dirX * 14, ny - dirY * 14, 4));
    }
    if (line > 0) blend(x, y, 255, 255, 255, line);
    // White nodes.
    let node = circleCoverage(x, y, C, C, 16);
    for (const [nx, ny] of nodes) node = Math.max(node, circleCoverage(x, y, nx, ny, 11));
    if (node > 0) blend(x, y, 255, 255, 255, node);
    // White spark, top-right.
    const spark = starCoverage(x, y, 192, 64, 13);
    if (spark > 0) blend(x, y, 255, 255, 255, spark);
  }
}

// ── Minimal PNG encoder (RGBA, 8-bit, no interlace) ──────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'actoviq-icon.png');
writeFileSync(outPath, encodePng(SIZE, SIZE, px));
process.stdout.write(`wrote ${outPath} (${SIZE}x${SIZE})\n`);
