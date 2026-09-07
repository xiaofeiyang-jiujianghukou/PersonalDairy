// 生成 PWA 图标(纯 Node,zlib 手写 PNG,零依赖)。
// 用法: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'apps', 'web', 'public', 'icons');

// ---------- 极简 PNG 编码器 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      raw[rowStart + 1 + x * 4] = rgba[p];
      raw[rowStart + 1 + x * 4 + 1] = rgba[p + 1];
      raw[rowStart + 1 + x * 4 + 2] = rgba[p + 2];
      raw[rowStart + 1 + x * 4 + 3] = rgba[p + 3];
    }
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制:暖色底 + 纸页卡片 + 三行文字 ----------
const BG = [185, 138, 94]; // #b98a5e
const PAGE = [255, 250, 240];
const INK = [154, 111, 71]; // #9a6f47

function inRRect(px, py, x, y, w, h, r) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function makeIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const s = size;
  const card = { x: 0.26 * s, y: 0.2 * s, w: 0.48 * s, h: 0.6 * s, r: 0.07 * s };
  const lines = [0.38, 0.5, 0.62].map((fy) => ({
    x: 0.34 * s,
    y: fy * s,
    w: 0.32 * s,
    h: Math.max(2, 0.045 * s),
  }));
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let col = BG;
      if (inRRect(x + 0.5, y + 0.5, card.x, card.y, card.w, card.h, card.r)) col = PAGE;
      for (const ln of lines) {
        if (inRRect(x + 0.5, y + 0.5, ln.x, ln.y - ln.h / 2, ln.w, ln.h, ln.h / 2)) col = INK;
      }
      const o = (y * s + x) * 4;
      rgba[o] = col[0];
      rgba[o + 1] = col[1];
      rgba[o + 2] = col[2];
      rgba[o + 3] = 255;
    }
  }
  return encodePNG(size, rgba);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'icon-512.png'), makeIcon(512));
writeFileSync(join(outDir, 'icon-192.png'), makeIcon(192));
writeFileSync(join(outDir, 'icon-180.png'), makeIcon(180));
console.log('icons written to', outDir);
