/*
 * Генерация PNG-иконок из кода, без внешних зависимостей: Node.js + zlib.
 * Запуск: node tools/generate-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'assets', 'icons');

const COLORS = {
  red: [255, 59, 48],
  yellow: [255, 204, 0],
  green: [52, 199, 89],
  housing: [27, 33, 42],
  edge: [44, 53, 66],
  background: [13, 17, 23]
};

function addColor(base, glow, amount) {
  return [
    Math.min(255, Math.round(base[0] + glow[0] * amount)),
    Math.min(255, Math.round(base[1] + glow[1] * amount)),
    Math.min(255, Math.round(base[2] + glow[2] * amount))
  ];
}

function draw(size, maskable) {
  const px = Buffer.alloc(size * size * 3);
  const scale = size / 512;
  const inset = maskable ? 0.62 : 1;

  const cx = 256 * scale;
  const housing = {
    x: (256 - 80) * scale * inset,
    y: (256 - 184) * scale * inset,
    w: 160 * scale * inset,
    h: 368 * scale * inset,
    r: 64 * scale * inset
  };
  const lamps = [
    { cy: 152, color: COLORS.red },
    { cy: 256, color: COLORS.yellow },
    { cy: 360, color: COLORS.green }
  ].map((l) => ({ cy: (256 + (l.cy - 256) * inset) * scale, r: 52 * scale * inset, glow: l.color }));

  function inRounded(x, y) {
    if (x < housing.x || x > housing.x + housing.w) return false;
    if (y < housing.y || y > housing.y + housing.h) return false;
    const rx = Math.min(housing.r, housing.w / 2, housing.h / 2);
    const nx = Math.max(housing.x + rx, Math.min(x, housing.x + housing.w - rx));
    const ny = Math.max(housing.y + rx, Math.min(y, housing.y + housing.h - rx));
    return (x - nx) * (x - nx) + (y - ny) * (y - ny) <= rx * rx;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rgb = COLORS.background;
      if (inRounded(x, y)) rgb = COLORS.housing;
      for (const lamp of lamps) {
        const dx = x - cx;
        const dy = y - lamp.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= lamp.r) {
          const light = Math.max(0.35, 1 - dist / lamp.r);
          rgb = addColor([20, 24, 30], lamp.glow, 0.35 + light * 0.75);
        } else if (dist <= lamp.r * 1.45) {
          const halo = 1 - (dist - lamp.r) / (lamp.r * 0.45);
          const base = inRounded(x, y) ? COLORS.housing : COLORS.background;
          rgb = addColor(base, lamp.glow, halo * 0.28);
        }
      }
      const i = (y * size + x) * 3;
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
    }
  }
  return px;
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgb) {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // бит на канал
  ihdr[9] = 2;   // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT, { recursive: true });

const targets = [
  ['apple-touch-icon.png', 180, false],
  ['apple-touch-icon-precomposed.png', 180, false],
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true]
];

for (const [name, size, maskable] of targets) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, encodePng(size, draw(size, maskable)));
  console.log('written', path.relative(ROOT, file), size + 'x' + size);
}
