// Generates cover.png (800x534) for gladys-go-transit: plain Node, no
// dependency. A commuter train on a track along a skyline, with a clock for
// the departures and a small warning sign for the alerts (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.6 + (y / H) * 0.4;
  return [90 + 40 * t, 150 - 50 * t, 210 - 40 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [50, 40, 40];
const red = [220, 70, 60];
const green = [90, 190, 120];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

// Skyline.
const city = [70, 90, 120];
for (const [x, w, h] of [
  [30, 60, 150],
  [100, 40, 210],
  [150, 70, 120],
  [235, 30, 260],
  [275, 80, 170],
  [600, 70, 190],
  [680, 50, 140],
  [740, 50, 230],
]) {
  box(x, 330 - h, x + w, 330, 4, city, 0.55);
}
box(255, 40, 259, 80, 1, city, 0.55);
// Track.
box(0, 400, W, 410, 0, [60, 60, 70]);
for (let x = 10; x < W; x += 40) box(x, 410, x + 22, 420, 2, [110, 90, 70]);
// Train: locomotive and two coaches.
const body = [235, 240, 238];
const stripe = green;
box(120, 300, 360, 398, 14, body);
box(370, 300, 560, 398, 14, body);
box(570, 290, 700, 398, 30, body);
for (const [x0, x1] of [
  [120, 360],
  [370, 560],
  [570, 700],
])
  box(x0, 360, x1, 376, 0, stripe);
for (let x = 140; x < 340; x += 50) box(x, 316, x + 34, 344, 6, [80, 110, 140]);
for (let x = 390; x < 540; x += 50) box(x, 316, x + 34, 344, 6, [80, 110, 140]);
box(610, 306, 680, 340, 10, [80, 110, 140]);
for (const x of [160, 320, 410, 520, 600, 670]) disc(x, 400, 13, dark);
// Clock.
disc(650, 120, 62, white);
disc(650, 120, 54, [245, 248, 250]);
line(650, 120, 650, 82, 7, dark);
line(650, 120, 680, 132, 7, dark);
disc(650, 120, 7, red);
// Alert sign.
for (let y = 0; y < 70; y += 1) {
  const half = y * 0.62;
  for (let x = -half; x <= half; x += 1) set(Math.round(150 + x), 60 + y, [245, 190, 60]);
}
box(146, 82, 154, 112, 2, dark);
disc(150, 121, 4.5, dark);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
