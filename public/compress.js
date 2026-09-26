/*
 * 용량 줄이기 엔진. 브라우저(메인 스레드 · Web Worker)와 검증 스크립트(node)가 같은 코드를 쓴다.
 * 그림을 풀고 다시 만드는 일(codec)만 환경마다 다르게 넘겨받는다.
 *
 *   1단계 손실 없음: 다시 저장(object stream 사용)
 *   2단계 사진만 줄이기: 문서 안의 이미지를 크기(scale)·JPEG 품질(q)을 한 값 t로 묶어 이진 탐색
 *   3단계 쪽 전체를 사진으로: 자동으로 하지 않고 제안만 한다(pdf.js가 필요해 화면 쪽에서 처리)
 *
 * codec = {
 *   decodeJpeg(bytes) → handle {w, h, …}
 *   fromRGBA(rgba, w, h) → handle
 *   encode(handle, scale, q, type='image/jpeg') → {bytes, w, h}
 *   release?(handle)
 * }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.Compress = factory(root.PDFLib, root.pako);
})(typeof self !== 'undefined' ? self : this, function (PDFLib, pako) {
  'use strict';

  const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFNumber, PDFDict } = PDFLib;

  const MB = 1024 * 1024;
  const SEARCH_STEPS = 7;
  const SAMPLE = 6; // 탐색 중에는 큰 이미지 몇 장만 실제로 인코딩하고 나머지는 비율로 추정한다

  /** t(0~1) → 크기 비율과 JPEG 품질. t가 작을수록 더 줄인다. */
  const params = (t) => ({ scale: 0.35 + 0.65 * t, q: 0.4 + 0.5 * t });
  /** 쪽 전체를 사진으로 바꿀 때: t → dpi, 품질 */
  const rasterParams = (t) => ({ dpi: Math.round(60 + 90 * t), q: 0.4 + 0.45 * t });
  /** 화면에 보여 줄 예상 화질 */
  const qualityLabel = (t) => (t >= 0.66 ? '선명' : t >= 0.33 ? '보통' : '흐림');

  const cancelled = () => Object.assign(new Error('취소했어요.'), { name: 'AbortError' });
  const check = (signal) => { if (signal && signal.aborted) throw cancelled(); };

  /**
   * 목표 이하가 되는 가장 큰 t를 찾는다(estimate는 t가 클수록 크다고 가정).
   * @returns {Promise<{t:number, size:number, fits:boolean, tries:number}>}
   */
  async function searchT(estimate, target, { steps = SEARCH_STEPS, signal } = {}) {
    check(signal);
    const low = await estimate(0);
    if (low > target) return { t: 0, size: low, fits: false, tries: 1 };
    let lo = 0;
    let hi = 1;
    let best = { t: 0, size: low };
    let tries = 1;
    for (let i = 0; i < steps - 1; i++) {
      check(signal);
      const mid = (lo + hi) / 2;
      const s = await estimate(mid);
      tries++;
      if (s <= target) { lo = mid; best = { t: mid, size: s }; } else hi = mid;
    }
    return { ...best, fits: true, tries };
  }

  // ── PDF 안의 이미지 찾기 ──

  const nameOf = (v) => (v instanceof PDFName ? String(v).slice(1) : null);
  function filters(dict) {
    const f = dict.get(PDFName.of('Filter'));
    if (!f) return [];
    if (f instanceof PDFArray) return f.asArray().map(nameOf);
    return [nameOf(f)];
  }
  function colorComponents(ctx, dict) {
    let cs = dict.get(PDFName.of('ColorSpace'));
    cs = cs && ctx.lookup(cs);
    const n = nameOf(cs);
    if (n === 'DeviceRGB' || n === 'CalRGB') return 3;
    if (n === 'DeviceGray' || n === 'CalGray') return 1;
    if (cs instanceof PDFArray) {
      const kind = nameOf(cs.get(0));
      if (kind === 'ICCBased') {
        const s = ctx.lookup(cs.get(1));
        const N = s && s.dict && s.dict.get(PDFName.of('N'));
        const k = N && N.asNumber();
        if (k === 3 || k === 1) return k;
      }
      if (kind === 'CalRGB') return 3;
      if (kind === 'CalGray') return 1;
    }
    return 0; // Indexed, CMYK, Lab, Separation … 은 건너뛴다
  }
  const numOf = (ctx, dict, key) => {
    const v = dict.get(PDFName.of(key));
    const o = v && ctx.lookup(v);
    return o && typeof o.asNumber === 'function' ? o.asNumber() : null;
  };

  /**
   * 다시 넣을 수 있는 이미지를 모은다.
   * @returns {{list: Array, skipped: number, reasons: Object, imageBytes: number}}
   */
  function findImages(doc) {
    const ctx = doc.context;
    const all = ctx.enumerateIndirectObjects();
    const smaskRefs = new Set();
    for (const [, obj] of all) {
      if (obj instanceof PDFRawStream && nameOf(obj.dict.get(PDFName.of('Subtype'))) === 'Image') {
        const sm = obj.dict.get(PDFName.of('SMask'));
        if (sm) smaskRefs.add(String(sm));
      }
    }
    const list = [];
    const reasons = {};
    let skipped = 0;
    let imageBytes = 0;
    const skip = (why) => { skipped++; reasons[why] = (reasons[why] || 0) + 1; };
    for (const [ref, obj] of all) {
      if (!(obj instanceof PDFRawStream)) continue;
      const d = obj.dict;
      if (nameOf(d.get(PDFName.of('Subtype'))) !== 'Image') continue;
      if (smaskRefs.has(String(ref))) continue; // 투명도 마스크는 주인 이미지와 함께 처리
      const len = obj.getContents().length;
      imageBytes += len;
      const imageMask = d.get(PDFName.of('ImageMask'));
      if (imageMask && String(imageMask) === 'true') { skip('마스크'); continue; }
      const w = numOf(ctx, d, 'Width');
      const h = numOf(ctx, d, 'Height');
      const bpc = numOf(ctx, d, 'BitsPerComponent');
      const comps = colorComponents(ctx, d);
      const fl = filters(d);
      if (!w || !h) { skip('크기 모름'); continue; }
      if (!comps) { skip('색 공간(CMYK·Indexed 등)'); continue; }
      if (d.get(PDFName.of('Decode'))) { skip('Decode 배열'); continue; }
      let kind = null;
      if (fl.length === 1 && fl[0] === 'DCTDecode') kind = 'jpeg';
      else if (fl.length === 1 && fl[0] === 'FlateDecode' && bpc === 8) kind = 'flate';
      if (!kind) { skip(fl.length ? fl.join('+') : '압축 없음'); continue; }
      let smask = null;
      const smRef = d.get(PDFName.of('SMask'));
      if (smRef) {
        const sm = ctx.lookup(smRef);
        const smF = sm && sm.dict ? filters(sm.dict) : [];
        const smW = sm && sm.dict ? numOf(ctx, sm.dict, 'Width') : 0;
        const smH = sm && sm.dict ? numOf(ctx, sm.dict, 'Height') : 0;
        if (!(sm instanceof PDFRawStream) || numOf(ctx, sm.dict, 'BitsPerComponent') !== 8 ||
          !(smF.length === 0 || (smF.length === 1 && smF[0] === 'FlateDecode')) || !smW || !smH || sm.dict.get(PDFName.of('DecodeParms'))) {
          skip('복잡한 투명도');
          continue;
        }
        smask = { ref: smRef, stream: sm, w: smW, h: smH, flate: smF.length === 1, len: sm.getContents().length };
      }
      let predictor = 1;
      let colors = comps;
      const dp = d.get(PDFName.of('DecodeParms'));
      if (dp && kind === 'flate') {
        const dpd = ctx.lookup(dp);
        if (dpd instanceof PDFDict) {
          predictor = numOf(ctx, dpd, 'Predictor') || 1;
          colors = numOf(ctx, dpd, 'Colors') || comps;
          const cols = numOf(ctx, dpd, 'Columns') || w;
          if ((predictor !== 1 && predictor < 10) || colors !== comps || cols !== w) { skip('TIFF 예측'); continue; }
        } else { skip('DecodeParms'); continue; }
      }
      list.push({ ref, stream: obj, w, h, comps, kind, predictor, len, smask });
    }
    list.sort((a, b) => b.len - a.len);
    return { list, skipped, reasons, imageBytes };
  }

  // PNG 예측(Predictor 10~15) 되돌리기
  function unpredict(data, w, h, bpp) {
    const row = w * bpp;
    const out = new Uint8Array(row * h);
    let prev = new Uint8Array(row);
    for (let y = 0; y < h; y++) {
      const type = data[y * (row + 1)];
      const src = data.subarray(y * (row + 1) + 1, (y + 1) * (row + 1));
      const cur = out.subarray(y * row, (y + 1) * row);
      for (let x = 0; x < row; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v = src[x];
        if (type === 1) v += a;
        else if (type === 2) v += b;
        else if (type === 3) v += (a + b) >> 1;
        else if (type === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        cur[x] = v & 0xff;
      }
      prev = cur;
    }
    return out;
  }

  /** 이미지를 codec이 다룰 수 있는 handle로 푼다. */
  async function decodeImage(img, codec) {
    const raw = img.stream.getContents();
    if (img.kind === 'jpeg') return codec.decodeJpeg(raw);
    let px = pako.inflate(raw);
    if (img.predictor >= 10) px = unpredict(px, img.w, img.h, img.comps);
    const n = img.w * img.h;
    if (px.length < n * img.comps) throw new Error('이미지 데이터가 짧아요');
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += img.comps) {
      const o = i * 4;
      if (img.comps === 3) { rgba[o] = px[j]; rgba[o + 1] = px[j + 1]; rgba[o + 2] = px[j + 2]; } else { rgba[o] = rgba[o + 1] = rgba[o + 2] = px[j]; }
      rgba[o + 3] = 255;
    }
    return codec.fromRGBA(rgba, img.w, img.h);
  }

  /** 회색 한 채널 그림을 줄인다(투명도 마스크용, 칸 평균). */
  function shrinkGray(src, w, h, nw, nh) {
    const out = new Uint8Array(nw * nh);
    const sx = w / nw;
    const sy = h / nh;
    for (let y = 0; y < nh; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < nw; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let s = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += src[yy * w + xx];
        out[y * nw + x] = Math.round(s / ((y1 - y0) * (x1 - x0)));
      }
    }
    return out;
  }

  async function lossless(bytes) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const out = await doc.save({ useObjectStreams: true });
    return out.length < bytes.length ? out : bytes;
  }

  /** 탐색용 추정기: 큰 이미지 몇 장은 실제로 인코딩, 나머지는 같은 t의 화소당 크기로 추정 */
  function makeEstimator(images, baseSize, codec, { signal, onProgress } = {}) {
    const sample = images.slice(0, SAMPLE);
    const handles = new Map();
    const memo = new Map();
    const getHandle = async (img) => {
      if (!handles.has(img)) handles.set(img, await decodeImage(img, codec));
      return handles.get(img);
    };
    const total = images.reduce((s, im) => s + im.len + (im.smask ? im.smask.len : 0), 0);
    const nonImage = Math.max(0, baseSize - total);
    async function estimate(t) {
      if (memo.has(t)) return memo.get(t);
      const { scale, q } = params(t);
      let sum = 0;
      let px = 0;
      let bytes = 0;
      for (let i = 0; i < sample.length; i++) {
        check(signal);
        const img = sample[i];
        let enc;
        try {
          enc = await codec.encode(await getHandle(img), scale, q);
        } catch (e) {
          enc = { bytes: { length: img.len }, w: img.w, h: img.h };
        }
        const smaskLen = img.smask ? Math.round(img.smask.len * (scale < 1 ? scale * scale : 1)) : 0;
        sum += Math.min(img.len + (img.smask ? img.smask.len : 0), enc.bytes.length + smaskLen);
        px += img.w * img.h;
        bytes += enc.bytes.length;
      }
      const perPx = px ? bytes / px : 0;
      for (const img of images.slice(sample.length)) {
        const guess = perPx * img.w * img.h;
        sum += Math.min(img.len, guess) + (img.smask ? img.smask.len * (scale < 1 ? scale * scale : 1) : 0);
      }
      const s = Math.round(nonImage + sum);
      memo.set(t, s);
      if (onProgress) await onProgress({ phase: 'search', t, size: s });
      return s;
    }
    const release = () => { for (const hd of handles.values()) if (codec.release) codec.release(hd); handles.clear(); };
    return { estimate, release, nonImage };
  }

  /** t로 실제 이미지를 바꿔 넣고 저장한다. */
  async function applyT(baseBytes, t, codec, { signal, onProgress } = {}) {
    const doc = await PDFDocument.load(baseBytes, { updateMetadata: false });
    const { list } = findImages(doc);
    const { scale, q } = params(t);
    const ctx = doc.context;
    let changed = 0;
    for (let i = 0; i < list.length; i++) {
      check(signal);
      const img = list[i];
      if (onProgress) await onProgress({ phase: 'images', done: i, total: list.length });
      let hd;
      try {
        hd = await decodeImage(img, codec);
      } catch (e) {
        continue; // 못 읽는 그림은 그대로 둔다
      }
      let enc;
      try {
        enc = await codec.encode(hd, scale, q);
      } finally {
        if (codec.release) codec.release(hd);
      }
      let newMask = null;
      if (img.smask && (enc.w !== img.w || enc.h !== img.h)) {
        const sm = img.smask;
        const raw = sm.flate ? pako.inflate(sm.stream.getContents()) : sm.stream.getContents();
        const mw = Math.max(1, Math.round(sm.w * (enc.w / img.w)));
        const mh = Math.max(1, Math.round(sm.h * (enc.h / img.h)));
        newMask = { w: mw, h: mh, bytes: pako.deflate(shrinkGray(raw, sm.w, sm.h, mw, mh)) };
      }
      const before = img.len + (img.smask ? img.smask.len : 0);
      const after = enc.bytes.length + (newMask ? newMask.bytes.length : (img.smask ? img.smask.len : 0));
      if (after >= before) continue; // 줄여도 커지면 원본 유지
      const dict = img.stream.dict.clone(ctx);
      dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      dict.set(PDFName.of('Width'), PDFNumber.of(enc.w));
      dict.set(PDFName.of('Height'), PDFNumber.of(enc.h));
      dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      dict.delete(PDFName.of('DecodeParms'));
      dict.delete(PDFName.of('Length'));
      ctx.assign(img.ref, PDFRawStream.of(dict, enc.bytes));
      if (newMask) {
        const md = img.smask.stream.dict.clone(ctx);
        md.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
        md.set(PDFName.of('Width'), PDFNumber.of(newMask.w));
        md.set(PDFName.of('Height'), PDFNumber.of(newMask.h));
        md.delete(PDFName.of('Length'));
        ctx.assign(img.smask.ref, PDFRawStream.of(md, newMask.bytes));
      }
      changed++;
    }
    if (onProgress) await onProgress({ phase: 'save' });
    return { bytes: await doc.save({ useObjectStreams: true }), changed };
  }

  /**
   * 파일을 넣자마자 보여 줄 수치: 손실 없이 다시 저장한 크기와, 가장 세게 줄였을 때 예상 크기
   * @returns {Promise<{original, lossless, min, images, skipped, imageShare, mostlyText}>}
   */
  async function analyzePdf(bytes, codec, opts = {}) {
    const base = await lossless(bytes);
    const doc = await PDFDocument.load(base, { updateMetadata: false });
    const found = findImages(doc);
    let min = base.length;
    if (found.list.length) {
      const est = makeEstimator(found.list, base.length, codec, opts);
      try { min = Math.min(base.length, await est.estimate(0)); } finally { est.release(); }
    }
    const imageShare = base.length ? found.imageBytes / base.length : 0;
    return {
      original: bytes.length,
      lossless: base.length,
      min,
      images: found.list.length,
      skipped: found.skipped,
      reasons: found.reasons,
      imageShare,
      mostlyText: found.list.length === 0 || min > base.length * 0.8,
    };
  }

  /**
   * PDF를 target(바이트) 이하로 줄인다.
   * status: 'done'(목표 이하) | 'raster'(2단계로 부족 → 쪽을 사진으로 바꾸는 3단계 제안) | 'cannot'(줄일 사진이 없음)
   */
  async function compressPdf(bytes, target, codec, opts = {}) {
    const { signal, onProgress } = opts;
    const t0 = Date.now();
    if (onProgress) await onProgress({ phase: 'tidy' });
    const base = await lossless(bytes);
    check(signal);
    const result = (extra) => ({ original: bytes.length, ms: Date.now() - t0, ...extra, size: extra.bytes.length });
    if (base.length <= target) return result({ status: 'done', stage: 1, bytes: base });
    const doc = await PDFDocument.load(base, { updateMetadata: false });
    const found = findImages(doc);
    if (!found.list.length) {
      return result({ status: 'cannot', stage: 1, bytes: base, skipped: found.skipped, reasons: found.reasons });
    }
    const est = makeEstimator(found.list, base.length, codec, opts);
    let search;
    try {
      // 추정이 조금 빗나가도 넘지 않도록 3% 여유를 둔다.
      search = await searchT(est.estimate, target * 0.97, { signal });
    } finally {
      est.release();
    }
    let t = search.t;
    let out = await applyT(base, t, codec, opts);
    // 실제 저장 크기가 목표를 넘으면 조금씩 더 줄여 본다.
    for (let k = 0; k < 3 && out.bytes.length > target && t > 0; k++) {
      t = Math.max(0, t - 0.08 * (k + 1));
      out = await applyT(base, t, codec, opts);
    }
    if (onProgress) await onProgress({ phase: 'check' });
    const best = out.bytes.length < base.length ? out.bytes : base;
    const reached = best.length <= target;
    return result({
      status: reached ? 'done' : 'raster',
      stage: 2,
      bytes: best,
      t,
      quality: qualityLabel(t),
      changed: out.changed,
      images: found.list.length,
      skipped: found.skipped,
      reasons: found.reasons,
      tries: search.tries,
    });
  }

  /**
   * 사진 파일 하나를 target 이하로 다시 인코딩한다.
   * type: 결과 형식('image/jpeg' | 'image/webp' | 'image/png')
   */
  async function compressImage(handle, originalSize, target, codec, { type = 'image/jpeg', signal } = {}) {
    const memo = new Map();
    const enc = async (t) => {
      if (!memo.has(t)) {
        const { scale, q } = params(t);
        memo.set(t, await codec.encode(handle, scale, q, type));
      }
      return memo.get(t);
    };
    // 목표가 원래보다 크고 형식이 같으면 손대지 않는다.
    const top = await enc(1);
    if (top.bytes.length <= target) return { ...top, t: 1, reached: true, quality: qualityLabel(1) };
    const s = await searchT(async (t) => (await enc(t)).bytes.length, target, { signal });
    const r = await enc(s.t);
    return { ...r, t: s.t, reached: r.bytes.length <= target, quality: qualityLabel(s.t) };
  }

  // ── 브라우저 codec (메인 스레드 · Worker 공용) ──
  function browserCodec() {
    const hasOffscreen = typeof OffscreenCanvas !== 'undefined';
    const makeCanvas = (w, h) => {
      if (hasOffscreen) return new OffscreenCanvas(w, h);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    const toBlob = (c, type, q) => (c.convertToBlob
      ? c.convertToBlob({ type, quality: q })
      : new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('그림을 만들지 못했어요'))), type, q)));
    return {
      async decodeJpeg(bytes) {
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        return { bmp, w: bmp.width, h: bmp.height };
      },
      async fromRGBA(rgba, w, h) {
        const bmp = await createImageBitmap(new ImageData(rgba, w, h));
        return { bmp, w, h };
      },
      async fromBlob(blob) {
        const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        return { bmp, w: bmp.width, h: bmp.height };
      },
      async encode(hd, scale, q, type = 'image/jpeg') {
        const w = Math.max(1, Math.round(hd.w * Math.min(1, scale)));
        const h = Math.max(1, Math.round(hd.h * Math.min(1, scale)));
        const c = makeCanvas(w, h);
        const ctx = c.getContext('2d');
        if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(hd.bmp, 0, 0, w, h);
        const blob = await toBlob(c, type, q);
        c.width = c.height = 0;
        return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h, type: blob.type };
      },
      /** 투명한 곳이 있는가 (PNG를 JPG로 바꿔도 되는지) */
      hasAlpha(hd) {
        const w = Math.min(hd.w, 256);
        const h = Math.min(hd.h, 256);
        const c = makeCanvas(w, h);
        const ctx = c.getContext('2d');
        ctx.drawImage(hd.bmp, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
        return false;
      },
      release(hd) { if (hd && hd.bmp && hd.bmp.close) hd.bmp.close(); },
    };
  }

  return {
    MB,
    params,
    rasterParams,
    qualityLabel,
    searchT,
    findImages,
    unpredict,
    lossless,
    analyzePdf,
    compressPdf,
    compressImage,
    browserCodec,
  };
});
