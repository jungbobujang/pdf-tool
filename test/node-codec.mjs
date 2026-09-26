// 검증용 그림 codec (node에는 canvas가 없어 jpeg-js로 대신한다)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js');

/** RGBA 그림을 칸 평균으로 줄인다. */
export function shrinkRGBA(src, w, h, nw, nh) {
  const out = new Uint8Array(nw * nh * 4);
  const sx = w / nw;
  const sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0; let g = 0; let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * w + xx) * 4;
          r += src[o]; g += src[o + 1]; b += src[o + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}

export const nodeCodec = {
  decodeJpeg(bytes) {
    const d = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
    return { data: d.data, w: d.width, h: d.height };
  },
  fromRGBA(rgba, w, h) {
    return { data: rgba, w, h };
  },
  encode(hd, scale, q) {
    const w = Math.max(1, Math.round(hd.w * Math.min(1, scale)));
    const h = Math.max(1, Math.round(hd.h * Math.min(1, scale)));
    const data = w === hd.w && h === hd.h ? hd.data : shrinkRGBA(hd.data, hd.w, hd.h, w, h);
    const out = jpeg.encode({ data, width: w, height: h }, Math.round(q * 100));
    return { bytes: new Uint8Array(out.data), w, h, type: 'image/jpeg' };
  },
};

/** 사진처럼 보이는 잡음 섞인 그림 (JPEG). 잡음이 많아 잘 안 줄어드는 "무거운 사진" */
export function photoJpeg(w, h, seed, quality = 92) {
  const data = new Uint8Array(w * h * 4);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const n = (rnd() - 0.5) * 120;
      data[o] = 120 + 100 * Math.sin((x + seed * 50) / 90) + n;
      data[o + 1] = 110 + 90 * Math.cos((y + seed * 30) / 70) + n;
      data[o + 2] = 140 + 80 * Math.sin((x + y) / 110) + n;
      data[o + 3] = 255;
    }
  }
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, quality).data);
}
