/* 사진 작업실 — 화면 없이 계산만 하는 부분(브라우저 · node 검사 둘 다에서 쓴다).
   사진은 이 파일 어디에서도 밖으로 나가지 않는다. 바이트를 읽고 · 고치고 · 크기를 셀 뿐이다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PhotoCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── 쓸 곳(추천값). 처음 쓰는 분은 이것만 고르면 된다 ─────────────
  const USES = [
    { id: 'kakao', label: '카톡 · 밴드', title: '카톡 · 밴드로 보내기 좋게', mode: 'edge', value: 1280, q: 85 },
    { id: 'web', label: '학급 홈페이지', title: '홈페이지 · 학급 앨범용', mode: 'edge', value: 1920, q: 85 },
    { id: 'print', label: '인쇄 · 게시판', title: '인쇄해도 또렷하게', mode: 'edge', value: 3000, q: 92 },
    { id: 'doc', label: '공문 첨부 10MB', title: '모두 합쳐 10MB 아래로', mode: 'all', value: 10, q: 85 },
    { id: 'jpg', label: '아이폰 사진 → JPG', title: '크기는 그대로, JPG로만', mode: 'keep', value: 0, q: 92 },
  ];
  const MODES = {
    edge: { label: '긴 변 px', unit: 'px (가로 · 세로 중 긴 쪽)', min: 64, max: 12000, step: 1 },
    width: { label: '가로 px', unit: 'px (세로는 비율대로)', min: 64, max: 12000, step: 1 },
    each: { label: '장당 MB', unit: 'MB 아래로 (장마다)', min: 0.05, max: 50, step: 0.05 },
    all: { label: '모두 합쳐 MB', unit: 'MB 아래로 (고른 사진 합계)', min: 0.2, max: 500, step: 0.1 },
    keep: { label: '크기 그대로', unit: '', min: 0, max: 0, step: 1 },
  };
  const FORMATS = { jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG' }, webp: { mime: 'image/webp', ext: 'webp', label: 'WEBP' }, png: { mime: 'image/png', ext: 'png', label: 'PNG' } };

  // 처음 화면 "무엇을 할까요?" — 고르면 그 도구가 추천값으로 열린다
  const GOALS = [
    { id: 'kakao', tool: 'resize', use: 'kakao', mark: 'KB', title: '카톡 · 밴드로 보낼 사진 작게', line: '추천: 긴 변 1280px · 위치 정보 지움' },
    { id: 'face', tool: 'face', mark: '얼굴', title: '학생 얼굴 가리기', line: '찾은 얼굴 모두 모자이크 · 한 장씩 확인', soon: true },
    { id: 'collage', tool: 'collage', mark: '모음', title: '활동 사진 한 장으로 모으기', line: 'A4 · 사진 수에 맞춰 칸 · 사진 밑 설명', soon: true },
    { id: 'doc', tool: 'resize', use: 'doc', mark: '10MB', title: '공문 첨부 10MB에 맞추기', line: '추천: 모두 합쳐 10MB 아래로 · 장마다 알아서 나눔' },
    { id: 'crop', tool: 'crop', mark: '3×4', title: '증명사진 · 프로필 자르기', line: '3×4cm · 300dpi · 얼굴을 가운데로', soon: true },
    { id: 'jpg', tool: 'resize', use: 'jpg', mark: 'JPG', title: '아이폰 사진(HEIC)을 JPG로', line: '추천: 크기는 그대로 · 형식만 JPG · 방향 바로' },
  ];

  const useOf = (id) => USES.find((u) => u.id === id) || USES[0];

  /** 쓸 곳을 고르면 들어가는 설정 전체. [자세히]에서 바꾼 것만 이 위에 덮는다 */
  function defaultSettings(useId) {
    const u = useOf(useId);
    return {
      use: u.id, mode: u.mode, value: u.value, q: u.q, fmt: 'jpeg',
      sharpen: true, noUpscale: true, keepDate: true, keepPng: true, name: u.id === 'jpg' ? '{이름}' : '{이름}_작게',
    };
  }

  /** 설정 한 줄 ("긴 변 1280px · JPG 품질 85 · 위치 정보 지움") */
  function settingsLine(s) {
    const size = s.mode === 'edge' ? `긴 변 ${s.value}px`
      : s.mode === 'width' ? `가로 ${s.value}px`
        : s.mode === 'each' ? `장마다 ${s.value}MB 아래`
          : s.mode === 'all' ? `모두 합쳐 ${s.value}MB 아래 · 장마다 알아서 나눔`
            : '크기 그대로';
    const fmt = s.fmt === 'keep' ? '형식 그대로' : `${FORMATS[s.fmt].label}${s.fmt === 'png' ? '' : ` 품질 ${s.q}`}`;
    return `${size} · ${fmt} · 위치 정보 지움`;
  }

  // ── 크기 ─────────────────────────────────────────────────────
  /** 이 설정으로 나올 가로 · 세로(px). 작은 사진은 키우지 않는다(noUpscale) */
  function fitSize(w, h, s) {
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    let k = 1;
    if (s.mode === 'edge') k = Number(s.value) / Math.max(W, H);
    else if (s.mode === 'width') k = Number(s.value) / W;
    if (!(k > 0) || !Number.isFinite(k)) k = 1;
    if (s.noUpscale !== false) k = Math.min(k, 1);
    return { w: Math.max(1, Math.round(W * k)), h: Math.max(1, Math.round(H * k)), k };
  }

  // JPEG 품질별 화소당 바이트(사진 기준, 화면에 "약"으로만 쓴다). 실제로 한 장 만들어 보면 그 비율로 바로잡는다
  const BPP = [[40, 0.06], [60, 0.09], [70, 0.12], [80, 0.17], [85, 0.21], [90, 0.29], [92, 0.33], [95, 0.45], [100, 0.9]];
  function bppOf(q) {
    const v = Math.max(40, Math.min(100, Number(q) || 85));
    for (let i = 1; i < BPP.length; i++) {
      if (v <= BPP[i][0]) {
        const [q0, b0] = BPP[i - 1];
        const [q1, b1] = BPP[i];
        return b0 + ((b1 - b0) * (v - q0)) / (q1 - q0);
      }
    }
    return BPP[BPP.length - 1][1];
  }
  /** 한 장의 예상 바이트. fix: 실제로 만들어 본 사진의 (실제 / 예상) 비율 */
  function estimateBytes(w, h, q, fmt = 'jpeg', fix = 1) {
    const px = Math.max(1, w * h);
    const base = fmt === 'png' ? px * 1.6 : fmt === 'webp' ? px * bppOf(q) * 0.72 : px * bppOf(q);
    return Math.round(base * (fix > 0 ? fix : 1));
  }

  /** "모두 합쳐 N MB": 화소 수에 비례해 장마다 몫을 나눈다(작은 사진이 큰 몫을 받지 않게) */
  function splitBudget(totalBytes, pixelsList) {
    const sum = pixelsList.reduce((a, p) => a + Math.max(1, p), 0) || 1;
    return pixelsList.map((p) => Math.max(20 * 1024, Math.floor((totalBytes * Math.max(1, p)) / sum)));
  }

  // ── 파일 이름 ─────────────────────────────────────────────────
  const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
  function baseOf(name) {
    return String(name || '사진').replace(/\.[^.]{1,6}$/, '') || '사진';
  }
  /** {이름} · {번호} · {찍은 날} → 저장할 이름(확장자 붙임). 번호는 장 수에 맞춰 0을 채운다 */
  function fileName(template, { name, index = 0, count = 1, date = '', ext = 'jpg' }) {
    const width = String(Math.max(1, count)).length;
    const num = String(index + 1).padStart(width, '0');
    let out = String(template || '{이름}')
      .replace(/\{이름\}/g, baseOf(name))
      .replace(/\{번호\}/g, num)
      .replace(/\{찍은 ?날\}/g, date || '');
    out = out.replace(BAD_NAME, '_').replace(/\s+/g, ' ').replace(/^[.\s_]+|[.\s]+$/g, '').slice(0, 120);
    if (!out) out = `사진_${num}`;
    return `${out}.${ext}`;
  }
  /** 같은 이름이 겹치면 " (2)"를 붙인다 */
  function uniqueNames(names) {
    const seen = new Map();
    return names.map((n) => {
      const key = n.toLowerCase();
      const c = (seen.get(key) || 0) + 1;
      seen.set(key, c);
      if (c === 1) return n;
      const dot = n.lastIndexOf('.');
      return dot > 0 ? `${n.slice(0, dot)} (${c})${n.slice(dot)}` : `${n} (${c})`;
    });
  }

  // ── 사진 종류 · 크기 · 정보(EXIF) ────────────────────────────────
  function detectKind(head, name = '') {
    const b = head || new Uint8Array(0);
    const at = (i) => b[i];
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png';
    if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'webp';
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'gif';
    if (at(0) === 0x42 && at(1) === 0x4d) return 'bmp';
    if ((at(0) === 0x49 && at(1) === 0x49 && at(2) === 0x2a) || (at(0) === 0x4d && at(1) === 0x4d && at(3) === 0x2a)) return 'tiff';
    if (b.length >= 12 && at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
      const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
      if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(brand)) return brand === 'avif' ? 'avif' : 'heic';
    }
    if (/\.(heic|heif)$/i.test(name)) return 'heic';
    return '';
  }

  function u16(b, i, le) { return le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]; }
  function u32(b, i, le) { return le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }

  /** JPEG의 APP1 Exif 안 TIFF 덩어리를 찾는다: { tiff: Uint8Array } 또는 null */
  function exifBlock(bytes) {
    const b = bytes;
    if (!(b && b[0] === 0xff && b[1] === 0xd8)) return null;
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd9 || marker === 0xda) return null;
      const len = u16(b, i + 2, false);
      if (len < 2) return null;
      if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && b[i + 8] === 0 && b[i + 9] === 0) {
        return { tiff: b.subarray(i + 10, Math.min(b.length, i + 2 + len)) };
      }
      i += 2 + len;
    }
    return null;
  }

  function readIfd(t, off, le) {
    const out = new Map();
    if (off + 2 > t.length) return out;
    const n = u16(t, off, le);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > t.length) break;
      out.set(u16(t, e, le), { type: u16(t, e + 2, le), count: u32(t, e + 4, le), at: e + 8 });
    }
    return out;
  }
  function ascii(t, entry, le) {
    if (!entry || entry.type !== 2) return '';
    const off = entry.count <= 4 ? entry.at : u32(t, entry.at, le);
    let s = '';
    for (let i = 0; i < entry.count && off + i < t.length; i++) {
      const c = t[off + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  /** 사진 속 정보: 찍은 날 · 위치(GPS) 있음 · 휴대폰 기종 있음 · 방향 */
  function readExif(bytes) {
    const out = { date: null, gps: false, device: false, orientation: 1 };
    try {
      const blk = exifBlock(bytes);
      if (!blk) return out;
      const t = blk.tiff;
      if (t.length < 8) return out;
      const le = t[0] === 0x49;
      if (!(le || t[0] === 0x4d) || u16(t, 2, le) !== 42) return out;
      const ifd0 = readIfd(t, u32(t, 4, le), le);
      out.device = ifd0.has(0x010f) || ifd0.has(0x0110);
      const o = ifd0.get(0x0112);
      if (o && o.type === 3) out.orientation = u16(t, o.at, le) || 1;
      const gpsPtr = ifd0.get(0x8825);
      if (gpsPtr) out.gps = readIfd(t, u32(t, gpsPtr.at, le), le).size > 0;
      const exifPtr = ifd0.get(0x8769);
      let date = '';
      if (exifPtr) {
        const ex = readIfd(t, u32(t, exifPtr.at, le), le);
        date = ascii(t, ex.get(0x9003), le) || ascii(t, ex.get(0x9004), le);
      }
      if (!date) date = ascii(t, ifd0.get(0x0132), le);
      if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(date) && !/^0000/.test(date)) out.date = date;
    } catch { /* 읽지 못하면 정보 없음으로 */ }
    return out;
  }
  /** "2026:10:05 09:12:33" → "2026-10-05" */
  function dateText(exifDate) {
    const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(String(exifDate || ''));
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }

  /** 찍은 날 하나만 담은 EXIF(APP1) 덩어리. 위치 · 기종 · 작은 미리보기는 넣지 않는다 */
  function exifDateSegment(exifDate) {
    if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(String(exifDate || ''))) return null;
    const dateBytes = [...String(exifDate)].map((c) => c.charCodeAt(0)).concat([0]); // 20바이트
    // TIFF(II): 머리 8 · IFD0(항목 1개: ExifIFD 포인터) 18 · ExifIFD(항목 1개: DateTimeOriginal) 18 · 날짜 20
    const tiff = new Uint8Array(8 + 18 + 18 + 20);
    const w16 = (i, v) => { tiff[i] = v & 0xff; tiff[i + 1] = (v >> 8) & 0xff; };
    const w32 = (i, v) => { w16(i, v & 0xffff); w16(i + 2, (v >>> 16) & 0xffff); };
    tiff[0] = 0x49; tiff[1] = 0x49; w16(2, 42); w32(4, 8);
    w16(8, 1); w16(10, 0x8769); w16(12, 4); w32(14, 1); w32(18, 26); w32(22, 0);
    w16(26, 1); w16(28, 0x9003); w16(30, 2); w32(32, 20); w32(36, 44); w32(40, 0);
    tiff.set(dateBytes, 44);
    const body = 6 + tiff.length;
    const seg = new Uint8Array(4 + body);
    seg[0] = 0xff; seg[1] = 0xe1; seg[2] = ((body + 2) >> 8) & 0xff; seg[3] = (body + 2) & 0xff;
    seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
    seg.set(tiff, 10);
    return seg;
  }
  /** 브라우저가 만든 JPEG(정보 없음)에 찍은 날만 다시 넣는다 */
  function withExifDate(jpeg, exifDate) {
    const seg = exifDateSegment(exifDate);
    if (!seg || !(jpeg && jpeg[0] === 0xff && jpeg[1] === 0xd8)) return jpeg;
    // 브라우저 JPEG은 SOI 뒤에 APP0(JFIF)가 오면 그 뒤에 넣는다(JFIF는 맨 앞이어야 한다)
    let at = 2;
    if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + u16(jpeg, 4, false);
    const out = new Uint8Array(jpeg.length + seg.length);
    out.set(jpeg.subarray(0, at), 0);
    out.set(seg, at);
    out.set(jpeg.subarray(at), at + seg.length);
    return out;
  }

  /** 사진의 가로 · 세로를 머리 바이트에서(전체를 풀지 않고). 방향 5~8이면 바꿔 준다. 모르면 null */
  function imageSize(bytes, kind) {
    const b = bytes;
    try {
      if (kind === 'png' && b.length >= 24) return { w: u32(b, 16, false), h: u32(b, 20, false) };
      if (kind === 'gif' && b.length >= 10) return { w: u16(b, 6, true), h: u16(b, 8, true) };
      if (kind === 'bmp' && b.length >= 26) return { w: Math.abs(u32(b, 18, true) | 0), h: Math.abs(u32(b, 22, true) | 0) };
      if (kind === 'webp' && b.length >= 30) {
        const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (chunk === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
        if (chunk === 'VP8 ') return { w: u16(b, 26, true) & 0x3fff, h: u16(b, 28, true) & 0x3fff };
        if (chunk === 'VP8L') {
          const v = u32(b, 21, true);
          return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
        }
      }
      if (kind === 'jpeg') {
        let i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) { i++; continue; }
          const m = b[i + 1];
          if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
          const len = u16(b, i + 2, false);
          if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
            let h = u16(b, i + 5, false);
            let w = u16(b, i + 7, false);
            const o = readExif(b).orientation;
            if (o >= 5 && o <= 8) [w, h] = [h, w];
            return { w, h };
          }
          i += 2 + len;
        }
      }
    } catch { /* 모름 */ }
    return null;
  }

  // ── 글자 ─────────────────────────────────────────────────────
  function sizeText(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    if (n >= 1024 * 1024 * 1024) return `${(n / (1024 ** 3)).toFixed(1)}GB`;
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1)}MB`;
    return `${Math.max(1, Math.round(n / 1024))}KB`;
  }

  return {
    USES, MODES, FORMATS, GOALS, useOf, defaultSettings, settingsLine,
    fitSize, bppOf, estimateBytes, splitBudget,
    fileName, uniqueNames, baseOf,
    detectKind, readExif, dateText, exifDateSegment, withExifDate, imageSize, sizeText,
  };
});
