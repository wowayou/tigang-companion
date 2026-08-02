#!/usr/bin/env node
// 一次性开发工具:手写 PNG 编码器,生成提肛陪伴的 apple-touch-icon / manifest 图标。
// 零依赖:只用 Node 内置 zlib + Buffer,不引第三方库、不引 CDN。
// 用法:node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ───────────────────────── PNG 编码器 ─────────────────────────

/** 标准 PNG CRC32 表 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * 编码 8-bit RGB(color type 2,无 alpha 通道)PNG。
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray|Uint8Array} rgb 长度 width*height*3,逐行 RGB
 */
function encodePNG(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0: None
    rgb.copy
      ? rgb.copy(raw, rowStart + 1, y * stride, y * stride + stride)
      : raw.set(rgb.subarray(y * stride, y * stride + stride), rowStart + 1);
  }

  const idatData = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ───────────────────────── 图案光栅化 ─────────────────────────

// 照抄 icon.svg 的设计,基准画布 512。
const GRAD_START = [0x14, 0xa9, 0x9a]; // #14a99a 左上
const GRAD_END = [0x0b, 0x7d, 0x73]; // #0b7d73 右下
// linearGradient x1=0 y1=0 x2=0.35 y2=1(objectBoundingBox,基准 512 画布)
const GRAD_DX = 0.35;
const GRAD_DY = 1;
const GRAD_LEN2 = GRAD_DX * GRAD_DX + GRAD_DY * GRAD_DY;

const RINGS = [
  { r: 172, w: 14, opacity: 0.32 },
  { r: 120, w: 18, opacity: 0.62 },
  { r: 66, w: 24, opacity: 0.95 },
];
const DOT = { r: 20, opacity: 0.95 };
const WHITE = [255, 255, 255];

const BASE = 512; // 设计基准画布
const OUTER_EDGE_DESIGN = RINGS[0].r + RINGS[0].w / 2; // 179,最外环外缘半径(基准 512)

/** 计算图案缩放系数 S,使最外环外缘直径占画布的 targetDiameterFraction */
function patternScaleFor(targetDiameterFraction) {
  return (targetDiameterFraction * BASE) / (2 * OUTER_EDGE_DESIGN);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function blend(base, color, alpha) {
  return [
    base[0] * (1 - alpha) + color[0] * alpha,
    base[1] * (1 - alpha) + color[1] * alpha,
    base[2] * (1 - alpha) + color[2] * alpha,
  ];
}

/** 求归一化坐标 (u,v) ∈ [0,1]^2 处的渐变底色 */
function gradientColorAt(u, v) {
  let t = (u * GRAD_DX + v * GRAD_DY) / GRAD_LEN2;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return [
    lerp(GRAD_START[0], GRAD_END[0], t),
    lerp(GRAD_START[1], GRAD_END[1], t),
    lerp(GRAD_START[2], GRAD_END[2], t),
  ];
}

/**
 * 渲染方形铺满图标。
 * @param {number} size 输出像素尺寸
 * @param {number} patternDiameterFraction 图案(最外环外缘)占画布直径的比例
 * @param {number} supersample 超采样倍数(每边),用于抗锯齿
 */
function renderIcon(size, patternDiameterFraction, supersample = 4) {
  const S = patternScaleFor(patternDiameterFraction);
  const design2px = (size / BASE) * S; // 设计单位(基准 512)→ 实际画布像素

  const cx = size / 2;
  const cy = size / 2;

  const ringsActual = RINGS.map((ring) => ({
    r: ring.r * design2px,
    w: ring.w * design2px,
    opacity: ring.opacity,
  }));
  const dotActual = { r: DOT.r * design2px, opacity: DOT.opacity };

  const rgb = new Uint8ClampedArray(size * size * 3);
  const ss = supersample;
  const invSSArea = 1 / (ss * ss);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rAcc = 0;
      let gAcc = 0;
      let bAcc = 0;

      for (let sy = 0; sy < ss; sy++) {
        const y = py + (sy + 0.5) / ss;
        const v = y / size;
        for (let sx = 0; sx < ss; sx++) {
          const x = px + (sx + 0.5) / ss;
          const u = x / size;

          let color = gradientColorAt(u, v);

          const dx = x - cx;
          const dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);

          for (const ring of ringsActual) {
            if (Math.abs(dist - ring.r) <= ring.w / 2) {
              color = blend(color, WHITE, ring.opacity);
            }
          }
          if (dist <= dotActual.r) {
            color = blend(color, WHITE, dotActual.opacity);
          }

          rAcc += color[0];
          gAcc += color[1];
          bAcc += color[2];
        }
      }

      const idx = (py * size + px) * 3;
      rgb[idx] = rAcc * invSSArea;
      rgb[idx + 1] = gAcc * invSSArea;
      rgb[idx + 2] = bAcc * invSSArea;
    }
  }

  return rgb;
}

// ───────────────────────── 生成四个文件 ─────────────────────────

const OUTPUTS = [
  { file: 'icon-180.png', size: 180, diameterFraction: 0.76 },
  { file: 'icon-192.png', size: 192, diameterFraction: 0.76 },
  { file: 'icon-512.png', size: 512, diameterFraction: 0.76 },
  { file: 'icon-maskable-512.png', size: 512, diameterFraction: 0.6 },
];

for (const out of OUTPUTS) {
  const rgb = renderIcon(out.size, out.diameterFraction, 4);
  const png = encodePNG(out.size, out.size, Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength));
  const outPath = path.join(ROOT, out.file);
  writeFileSync(outPath, png);
  console.log(`wrote ${out.file} (${out.size}x${out.size}, ${png.length} bytes)`);
}
