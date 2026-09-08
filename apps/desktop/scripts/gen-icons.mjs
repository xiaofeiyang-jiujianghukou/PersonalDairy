import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

// 最小 PNG 编码器(无依赖):生成一个圆角矩形 + 简单对勾的"日记"图标。
// 桌面应用壳需要 bundle.icon 指向的真实文件才能 `tauri build`。

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
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(w, h, rgbaAt) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 每行前置 filter byte 0
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = rgbaAt(x, y, w, h);
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function design(x, y, w, h) {
  const cx = x / w;
  const cy = y / h;
  // 圆角矩形背景(奶油色纸张感)
  const inCard =
    x >= w * 0.18 && x <= w * 0.82 && y >= h * 0.12 && y <= h * 0.88 &&
    (Math.abs(x - w * 0.18) <= w * 0.08 || Math.abs(x - w * 0.82) <= w * 0.08 ||
      Math.abs(y - h * 0.12) <= h * 0.08 || Math.abs(y - h * 0.88) <= h * 0.08 ||
      (x > w * 0.18 && x < w * 0.82 && y > h * 0.12 && y < h * 0.88));
  // 一条对角线笔触(橙色)
  const onStroke = Math.abs((cx - 0.3) * 0.6 - (cy - 0.35) * 0.6) < 0.05 && cx > 0.25 && cx < 0.8 && cy > 0.25 && cy < 0.75;
  if (onStroke) return [231, 111, 81, 255];
  if (inCard) return [250, 247, 240, 255];
  return [0, 0, 0, 0];
}

const outDir = path.resolve(process.cwd(), 'src-tauri/icons');
fs.mkdirSync(outDir, { recursive: true });
const sizes = [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256]];
for (const [name, s] of sizes) {
  fs.writeFileSync(path.join(outDir, name), png(s, s, design));
  console.log('icon written:', path.join('src-tauri/icons', name));
}
