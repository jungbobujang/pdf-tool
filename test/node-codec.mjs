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

const jpegRawNode = require('../lib/jpeg-decoder.js').nodeRaw();

export const nodeCodec = {
  jpegRaw(bytes) {
    return jpegRawNode(bytes);
  },
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

/**
 * CMYK JPEG 만들기(검증용). jpeg-js 인코더를 4성분 + Adobe APP14(transform 0)로 고쳐 쓴다.
 * 포토샵처럼 값을 반전해서 저장한다(0 = 잉크 가득). cmyk: 화소마다 [C, M, Y, K] 0~255
 */
let cmykEncode = null;
export function cmykJpeg(cmyk, w, h, quality = 90) {
  if (!cmykEncode) {
    const fs = require('node:fs');
    const vm = require('node:vm');
    let src = fs.readFileSync(require.resolve('jpeg-js/lib/encoder.js'), 'utf8');
    const edit = (re, to) => {
      const next = src.replace(re, to);
      if (next === src) throw new Error(`jpeg-js 인코더 고치기 실패: ${re}`);
      src = next;
    };
    edit(/var VDU = new Array\(64\);/, 'var VDU = new Array(64);\n\tvar KDU = new Array(64);');
    edit(/writeAPP0\(\);/, 'writeAdobe();');
    edit(/function writeSOF0\(width, height\)\s*\{[\s\S]*?\n\t\t\}/, `function writeAdobe() {
			writeWord(0xFFEE); writeWord(14);
			[0x41, 0x64, 0x6F, 0x62, 0x65].forEach(writeByte);
			writeWord(100); writeWord(0); writeWord(0); writeByte(0);
		}
		function writeSOF0(width, height) {
			writeWord(0xFFC0); writeWord(20); writeByte(8);
			writeWord(height); writeWord(width); writeByte(4);
			for (var c = 1; c <= 4; c++) { writeByte(c); writeByte(0x11); writeByte(0); }
		}`);
    edit(/function writeSOS\(\)\s*\{[\s\S]*?\n\t\t\}/, `function writeSOS() {
			writeWord(0xFFDA); writeWord(14); writeByte(4);
			for (var c = 1; c <= 4; c++) { writeByte(c); writeByte(0); }
			writeByte(0); writeByte(0x3f); writeByte(0);
		}`);
    edit(/var r, g, b;/, 'var r, g, b, k;');
    edit(/var DCV=0;/, 'var DCV=0;\n\t\t\tvar DCK=0;');
    edit(/b = imageData\[ p\+\+ \];/, 'b = imageData[ p++ ];\n\t\t\t\t\tk = imageData[ p++ ];');
    edit(/YDU\[pos\] = \(\(RGB_YUV_TABLE\[r\][^\n]*\n[^\n]*\n[^\n]*/, 'YDU[pos] = (255 - r) - 128; UDU[pos] = (255 - g) - 128; VDU[pos] = (255 - b) - 128; KDU[pos] = (255 - k) - 128;');
    edit(/DCU = processDU\(UDU, fdtbl_UV, DCU, UVDC_HT, UVAC_HT\);\s*DCV = processDU\(VDU, fdtbl_UV, DCV, UVDC_HT, UVAC_HT\);/,
      'DCU = processDU(UDU, fdtbl_Y, DCU, YDC_HT, YAC_HT);\n\t\t\t\tDCV = processDU(VDU, fdtbl_Y, DCV, YDC_HT, YAC_HT);\n\t\t\t\tDCK = processDU(KDU, fdtbl_Y, DCK, YDC_HT, YAC_HT);');
    const mod = { exports: {} };
    vm.runInNewContext(src, { module: mod, Buffer, console });
    cmykEncode = mod.exports;
  }
  return new Uint8Array(cmykEncode({ data: cmyk, width: w, height: h }, quality).data);
}

/**
 * 한글(HWP)에서 흔한 이미지 형식을 모은 검증용 PDF(쪽마다 하나).
 * 각 샘플의 expect = 화면에 보일 RGB 평균(CMYK는 pdf.js와 같은 변환)
 */
export async function colorSamplesPdf({ broken = false } = {}) {
  const PDFLib = require('@cantoo/pdf-lib');
  const CompressLib = require('../public/compress.js')(PDFLib, require('pako'));
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const W = 240;
  const H = 180;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const noise = (base, amp = 40) => clamp(base + (rnd() - 0.5) * amp);
  const cmykRgb = (c, m, y, k) => { const o = [0, 0, 0]; CompressLib.cmykToRgb(c, m, y, k, o, 0); return o.map(clamp); };
  // 표본 값 배열로 만들기 (bpc 1/2/4/8/16)
  function pack(values, w, h, comps, bpc) {
    const rowBytes = Math.ceil((w * comps * bpc) / 8);
    const out = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      for (let i = 0; i < w * comps; i++) {
        const v = values[y * w * comps + i];
        if (bpc === 8) out[y * rowBytes + i] = v;
        else if (bpc === 16) { out[y * rowBytes + i * 2] = v >> 8; out[y * rowBytes + i * 2 + 1] = v & 255; } else {
          const bit = i * bpc;
          out[y * rowBytes + (bit >> 3)] |= v << (8 - bpc - (bit & 7));
        }
      }
    }
    return out;
  }
  const hex = (bytes) => PDFLib.PDFHexString.of(Buffer.from(bytes).toString('hex'));
  // 샘플 정의: 화면에 보일 RGB 평균(expect)을 함께 계산한다
  function makeSamples(ctx) {
    const S = [];
    const n = W * H;
    // RGB 8bit (기준)
    { const v = []; let s = [0, 0, 0]; for (let i = 0; i < n; i++) { const p = [noise(200), noise(90), noise(40)]; v.push(...p); p.forEach((x, c) => (s[c] += x)); }
      S.push({ name: 'RGB 8bit', dict: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }, data: pack(v, W, H, 3, 8), expect: s.map((x) => x / n) }); }
    // Indexed 1/2/4/8bit (팔레트는 RGB)
    for (const bpc of [1, 2, 4, 8]) {
      const colors = 1 << bpc;
      const pal = [];
      for (let i = 0; i < colors; i++) pal.push(clamp(40 + (200 * i) / colors), clamp(180 - (120 * i) / colors), clamp(90 + 60 * Math.sin(i)));
      const v = [];
      const s = [0, 0, 0];
      for (let i = 0; i < n; i++) { const idx = Math.floor(rnd() * colors); v.push(idx); for (let c = 0; c < 3; c++) s[c] += pal[idx * 3 + c]; }
      S.push({ name: `Indexed ${bpc}bit`, dict: { ColorSpace: [PDFLib.PDFName.of('Indexed'), PDFLib.PDFName.of('DeviceRGB'), colors - 1, hex(pal)], BitsPerComponent: bpc }, data: pack(v, W, H, 1, bpc), expect: s.map((x) => x / n) });
    }
    // CMYK Flate 8bit
    { const v = []; const s = [0, 0, 0]; for (let i = 0; i < n; i++) { const p = [noise(30), noise(150), noise(220), noise(15, 20)]; v.push(...p); cmykRgb(...p.map((x) => x / 255)).forEach((x, c) => (s[c] += x)); }
      S.push({ name: 'CMYK Flate', dict: { ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 }, data: pack(v, W, H, 4, 8), expect: s.map((x) => x / n) }); }
    // CMYK DCT (Adobe 반전 저장 + Decode [1 0 …])
    { const px = new Uint8Array(n * 4); const s = [0, 0, 0]; for (let i = 0; i < n; i++) { const p = [noise(200), noise(40), noise(60), noise(20, 20)]; px.set(p, i * 4); cmykRgb(...p.map((x) => x / 255)).forEach((x, c) => (s[c] += x)); }
      S.push({ name: 'CMYK JPEG', dct: cmykJpeg(px, W, H, 95), dict: { ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Decode: [1, 0, 1, 0, 1, 0, 1, 0] }, expect: s.map((x) => x / n) }); }
    // ICCBased N=3, N=4
    const icc3 = ctx.register(ctx.flateStream(new Uint8Array(128), { N: 3 }));
    const icc4 = ctx.register(ctx.flateStream(new Uint8Array(128), { N: 4 }));
    { const v = []; const s = [0, 0, 0]; for (let i = 0; i < n; i++) { const p = [noise(60), noise(170), noise(210)]; v.push(...p); p.forEach((x, c) => (s[c] += x)); }
      S.push({ name: 'ICCBased N=3', dict: { ColorSpace: [PDFLib.PDFName.of('ICCBased'), icc3], BitsPerComponent: 8 }, data: pack(v, W, H, 3, 8), expect: s.map((x) => x / n) }); }
    { const v = []; const s = [0, 0, 0]; for (let i = 0; i < n; i++) { const p = [noise(180), noise(20), noise(100), noise(10, 20)]; v.push(...p); cmykRgb(...p.map((x) => x / 255)).forEach((x, c) => (s[c] += x)); }
      S.push({ name: 'ICCBased N=4', dict: { ColorSpace: [PDFLib.PDFName.of('ICCBased'), icc4], BitsPerComponent: 8 }, data: pack(v, W, H, 4, 8), expect: s.map((x) => x / n) }); }
    // 회색 1bit (흑백 스캔 모양)
    { const v = []; let s = 0; for (let i = 0; i < n; i++) { const b = rnd() < 0.3 ? 1 : 0; v.push(b); s += b * 255; }
      S.push({ name: 'Gray 1bit', dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 1 }, data: pack(v, W, H, 1, 1), expect: [s / n, s / n, s / n], mayKeep: true }); }
    // 회색 16bit + Decode [1 0] (반전)
    { const v = []; let s = 0; for (let i = 0; i < n; i++) { const g = noise(60) * 257; v.push(g); s += 255 - g / 257; }
      S.push({ name: 'Gray 16bit + Decode', dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 16, Decode: [1, 0] }, data: pack(v, W, H, 1, 16), expect: [s / n, s / n, s / n] }); }
    // SMask가 있는 RGB
    { const v = []; const a = []; const s = [0, 0, 0]; for (let i = 0; i < n; i++) { const p = [noise(120), noise(200), noise(120)]; v.push(...p); a.push(noise(200, 100)); p.forEach((x, c) => (s[c] += x)); }
      S.push({ name: 'RGB + SMask', dict: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }, data: pack(v, W, H, 3, 8), smask: pack(a, W, H, 1, 8), expect: s.map((x) => x / n) }); }
    return S;
  }
  async function samplePdf(broken) {
    const doc = await PDFLib.PDFDocument.create();
    const ctx = doc.context;
    const samples = makeSamples(ctx);
    if (broken) samples.push({ name: '망가진 JPEG', dct: new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].concat(Array(5000).fill(7))), dict: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }, broken: true });
    for (const smp of samples) {
      const dict = { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ...smp.dict };
      if (smp.smask) dict.SMask = ctx.register(ctx.flateStream(smp.smask, { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
      const stream = smp.dct ? ctx.stream(smp.dct, { ...dict, Filter: 'DCTDecode' }) : ctx.flateStream(smp.data, dict);
      const ref = ctx.register(stream);
      const page = doc.addPage([W, H]);
      const nm = page.node.newXObject('Im', ref);
      page.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(W, 0, 0, H, 0, 0), PDFLib.drawObject(nm), PDFLib.popGraphicsState());
    }
    return { bytes: await doc.save(), samples };
  }
  return samplePdf(broken);
}
