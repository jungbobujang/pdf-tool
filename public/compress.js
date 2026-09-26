/*
 * 용량 줄이기 엔진. 브라우저(메인 스레드 · Web Worker)와 검증 스크립트(node)가 같은 코드를 쓴다.
 * 그림을 풀고 다시 만드는 일(codec)만 환경마다 다르게 넘겨받는다.
 *
 *   1단계 손실 없음: 다시 저장(object stream. PDF/A-1이면 object stream 없이)
 *   2단계 사진만 줄이기: 큰 사진부터 줄이고 목표에 닿으면 나머지는 원본 그대로 둔다(화질 우선).
 *                       크기(scale)·JPEG 품질(q)은 한 값 t로 묶어 이진 탐색, 결과는 목표의 85~100%를 노린다.
 *   3단계 쪽 전체를 사진으로: 자동으로 하지 않고 제안만 한다(pdf.js가 필요해 화면 쪽에서 처리)
 *
 * 한글(HWP) 등에서 만든 PDF의 여러 이미지 형식을 읽는다:
 *   DCT(JPEG) Gray/RGB/CMYK(Adobe 반전 · Decode 배열), Flate Gray/RGB/CMYK/Indexed(1·2·4·8·16bit),
 *   ICCBased(N=1/3/4), Decode 배열, PNG 예측, SMask(같은 크기로 함께 줄임).
 *   JBIG2 · CCITT · 1bit 마스크는 "이미 작은 흑백 이미지"라 건드리지 않는다.
 *   사진 하나가 실패해도 그 사진만 원본으로 두고 이유별로 센다.
 *
 * codec = {
 *   decodeJpeg(bytes) → handle {w, h, …}          (브라우저 기본 디코더: 회색 · RGB JPEG)
 *   jpegRaw(bytes) → {w, h, comps, data}           (JS 디코더: CMYK · Decode 배열이 있는 JPEG)
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

  const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFNumber, PDFDict, PDFString, PDFHexString } = PDFLib;

  const MB = 1024 * 1024;
  const SEARCH_STEPS = 7;
  const SAMPLE = 8; // 탐색 중에는 큰 사진 몇 장만 실제로 인코딩하고 나머지는 비율로 추정한다
  const MAX_PIXELS = 40e6; // 이보다 큰 사진은 메모리를 아끼려고 건너뛴다

  /** t(0~1) → 크기 비율과 JPEG 품질. t가 작을수록 더 줄인다. */
  // t가 1보다 크면(최대 1.16) 원래 크기 그대로 품질만 0.95~0.98로 더 높인다(목표에 가깝게 채울 때)
  const params = (t) => ({ scale: Math.min(1, 0.35 + 0.65 * t), q: Math.min(0.98, 0.4 + 0.5 * t) });
  /** 쪽 전체를 사진으로 바꿀 때: t → dpi, 품질 */
  const rasterParams = (t) => ({ dpi: Math.round(60 + 90 * t), q: 0.4 + 0.45 * t });
  /** 화면에 보여 줄 예상 화질 */
  const qualityLabel = (t) => (t >= 0.66 ? '선명' : t >= 0.33 ? '보통' : '흐림');

  const cancelled = () => Object.assign(new Error('취소했어요.'), { name: 'AbortError' });
  const check = (signal) => { if (signal && signal.aborted) throw cancelled(); };

  // 건너뛴 이유 (화면에 그대로 보여 준다)
  const R = {
    mono: '이미 작은 흑백 이미지',
    jpx: 'JPEG 2000',
    space: '지원하지 않는 색 공간',
    colorKey: '색 키 마스크',
    matte: '특수 투명도(Matte)',
    huge: '너무 큰 사진',
    filter: '지원하지 않는 압축',
    broken: '읽지 못한 사진(손상)',
    cmykNoAdobe: 'CMYK JPEG(표식 없음)',
  };

  /**
   * 목표 이하가 되는 가장 큰 t를 찾는다(estimate는 t가 클수록 크다고 가정).
   * @returns {Promise<{t:number, size:number, fits:boolean, tries:number}>}
   */
  async function searchT(estimate, target, { steps = SEARCH_STEPS, signal } = {}) {
    check(signal);
    const low = await estimate(0);
    if (low > target) return { t: 0, size: low, fits: false, tries: 1 };
    const top = await estimate(1);
    if (top <= target) return { t: 1, size: top, fits: true, tries: 2 };
    let lo = 0;
    let hi = 1;
    let best = { t: 0, size: low };
    let tries = 2;
    for (let i = 0; i < steps - 2; i++) {
      check(signal);
      const mid = (lo + hi) / 2;
      const s = await estimate(mid);
      tries++;
      if (s <= target) { lo = mid; best = { t: mid, size: s }; } else hi = mid;
    }
    return { ...best, fits: true, tries };
  }

  /** PDF/A-1 문서는 object stream을 쓸 수 없다 → 없이 저장 */
  async function safeSave(doc, opts = {}) {
    try {
      return await doc.save({ useObjectStreams: true, ...opts });
    } catch (e) {
      if (/object and cross-reference streams|PDF\/A/i.test(String(e && e.message))) {
        return doc.save({ ...opts, useObjectStreams: false });
      }
      throw e;
    }
  }

  // ── pdf.js와 같은 CMYK → RGB 근사(DeviceCMYK) ──
  function cmykToRgb(c, m, y, k, out, o) {
    out[o] = 255 + c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k + -285.2331026137004) +
      m * (1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k - 5.497006427196366) +
      y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) + k * (-21.86122147463605 * k - 189.48180835922747);
    out[o + 1] = 255 + c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k + -79.2970844816548) +
      m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) +
      y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) + k * (-20.737325471181034 * k - 187.80453709719578);
    out[o + 2] = 255 + c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k + -14.183576799673286) +
      m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) +
      y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505) + k * (-22.33816807309886 * k - 180.12613974708367);
  }

  // ── PDF 안의 이미지 찾기 ──

  const nameOf = (v) => (v instanceof PDFName ? String(v).slice(1) : null);
  function filters(dict) {
    const f = dict.get(PDFName.of('Filter'));
    if (!f) return [];
    if (f instanceof PDFArray) return f.asArray().map(nameOf);
    return [nameOf(f)];
  }
  const numOf = (ctx, dict, key) => {
    const v = dict.get(PDFName.of(key));
    const o = v && ctx.lookup(v);
    return o && typeof o.asNumber === 'function' ? o.asNumber() : null;
  };
  const numsOf = (ctx, v) => {
    const a = v && ctx.lookup(v);
    return a instanceof PDFArray ? a.asArray().map((x) => ctx.lookup(x).asNumber()) : null;
  };

  /** 색 공간 → {type:'gray'|'rgb'|'cmyk'|'indexed', n, base?, hival?, lookup?} 또는 null(지원 안 함) */
  function colorSpace(ctx, csRaw) {
    const cs = csRaw && ctx.lookup(csRaw);
    const n = nameOf(cs);
    if (n === 'DeviceGray' || n === 'CalGray' || n === 'G') return { type: 'gray', n: 1 };
    if (n === 'DeviceRGB' || n === 'CalRGB' || n === 'RGB') return { type: 'rgb', n: 3 };
    if (n === 'DeviceCMYK' || n === 'CMYK') return { type: 'cmyk', n: 4 };
    if (cs instanceof PDFArray) {
      const kind = nameOf(ctx.lookup(cs.get(0)));
      if (kind === 'ICCBased') {
        const s = ctx.lookup(cs.get(1));
        const N = s && s.dict && numOf(ctx, s.dict, 'N');
        if (N === 1) return { type: 'gray', n: 1 };
        if (N === 3) return { type: 'rgb', n: 3 };
        if (N === 4) return { type: 'cmyk', n: 4 };
        const alt = s && s.dict && s.dict.get(PDFName.of('Alternate'));
        return alt ? colorSpace(ctx, alt) : null;
      }
      if (kind === 'CalRGB') return { type: 'rgb', n: 3 };
      if (kind === 'CalGray') return { type: 'gray', n: 1 };
      if (kind === 'Indexed' || kind === 'I') {
        const base = colorSpace(ctx, cs.get(1));
        if (!base || base.type === 'indexed') return null;
        const hival = ctx.lookup(cs.get(2)).asNumber();
        const lk = ctx.lookup(cs.get(3));
        let lookup = null;
        if (lk instanceof PDFString || lk instanceof PDFHexString) lookup = lk.asBytes();
        else if (lk instanceof PDFRawStream) lookup = streamBytes(lk);
        if (!lookup) return null;
        return { type: 'indexed', n: 1, base, hival, lookup };
      }
    }
    return null; // Separation, DeviceN, Lab, Pattern …
  }

  /** 스트림을 풀어 날 바이트로(Flate 또는 압축 없음만) */
  function streamBytes(stream) {
    const fl = filters(stream.dict);
    const raw = stream.getContents();
    if (!fl.length) return raw;
    if (fl.length === 1 && fl[0] === 'FlateDecode') return pako.inflate(raw);
    throw new Error(`풀 수 없는 압축 ${fl.join('+')}`);
  }

  /** 이미지 스트림 하나를 살펴 다시 넣을 수 있는지 판단 */
  function inspectImage(ctx, stream) {
    const d = stream.dict;
    const w = numOf(ctx, d, 'Width');
    const h = numOf(ctx, d, 'Height');
    const fl = filters(d);
    const imageMask = d.get(PDFName.of('ImageMask'));
    if (imageMask && String(imageMask) === 'true') return { skip: R.mono };
    if (fl.some((f) => f === 'JBIG2Decode' || f === 'CCITTFaxDecode')) return { skip: R.mono };
    if (fl.includes('JPXDecode')) return { skip: R.jpx };
    if (!w || !h) return { skip: R.broken };
    if (w * h > MAX_PIXELS) return { skip: R.huge };
    let kind;
    if (fl.length === 1 && fl[0] === 'DCTDecode') kind = 'jpeg';
    else if (fl.length === 0 || (fl.length === 1 && fl[0] === 'FlateDecode')) kind = 'flate';
    else return { skip: R.filter };
    const cs = colorSpace(ctx, d.get(PDFName.of('ColorSpace')));
    if (!cs) return { skip: R.space };
    const maskRaw = d.get(PDFName.of('Mask'));
    if (maskRaw && ctx.lookup(maskRaw) instanceof PDFArray) return { skip: R.colorKey };
    const bpc = numOf(ctx, d, 'BitsPerComponent') || 8;
    if (![1, 2, 4, 8, 16].includes(bpc)) return { skip: R.filter };
    const decode = numsOf(ctx, d.get(PDFName.of('Decode')));
    let predictor = 1;
    let colors = cs.n;
    let columns = w;
    const dp = d.get(PDFName.of('DecodeParms'));
    if (dp && kind === 'flate') {
      const dpd = ctx.lookup(dp);
      if (!(dpd instanceof PDFDict)) return { skip: R.filter };
      predictor = numOf(ctx, dpd, 'Predictor') || 1;
      colors = numOf(ctx, dpd, 'Colors') || cs.n;
      columns = numOf(ctx, dpd, 'Columns') || w;
      if ((predictor !== 1 && predictor < 10) || colors !== cs.n || columns !== w) return { skip: R.filter };
    }
    const info = { w, h, kind, cs, bpc, decode, predictor };
    // 회색 · RGB JPEG이고 Decode 배열이 없으면 브라우저 기본 디코더로(빠르다)
    info.native = kind === 'jpeg' && (cs.type === 'gray' || cs.type === 'rgb') && !decode;
    return info;
  }

  /**
   * 다시 넣을 수 있는 이미지를 모은다(큰 것부터).
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
      if (nameOf(obj.dict.get(PDFName.of('Subtype'))) !== 'Image') continue;
      if (smaskRefs.has(String(ref))) continue; // 투명도 마스크는 주인 이미지와 함께 처리
      const len = obj.getContents().length;
      imageBytes += len;
      let info;
      try { info = inspectImage(ctx, obj); } catch (e) { info = { skip: R.broken }; }
      if (info.skip) { skip(info.skip); continue; }
      let smask = null;
      const smRef = obj.dict.get(PDFName.of('SMask'));
      if (smRef) {
        const sm = ctx.lookup(smRef);
        if (!(sm instanceof PDFRawStream)) { skip(R.broken); continue; }
        if (sm.dict.get(PDFName.of('Matte'))) { skip(R.matte); continue; }
        // SMask는 회색 한 채널(1~16bit, 압축 없음 · Flate · DCT)
        const smFl = filters(sm.dict);
        const smBpc = numOf(ctx, sm.dict, 'BitsPerComponent') || 8;
        if (!(smFl.length === 0 || (smFl.length === 1 && (smFl[0] === 'FlateDecode' || smFl[0] === 'DCTDecode'))) || ![1, 2, 4, 8, 16].includes(smBpc)) {
          skip(R.filter);
          continue;
        }
        const w = numOf(ctx, sm.dict, 'Width');
        const h = numOf(ctx, sm.dict, 'Height');
        smask = {
          ref: smRef, stream: sm, len: sm.getContents().length, w, h,
          kind: smFl.length === 1 && smFl[0] === 'DCTDecode' ? 'jpeg' : 'flate',
          cs: { type: 'gray', n: 1 },
          bpc: numOf(ctx, sm.dict, 'BitsPerComponent') || 8,
          decode: numsOf(ctx, sm.dict.get(PDFName.of('Decode'))),
          predictor: (() => { const dp = sm.dict.get(PDFName.of('DecodeParms')); const dpd = dp && ctx.lookup(dp); return dpd instanceof PDFDict ? numOf(ctx, dpd, 'Predictor') || 1 : 1; })(),
        };
      }
      list.push({ ref, key: String(ref), stream: obj, len, total: len + (smask ? smask.len : 0), smask, ...info });
    }
    list.sort((a, b) => b.total - a.total);
    return { list, skipped, reasons, imageBytes };
  }

  // PNG 예측(Predictor 10~15) 되돌리기. bpp: 화소당 바이트(1 이상), rowBytes: 한 줄 바이트
  function unpredict(data, rowBytes, h, bpp) {
    const out = new Uint8Array(rowBytes * h);
    let prev = new Uint8Array(rowBytes);
    for (let y = 0; y < h; y++) {
      const type = data[y * (rowBytes + 1)];
      const src = data.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
      const cur = out.subarray(y * rowBytes, (y + 1) * rowBytes);
      for (let x = 0; x < rowBytes; x++) {
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

  /**
   * 날 표본(bpc 비트, 성분 n개)을 RGBA 8bit로. Decode 배열과 색 공간(회색 · RGB · CMYK · Indexed)을 반영한다.
   * gray: 한 채널 결과만 원하면 true(투명도 마스크용) → Uint8Array(w*h)
   */
  function samplesToRGBA(px, w, h, info, grayOnly) {
    const { cs, bpc } = info;
    const n = cs.n;
    const rowBytes = Math.ceil((w * n * bpc) / 8);
    if (px.length < rowBytes * h) throw new Error('이미지 데이터가 짧아요');
    const maxV = (1 << Math.min(bpc, 16)) - 1;
    const dec = info.decode;
    const out = grayOnly ? new Uint8Array(w * h) : new Uint8ClampedArray(w * h * 4);
    const comp = new Float64Array(4);
    const rgb = new Float64Array(3);
    const readAt = (row, idx) => {
      if (bpc === 8) return px[row + idx];
      if (bpc === 16) return (px[row + idx * 2] << 8) | px[row + idx * 2 + 1];
      const bit = idx * bpc;
      const byte = px[row + (bit >> 3)];
      return (byte >> (8 - bpc - (bit & 7))) & maxV;
    };
    const base = cs.type === 'indexed' ? cs.base : null;
    for (let y = 0; y < h; y++) {
      const row = y * rowBytes;
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (cs.type === 'indexed') {
          let raw = readAt(row, x);
          if (dec) raw = Math.round(dec[0] + (raw * (dec[1] - dec[0])) / maxV);
          const idx = Math.max(0, Math.min(cs.hival, raw)) * base.n;
          for (let c = 0; c < base.n; c++) comp[c] = (cs.lookup[idx + c] || 0) / 255;
        } else {
          for (let c = 0; c < n; c++) {
            let v = readAt(row, x * n + c) / maxV;
            if (dec) v = dec[2 * c] + v * (dec[2 * c + 1] - dec[2 * c]);
            comp[c] = v;
          }
        }
        const kind = base ? base.type : cs.type;
        if (kind === 'gray') { rgb[0] = rgb[1] = rgb[2] = comp[0] * 255; } else if (kind === 'rgb') { rgb[0] = comp[0] * 255; rgb[1] = comp[1] * 255; rgb[2] = comp[2] * 255; } else cmykToRgb(comp[0], comp[1], comp[2], comp[3], rgb, 0);
        if (grayOnly) { out[p] = Math.max(0, Math.min(255, Math.round(kind === 'gray' ? rgb[0] : 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]))); continue; }
        const o = p * 4;
        out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255;
      }
    }
    return out;
  }

  /** 이미지(또는 SMask)의 날 표본을 얻는다: Flate → pako, JPEG → JS 디코더 */
  async function rawSamples(info, stream, codec) {
    if (info.kind === 'jpeg') {
      const j = await codec.jpegRaw(stream.getContents());
      if (j.comps !== info.cs.n && !(info.cs.type === 'indexed' && j.comps === 1)) throw new Error('JPEG 성분 수가 색 공간과 달라요');
      // JPEG(Adobe)은 CMYK를 반전해 저장한다: 디코더가 돌려준 값(=잉크)을 다시 표본 값으로
      if (j.comps === 4) for (let i = 0; i < j.data.length; i++) j.data[i] = 255 - j.data[i];
      return { px: j.data, w: j.w, h: j.h, bpc: 8 };
    }
    let px = streamBytes(stream);
    const rowBytes = Math.ceil((info.w * info.cs.n * info.bpc) / 8);
    if (info.predictor >= 10) px = unpredict(px, rowBytes, info.h, Math.max(1, Math.ceil((info.cs.n * info.bpc) / 8)));
    return { px, w: info.w, h: info.h, bpc: info.bpc };
  }

  /** 이미지를 codec이 다룰 수 있는 handle로 푼다. */
  async function decodeImage(img, codec) {
    if (img.native) return codec.decodeJpeg(img.stream.getContents());
    const s = await rawSamples(img, img.stream, codec);
    const rgba = samplesToRGBA(s.px, s.w, s.h, { ...img, bpc: s.bpc });
    return codec.fromRGBA(rgba, s.w, s.h);
  }
  /** 투명도 마스크를 회색 8bit로 */
  async function decodeMask(sm, codec) {
    const s = await rawSamples(sm, sm.stream, codec);
    return { data: samplesToRGBA(s.px, s.w, s.h, { ...sm, bpc: s.bpc }, true), w: s.w, h: s.h };
  }

  /** 회색 한 채널 그림을 줄인다(투명도 마스크용, 칸 평균). */
  function shrinkGray(src, w, h, nw, nh) {
    const out = new Uint8Array(nw * nh);
    const sx = w / nw;
    const sy = h / nh;
    for (let y = 0; y < nh; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
      for (let x = 0; x < nw; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
        let s = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += src[yy * w + xx];
        out[y * nw + x] = Math.round(s / ((y1 - y0) * (x1 - x0)));
      }
    }
    return out;
  }

  async function lossless(bytes) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const out = await safeSave(doc);
    return out.length < bytes.length ? out : bytes;
  }

  /**
   * 사진 하나를 t로 다시 만든다(투명도 마스크 포함). 실패하면 이유와 함께 null.
   * @returns {Promise<{bytes, w, h, mask?:{bytes,w,h}, size:number}|{fail:string}>}
   */
  async function encodeOne(img, t, codec) {
    const { scale, q } = params(t);
    let hd;
    try {
      hd = await decodeImage(img, codec);
    } catch (e) {
      return { fail: /Adobe|4 components/i.test(String(e && e.message)) ? R.cmykNoAdobe : R.broken, error: e };
    }
    let enc;
    try {
      // 한 변이 너무 크면(캔버스 한계) 더 줄인다
      const fit = Math.min(1, Math.sqrt(16e6 / (hd.w * hd.h * scale * scale)));
      enc = await codec.encode(hd, scale * fit, q);
    } catch (e) {
      return { fail: R.broken, error: e };
    } finally {
      if (codec.release) codec.release(hd);
    }
    let mask = null;
    if (img.smask && (enc.w !== img.w || enc.h !== img.h || enc.w !== img.smask.w || enc.h !== img.smask.h)) {
      try {
        const m = await decodeMask(img.smask, codec);
        mask = { w: enc.w, h: enc.h, bytes: pako.deflate(shrinkGray(m.data, m.w, m.h, enc.w, enc.h)) };
      } catch (e) {
        return { fail: R.broken, error: e };
      }
    }
    const size = enc.bytes.length + (mask ? mask.bytes.length : (img.smask ? img.smask.len : 0));
    return { bytes: enc.bytes, w: enc.w, h: enc.h, mask, size };
  }

  /**
   * 크기 추정기: 큰 사진 몇 장은 실제로 인코딩(결과는 기억), 나머지는 같은 t의 화소당 크기로 추정.
   * sizes(t) → 사진마다 예상 크기 배열
   */
  function makeEstimator(images, codec, { signal, onProgress } = {}) {
    const sample = images.slice(0, SAMPLE);
    const memo = new Map(); // `${key}@${t}` → 결과
    const failed = new Map(); // key → 이유
    async function encodeMemo(img, t) {
      const k = `${img.key}@${t}`;
      if (memo.has(k)) return memo.get(k);
      const r = await encodeOne(img, t, codec);
      if (r.fail) failed.set(img.key, r.fail);
      memo.set(k, r);
      return r;
    }
    const sizesMemo = new Map();
    async function sizes(t) {
      if (sizesMemo.has(t)) return sizesMemo.get(t);
      const out = new Array(images.length);
      let px = 0;
      let bytes = 0;
      for (let i = 0; i < sample.length; i++) {
        check(signal);
        const img = sample[i];
        if (onProgress) await onProgress({ phase: 'search', t, done: i, total: sample.length });
        const r = await encodeMemo(img, t);
        if (r.fail) { out[i] = img.total; continue; }
        out[i] = Math.min(img.total, r.size);
        px += img.w * img.h;
        bytes += r.size;
      }
      const perPx = px ? bytes / px : 0;
      for (let i = sample.length; i < images.length; i++) {
        const img = images[i];
        out[i] = perPx ? Math.min(img.total, perPx * img.w * img.h + 200) : img.total;
      }
      sizesMemo.set(t, out);
      return out;
    }
    /** 다른 t로 만든 결과는 버린다(메모리) */
    function prune(t) {
      for (const k of memo.keys()) if (!k.endsWith(`@${t}`)) memo.delete(k);
    }
    return { sizes, encodeMemo, memo, failed, prune };
  }

  /** 사진 0..k-1을 t로 줄였을 때 예상 전체 크기 */
  const totalOf = (nonImage, images, sz, k) => {
    let s = nonImage;
    for (let i = 0; i < images.length; i++) s += i < k ? sz[i] : images[i].total;
    return s;
  };

  /** 계획(t, k)대로 실제로 바꿔 넣고 저장한다. 결과마다 실제 크기를 기억해 다음 조정에 쓴다. */
  async function applyPlan(baseBytes, t, k, est, codec, { signal, onProgress } = {}) {
    const doc = await PDFDocument.load(baseBytes, { updateMetadata: false });
    const { list } = findImages(doc);
    const ctx = doc.context;
    const actual = new Map(); // key → 실제로 들어간 크기
    let changed = 0;
    let kept = 0;
    for (let i = 0; i < list.length && i < k; i++) {
      check(signal);
      const img = list[i];
      if (onProgress) await onProgress({ phase: 'images', done: i, total: Math.min(k, list.length) });
      const r = await est.encodeMemo(img, t);
      if (r.fail || r.size >= img.total) {
        if (!r.fail) kept++; // 줄여도 커지면 원본 유지
        actual.set(img.key, img.total);
        continue;
      }
      const dict = img.stream.dict.clone(ctx);
      dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      dict.set(PDFName.of('Width'), PDFNumber.of(r.w));
      dict.set(PDFName.of('Height'), PDFNumber.of(r.h));
      dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      for (const key of ['DecodeParms', 'Decode', 'Length', 'Intent']) dict.delete(PDFName.of(key));
      ctx.assign(img.ref, PDFRawStream.of(dict, r.bytes));
      if (r.mask) {
        const md = img.smask.stream.dict.clone(ctx);
        md.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
        md.set(PDFName.of('Width'), PDFNumber.of(r.mask.w));
        md.set(PDFName.of('Height'), PDFNumber.of(r.mask.h));
        md.set(PDFName.of('ColorSpace'), PDFName.of('DeviceGray'));
        md.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
        for (const key of ['DecodeParms', 'Decode', 'Length']) md.delete(PDFName.of(key));
        ctx.assign(img.smask.ref, PDFRawStream.of(md, r.mask.bytes));
      }
      actual.set(img.key, r.size);
      changed++;
    }
    if (onProgress) await onProgress({ phase: 'save' });
    return { bytes: await safeSave(doc), changed, kept, actual };
  }

  /**
   * 파일을 넣자마자 보여 줄 수치: 손실 없이 다시 저장한 크기와, 가장 세게 줄였을 때 예상 크기
   * @returns {Promise<{original, lossless, min, images, skipped, reasons, imageShare, mostlyText}>}
   */
  async function analyzePdf(bytes, codec, opts = {}) {
    const base = await lossless(bytes);
    const doc = await PDFDocument.load(base, { updateMetadata: false });
    const found = findImages(doc);
    let min = base.length;
    if (found.list.length) {
      const nonImage = Math.max(0, base.length - found.list.reduce((s, im) => s + im.total, 0));
      const est = makeEstimator(found.list, codec, opts);
      const sz = await est.sizes(0);
      min = Math.min(base.length, totalOf(nonImage, found.list, sz, found.list.length));
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
      // 줄일 수 있는 폭이 원래의 5% 미만이면 "여지 없음"
      mostlyText: found.list.length === 0 || bytes.length - min < bytes.length * 0.05,
    };
  }

  /**
   * PDF를 target(바이트) 이하로, 목표 안에서 최대한 선명하게(목표의 85~100%) 줄인다.
   * status: 'done'(목표 이하) | 'raster'(2단계로 부족 → 3단계 제안) | 'cannot'(줄일 사진이 없음)
   */
  async function compressPdf(bytes, target, codec, opts = {}) {
    const { signal, onProgress } = opts;
    const t0 = Date.now();
    if (onProgress) await onProgress({ phase: 'tidy' });
    const base = await lossless(bytes);
    check(signal);
    const result = (extra) => ({ original: bytes.length, target, ms: Date.now() - t0, ...extra, size: extra.bytes.length });
    // 원본 유지만으로 목표 이하면 1단계에서 끝
    if (base.length <= target) return result({ status: 'done', stage: 1, bytes: base, t: 1, quality: '원본 그대로', reasons: {}, skipped: 0 });
    const doc = await PDFDocument.load(base, { updateMetadata: false });
    const found = findImages(doc);
    const images = found.list;
    const reasons = { ...found.reasons };
    if (!images.length) {
      return result({ status: 'cannot', stage: 1, bytes: base, skipped: found.skipped, reasons });
    }
    const nonImage = Math.max(0, base.length - images.reduce((s, im) => s + im.total, 0));
    const est = makeEstimator(images, codec, opts);
    const goal = target * 0.985;
    const low = target * 0.85;
    const n = images.length;

    // 1) 가장 선명하게(t=1)로 큰 사진 몇 장만 줄여서 되는가
    let t = 1;
    let k;
    const sz1 = await est.sizes(1);
    if (totalOf(nonImage, images, sz1, n) <= goal) {
      k = n;
      for (let j = 0; j <= n; j++) {
        if (totalOf(nonImage, images, sz1, j) <= goal) { k = j; break; }
      }
    } else {
      // 2) 모든 사진을 줄여야 하면 t를 이진 탐색
      const s = await searchT(async (x) => totalOf(nonImage, images, await est.sizes(x), n), goal, { signal });
      t = s.t;
      k = n;
      // 남는 만큼 작은 사진부터 원본으로 되돌린다(큰 사진부터 줄인 모양 유지)
      const szT = await est.sizes(t);
      while (k > 0 && totalOf(nonImage, images, szT, k - 1) <= goal) k--;
    }

    est.prune(t);
    let out = await applyPlan(base, t, k, est, codec, opts);
    // 실제 크기로 몇 번 조정: 넘으면 더 줄이고, 85%보다 작으면 원본을 되돌린다.
    for (let round = 0; round < 5; round++) {
      check(signal);
      const size = out.bytes.length;
      if (size > target) {
        if (k < n) k = Math.min(n, k + Math.max(1, Math.ceil((size - goal) / Math.max(1, images[k].total * 0.4))));
        else if (t > 0) t = Math.max(0, Math.round((t - 0.1) * 1000) / 1000);
        else break;
      } else if (size < low && k > 0) {
        let budget = goal - size;
        let moved = false;
        while (k > 0) {
          const img = images[k - 1];
          const gain = img.total - (out.actual.get(img.key) ?? img.total);
          if (gain > budget) break;
          budget -= gain;
          k--;
          moved = true;
        }
        if (!moved) {
          if (t < 1) t = Math.min(1, Math.round((t + (1 - t) / 2) * 1000) / 1000);
          else if (t < 1.16) t = Math.min(1.16, Math.round((t + 0.08) * 1000) / 1000);
          else break;
        }
      } else break;
      est.prune(t);
      const next = await applyPlan(base, t, k, est, codec, opts);
      // 목표를 넘는 쪽으로 가면 그 전 결과를 쓴다
      if (next.bytes.length > target && out.bytes.length <= target) break;
      out = next;
    }
    if (onProgress) await onProgress({ phase: 'check' });
    for (const why of est.failed.values()) reasons[why] = (reasons[why] || 0) + 1;
    const failedCount = est.failed.size;
    const best = out.bytes.length < base.length ? out.bytes : base;
    const reached = best.length <= target;
    // 화질: 줄인 사진의 t, 줄이지 않은 사진이 많으면 한 단계 좋게
    const share = images.slice(0, k).reduce((s, im) => s + im.total, 0) / images.reduce((s, im) => s + im.total, 0);
    const quality = share < 0.35 ? '선명' : qualityLabel(t);
    return result({
      status: reached ? 'done' : 'raster',
      stage: 2,
      bytes: best,
      t,
      k,
      quality,
      changed: out.changed,
      kept: out.kept,
      images: n,
      skipped: found.skipped + failedCount,
      reasons,
    });
  }

  /**
   * 사진 파일 하나를 target 이하로 다시 인코딩한다(목표에 가깝게).
   * type: 결과 형식('image/jpeg' | 'image/webp' | 'image/png')
   */
  async function compressImage(handle, originalSize, target, codec, { type = 'image/jpeg', signal } = {}) {
    // 가장 선명하게 해도 목표의 85%에 못 미치면 품질을 더 올려 본다
    const fill = async (r) => {
      if (type === 'image/png' || r.bytes.length >= target * 0.85) return r;
      for (const t2 of [1.1, 1.16]) {
        const x = await enc(t2);
        if (x.bytes.length <= target && x.bytes.length < originalSize) r = { ...x, t: t2, reached: true, quality: '선명' };
      }
      return r;
    };
    const memo = new Map();
    const enc = async (t) => {
      if (!memo.has(t)) {
        const { scale, q } = params(t);
        const fit = Math.min(1, Math.sqrt(16e6 / (handle.w * handle.h * scale * scale)));
        memo.set(t, await codec.encode(handle, scale * fit, q, type));
      }
      return memo.get(t);
    };
    const top = await enc(1);
    if (top.bytes.length <= target) return fill({ ...top, t: 1, reached: true, quality: qualityLabel(1) });
    const s = await searchT(async (t) => (await enc(t)).bytes.length, target * 0.99, { signal });
    const r = await enc(s.t);
    return { ...r, t: s.t, reached: r.bytes.length <= target, quality: qualityLabel(s.t) };
  }

  /** 줄일 수 있는 폭에 맞춘 막대 한 칸(MB) */
  function niceStep(rangeBytes) {
    const raw = rangeBytes / MB / 100;
    const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
    return steps.find((s) => s >= raw - 1e-9) || 1;
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
    let jsJpeg = null;
    async function loadJpegDecoder() {
      if (self.JpegDecoder) return self.JpegDecoder;
      if (!jsJpeg) {
        jsJpeg = typeof importScripts === 'function'
          ? Promise.resolve(importScripts('/vendor/jpeg-decoder.js'))
          : new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = '/vendor/jpeg-decoder.js';
            s.onload = res;
            s.onerror = () => { jsJpeg = null; rej(new Error('JPEG 디코더를 불러오지 못했어요')); };
            document.head.append(s);
          });
      }
      await jsJpeg;
      return self.JpegDecoder;
    }
    return {
      async decodeJpeg(bytes) {
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        return { bmp, w: bmp.width, h: bmp.height };
      },
      async jpegRaw(bytes) {
        const D = await loadJpegDecoder();
        return D.raw(bytes);
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
        try {
          const ctx = c.getContext('2d');
          if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(hd.bmp, 0, 0, w, h);
          const blob = await toBlob(c, type, q);
          return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h, type: blob.type };
        } finally {
          c.width = c.height = 0; // 메모리를 바로 돌려준다
        }
      },
      /** 투명한 곳이 있는가 (PNG를 JPG로 바꿔도 되는지) */
      hasAlpha(hd) {
        const w = Math.min(hd.w, 256);
        const h = Math.min(hd.h, 256);
        const c = makeCanvas(w, h);
        const ctx = c.getContext('2d');
        ctx.drawImage(hd.bmp, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        c.width = c.height = 0;
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
    safeSave,
    cmykToRgb,
    samplesToRGBA,
    findImages,
    unpredict,
    lossless,
    analyzePdf,
    compressPdf,
    compressImage,
    niceStep,
    browserCodec,
    REASONS: R,
  };
});
