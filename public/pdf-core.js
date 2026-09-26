/*
 * PDF 작업실 핵심 로직.
 * 브라우저에서는 전역 PDFLib(@cantoo/pdf-lib)로, 검증 스크립트(node)에서는
 * require('@cantoo/pdf-lib')로 같은 코드를 실행한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.PdfCore = factory(root.PDFLib);
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';

  const { PDFDocument, StandardFonts, degrees, rgb } = PDFLib;

  // A4 (pt)
  const A4 = { w: 595.28, h: 841.89 };
  const MAX_PAGE_SIDE = 14400; // PDF 규격상 쪽 한 변의 최대 길이(pt)

  /** 사용자에게 그대로 보여줄 수 있는 오류 */
  class UserError extends Error {
    constructor(title, fix) {
      super(title);
      this.name = 'UserError';
      this.title = title;
      this.fix = fix || '';
    }
  }

  const copy = (bytes) => (bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice());

  // 암호 때문에 못 연 경우. 빈 비밀번호로 열면 "NEEDS PASSWORD"가 난다.
  function isEncryptedError(e) {
    return !!e && /is encrypted|needs password/i.test(String(e.message));
  }
  function isWrongPasswordError(e) {
    return !!e && /password incorrect/i.test(String(e.message));
  }
  function looksLikePdf(bytes) {
    const head = bytes.subarray(0, Math.min(bytes.length, 1024));
    for (let i = 0; i < head.length - 4; i++) {
      if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) {
        return true; // "%PDF-"
      }
    }
    return false;
  }

  /**
   * PDF를 연다. 암호가 걸려 있으면 빈 비밀번호로 한 번 시도한다
   * (열기 암호 없이 권한만 잠긴 파일은 이것으로 풀린다).
   * @returns {Promise<{doc, bytes, locked:boolean, wasEncrypted:boolean}>}
   */
  async function openPdf(bytes) {
    if (!looksLikePdf(bytes)) {
      throw new UserError('PDF 파일이 아니에요.', 'PDF로 저장된 파일만 넣을 수 있어요.');
    }
    try {
      const doc = await PDFDocument.load(copy(bytes), { updateMetadata: false });
      return { doc, bytes, locked: false, wasEncrypted: false };
    } catch (e) {
      if (!isEncryptedError(e)) throw e;
    }
    try {
      const r = await decrypt(bytes, '');
      return { ...r, locked: false, wasEncrypted: true };
    } catch (e) {
      if (!isWrongPasswordError(e) && !isEncryptedError(e)) throw e;
    }
    return { doc: null, bytes, locked: true, wasEncrypted: true };
  }

  /**
   * 비밀번호로 연 뒤 모든 쪽을 새 문서로 복사해 암호 없는 문서를 만든다.
   * @returns {Promise<{doc, bytes}>} bytes: 암호 없는 새 PDF
   */
  async function decrypt(bytes, password) {
    const enc = await PDFDocument.load(copy(bytes), { password, updateMetadata: false });
    const out = await PDFDocument.create();
    const pages = await out.copyPages(enc, enc.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    const plain = await out.save();
    return { doc: out, bytes: plain };
  }

  const normAngle = (a) => (((Math.round(a / 90) * 90) % 360) + 360) % 360;

  /**
   * 여러 문서의 쪽을 원하는 순서로 모아 새 PDF를 만든다.
   * @param {Array<{doc, index:number, rot?:number}>} list  index는 0부터
   * @param {(done:number,total:number,phase:string)=>Promise|void} [onProgress]
   * @returns {Promise<PDFDocument>}
   */
  async function assemble(list, onProgress) {
    const out = await PDFDocument.create();
    const total = list.length;
    const placed = new Array(total);

    // 같은 문서의 쪽은 한 번에 복사해야 글꼴 같은 공유 자원이 한 번만 들어간다.
    // 같은 쪽이 두 번 쓰이면 복사를 따로 해야 하므로 등장 차수별로 묶는다.
    const seen = new Map();
    const rounds = [];
    list.forEach((item, pos) => {
      let perDoc = seen.get(item.doc);
      if (!perDoc) seen.set(item.doc, (perDoc = new Map()));
      const r = perDoc.get(item.index) || 0;
      perDoc.set(item.index, r + 1);
      if (!rounds[r]) rounds[r] = new Map();
      if (!rounds[r].has(item.doc)) rounds[r].set(item.doc, []);
      rounds[r].get(item.doc).push({ pos, index: item.index });
    });

    let copied = 0;
    for (const round of rounds) {
      for (const [doc, arr] of round) {
        const pages = await out.copyPages(doc, arr.map((a) => a.index));
        pages.forEach((pg, i) => (placed[arr[i].pos] = pg));
        copied += arr.length;
        if (onProgress) await onProgress(copied, total, 'copy');
      }
    }
    for (let i = 0; i < total; i++) {
      const pg = placed[i];
      const extra = list[i].rot || 0;
      if (extra) pg.setRotation(degrees(normAngle(pg.getRotation().angle + extra)));
      out.addPage(pg);
      if (onProgress) await onProgress(i + 1, total, 'place');
    }
    return out;
  }

  /**
   * "1-2, 4-7" 같은 범위를 1부터 시작하는 쪽 번호 배열로 바꾼다.
   * "5-"는 5쪽부터 끝까지, "-3"은 1~3쪽, "7-4"는 거꾸로.
   */
  function parseRange(text, max) {
    const src = String(text || '').replace(/[~〜–—]/g, '-').replace(/\s+/g, '');
    if (!src) throw new UserError('범위를 적어 주세요.', `예: 1-2, 4-7 (지금 1~${max}쪽이 있어요)`);
    const out = [];
    for (const part of src.split(/[,，]/)) {
      if (!part) continue;
      const m = /^(\d*)(-?)(\d*)$/.exec(part);
      if (!m || (!m[1] && !m[3])) {
        throw new UserError(`"${part}"를 읽지 못했어요.`, '쪽 번호는 1-3, 5처럼 숫자와 - , 로 적어 주세요.');
      }
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? (m[3] ? parseInt(m[3], 10) : max) : a;
      for (const n of [a, b]) {
        if (n < 1 || n > max) {
          throw new UserError(`${n}쪽은 없어요.`, `지금 1~${max}쪽까지 있어요.`);
        }
      }
      const step = a <= b ? 1 : -1;
      for (let n = a; n !== b + step; n += step) out.push(n);
    }
    if (!out.length) throw new UserError('범위를 적어 주세요.', `예: 1-2, 4-7 (지금 1~${max}쪽이 있어요)`);
    return out;
  }

  /** 암호 걸기 (AES-256) */
  function encrypt(doc, { userPassword, ownerPassword, allowPrint = true, allowCopy = false, allowEdit = false }) {
    if (!userPassword) throw new UserError('열기 암호를 입력해 주세요.', '파일을 열 때 물어볼 비밀번호예요.');
    doc.encrypt({
      userPassword,
      ownerPassword: ownerPassword || userPassword,
      algorithm: 'AES-256',
      permissions: {
        printing: allowPrint ? 'highResolution' : false,
        copying: allowCopy,
        contentAccessibility: true,
        modifying: allowEdit,
        annotating: allowEdit,
        fillingForms: allowEdit,
        documentAssembly: allowEdit,
      },
    });
    return doc;
  }

  /** 쪽번호 문구 */
  function numberText(n, total, format) {
    if (format === 'dash') return `- ${n} -`;
    if (format === 'total') return `${n} / ${total}`;
    return String(n);
  }

  /** 보이는 쪽 크기(회전 반영) 기준 글자 크기와 여백 */
  function numberMetrics(visW, visH) {
    const short = Math.min(visW, visH);
    return {
      size: Math.max(8, Math.min(28, short * 0.0185)), // A4에서 약 11pt
      margin: Math.max(14, short * 0.048), // A4에서 약 28pt (1cm)
    };
  }

  /** 보이는 좌표계(왼쪽 아래 원점)에서 글자 기준선 시작점 */
  function numberSpot(visW, visH, textW, size, margin, position) {
    if (position === 'br') return { vx: visW - margin - textW, vy: margin };
    if (position === 'tr') return { vx: visW - margin - textW, vy: visH - margin - size * 0.72 };
    return { vx: (visW - textW) / 2, vy: margin };
  }

  /**
   * 모든 쪽에 번호를 넣는다. 쪽 회전(/Rotate)과 CropBox를 반영해
   * 화면에 보이는 방향 그대로 찍힌다.
   * @returns {Promise<number>} 번호를 넣은 쪽 수
   */
  async function addPageNumbers(doc, { position = 'bc', format = 'n', start = 1, skipFirst = false }, onProgress) {
    const startNo = Number(start);
    if (!Number.isInteger(startNo) || startNo < 0) {
      throw new UserError('시작 번호는 0 이상의 정수로 적어 주세요.', '예: 1');
    }
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    const numbered = pages.length - (skipFirst ? 1 : 0);
    const total = startNo + numbered - 1;
    let count = 0;
    for (let i = 0; i < pages.length; i++) {
      if (skipFirst && i === 0) continue;
      const page = pages[i];
      const n = startNo + count;
      const text = numberText(n, total, format);
      const box = page.getCropBox();
      const rot = normAngle(page.getRotation().angle);
      const side = rot === 90 || rot === 270;
      const visW = side ? box.height : box.width;
      const visH = side ? box.width : box.height;
      const { size, margin } = numberMetrics(visW, visH);
      const textW = font.widthOfTextAtSize(text, size);
      const { vx, vy } = numberSpot(visW, visH, textW, size, margin, position);
      let x, y;
      if (rot === 90) { x = box.x + box.width - vy; y = box.y + vx; }
      else if (rot === 180) { x = box.x + box.width - vx; y = box.y + box.height - vy; }
      else if (rot === 270) { x = box.x + vy; y = box.y + box.height - vx; }
      else { x = box.x + vx; y = box.y + vy; }
      page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0), rotate: degrees(rot) });
      count++;
      if (onProgress) await onProgress(i + 1, pages.length);
    }
    return count;
  }

  /**
   * 이미지 한 장을 놓을 쪽 크기와 위치.
   * paper: 'a4p' | 'a4l' | 'fit', margin: pt, imgW/imgH: 픽셀
   */
  function layoutImage(paper, margin, imgW, imgH) {
    let pageW, pageH;
    if (paper === 'fit') {
      // 96dpi 기준으로 픽셀을 pt로 바꾼다. 너무 크면 PDF 한계 안으로 줄인다.
      let w = imgW * 0.75;
      let h = imgH * 0.75;
      const limit = MAX_PAGE_SIDE - margin * 2;
      const k = Math.min(1, limit / w, limit / h);
      w *= k; h *= k;
      return { pageW: w + margin * 2, pageH: h + margin * 2, x: margin, y: margin, w, h };
    }
    if (paper === 'a4l') { pageW = A4.h; pageH = A4.w; } else { pageW = A4.w; pageH = A4.h; }
    const boxW = pageW - margin * 2;
    const boxH = pageH - margin * 2;
    const k = Math.min(boxW / imgW, boxH / imgH);
    const w = imgW * k;
    const h = imgH * k;
    return { pageW, pageH, x: (pageW - w) / 2, y: (pageH - h) / 2, w, h };
  }

  // ── 쪽 순서 조작 (순수 함수: 새 배열을 돌려주고 원래 배열은 건드리지 않는다) ──

  /**
   * 고른 쪽들을 원래 상대 순서를 지킨 채 targetIndex 자리로 옮긴다.
   * targetIndex는 지금 순서에서의 "틈" 번호(0 = 맨 앞, order.length = 맨 뒤).
   * 고른 쪽이 떨어져 있어도(2,5,9) 한 덩어리로 모인다.
   */
  function moveGroup(order, ids, targetIndex) {
    const pick = new Set(ids);
    const t = Math.max(0, Math.min(order.length, Math.trunc(targetIndex) || 0));
    const moving = order.filter((id) => pick.has(id));
    const rest = order.filter((id) => !pick.has(id));
    // 틈 앞에 있던 고른 쪽은 빠지므로 그만큼 당긴다.
    const before = order.slice(0, t).filter((id) => pick.has(id)).length;
    const at = t - before;
    return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  }
  const moveToFront = (order, ids) => moveGroup(order, ids, 0);
  const moveToEnd = (order, ids) => moveGroup(order, ids, order.length);

  /**
   * 고른 쪽들을 n번째 쪽 바로 뒤로 옮긴다. 0이면 맨 앞.
   * counted: 번호를 셀 때 쓰는 쪽 목록(기본은 order 전체, 편집 화면에서는 삭제 예정 쪽을 뺀 목록)
   */
  function moveAfter(order, ids, n, counted = order) {
    const max = counted.length;
    const num = typeof n === 'string' ? (n.trim() === '' ? NaN : Number(n)) : n;
    if (!Number.isInteger(num) || num < 0 || num > max) {
      throw new UserError(`1~${max} 사이 숫자를 넣어 주세요.`, '0을 넣으면 맨 앞으로 옮겨요.');
    }
    if (num === 0) return moveGroup(order, ids, 0);
    return moveGroup(order, ids, order.indexOf(counted[num - 1]) + 1);
  }

  /** 지금 순서대로 고른 쪽만 뽑는다(선택한 쪽만 저장). */
  const pickInOrder = (order, ids) => {
    const pick = new Set(ids);
    return order.filter((id) => pick.has(id));
  };

  /** 90° 단위 회전. dir: 'right'(+1) | 'left'(-1). 결과는 0/90/180/270. */
  function rotate(deg, dir) {
    const step = dir === 'left' || dir === -1 ? -90 : 90;
    return normAngle((Number(deg) || 0) + step);
  }

  // ── 보이는 방향 기준 좌표 (쪽 회전 /Rotate 와 CropBox 반영) ──

  /** 쪽의 보이는 크기와, 보이는 좌표(왼쪽 아래 원점) → PDF 좌표 변환 */
  function pageFrame(page) {
    const box = page.getCropBox();
    const rot = normAngle(page.getRotation().angle);
    const side = rot === 90 || rot === 270;
    const visW = side ? box.height : box.width;
    const visH = side ? box.width : box.height;
    const toUser = (vx, vy) => {
      if (rot === 90) return { x: box.x + box.width - vy, y: box.y + vx };
      if (rot === 180) return { x: box.x + box.width - vx, y: box.y + box.height - vy };
      if (rot === 270) return { x: box.x + vy, y: box.y + box.height - vx };
      return { x: box.x + vx, y: box.y + vy };
    };
    return { box, rot, visW, visH, toUser };
  }

  // ── 워터마크 ──
  const WM_COLORS = { red: [0.84, 0.18, 0.18], gray: [0.35, 0.37, 0.42], blue: [0.2, 0.33, 1] };
  const WM_OPACITY = { light: 0.12, normal: 0.2, dark: 0.32 };
  const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

  /** 한글 워터마크용 글꼴을 문서에 넣는다(서브셋). fontkit은 @cantoo/fontkit */
  async function embedFont(doc, fontkit, bytes) {
    doc.registerFontkit(fontkit);
    return doc.embedFont(bytes, { subset: true });
  }

  /**
   * 보이는 쪽 크기에서 워터마크 글자들의 자리(보이는 좌표, 가운데 기준)와 크기, 각도
   * @returns {{size:number, angle:number, spots:Array<{cx:number, cy:number}>}}
   */
  function watermarkLayout(visW, visH, textW1, layout) {
    if (layout === 'center') {
      const size = Math.min((visW * 0.7) / textW1, visH * 0.12);
      return { size, angle: 0, spots: [{ cx: visW / 2, cy: visH / 2 }] };
    }
    if (layout === 'tile') {
      const size = Math.min(visW, visH) * 0.05;
      const stepX = textW1 * size + size * 3;
      const stepY = size * 5;
      const spots = [];
      let row = 0;
      for (let cy = stepY / 2; cy < visH + stepY; cy += stepY, row++) {
        for (let cx = (row % 2 ? stepX / 2 : 0); cx < visW + stepX; cx += stepX) spots.push({ cx, cy });
      }
      return { size, angle: 30, spots };
    }
    // 대각선: 왼쪽 아래 → 오른쪽 위
    const diag = Math.hypot(visW, visH);
    const size = Math.min((diag * 0.62) / textW1, Math.min(visW, visH) * 0.22);
    return { size, angle: (Math.atan2(visH, visW) * 180) / Math.PI, spots: [{ cx: visW / 2, cy: visH / 2 }] };
  }

  /**
   * 모든 쪽에 워터마크 글자를 넣는다.
   * opts: {text, layout:'diagonal'|'center'|'tile', strength:'light'|'normal'|'dark' 또는 opacity, color:'red'|'gray'|'blue'}
   * font: embedFont로 넣은 글꼴(한글이면 필수). 없으면 영문만 Helvetica-Bold로.
   */
  async function addWatermark(doc, opts, font, onProgress) {
    const text = String(opts.text || '').trim();
    if (!text) throw new UserError('워터마크 글자를 적어 주세요.', '예: 내부 자료');
    if (!font) {
      if (!isAscii(text)) throw new UserError('한글 글꼴을 불러오지 못했어요.', '잠시 뒤 다시 해 주세요.');
      font = await doc.embedFont(StandardFonts.HelveticaBold);
    }
    const [r, g, b] = WM_COLORS[opts.color] || WM_COLORS.red;
    const opacity = opts.opacity != null ? opts.opacity : (WM_OPACITY[opts.strength] || WM_OPACITY.normal);
    const textW1 = font.widthOfTextAtSize(text, 1);
    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const f = pageFrame(page);
      const { size, angle, spots } = watermarkLayout(f.visW, f.visH, textW1, opts.layout);
      const a = (angle * Math.PI) / 180;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const tw = textW1 * size;
      for (const s of spots) {
        // 글자 덩어리의 가운데가 (cx, cy)에 오도록 기준선 시작점을 구한다.
        const vx = s.cx - ux * (tw / 2) + uy * (size * 0.35);
        const vy = s.cy - uy * (tw / 2) - ux * (size * 0.35);
        const p = f.toUser(vx, vy);
        page.drawText(text, { x: p.x, y: p.y, size, font, color: rgb(r, g, b), opacity, rotate: degrees(normAngleFree(angle + f.rot)) });
      }
      if (onProgress) await onProgress(i + 1, pages.length);
    }
    return pages.length;
  }
  const normAngleFree = (a) => ((a % 360) + 360) % 360;

  // ── 서명 · 도장 이미지 ──

  /**
   * 도장 자리: 보이는 쪽 기준 비율 {x, y(위에서부터), w(폭 비율)}와 그림 비율(높이/폭)로
   * PDF 좌표의 drawImage 인자를 만든다. 크기가 다른 쪽에도 같은 자리에 들어간다.
   */
  function stampPlacement(frame, place, aspect) {
    const width = place.w * frame.visW;
    const height = width * aspect;
    const left = place.x * frame.visW;
    const bottom = frame.visH - place.y * frame.visH - height;
    const p = frame.toUser(left, bottom);
    return { x: p.x, y: p.y, width, height, rotate: degrees(frame.rot) };
  }

  /** 어느 쪽에 넣을지: 'last' | 'all' | [0부터 쪽 번호…] */
  function stampPages(target, count) {
    if (target === 'all') return Array.from({ length: count }, (_, i) => i);
    if (Array.isArray(target)) return target.filter((i) => Number.isInteger(i) && i >= 0 && i < count);
    return count ? [count - 1] : [];
  }

  /**
   * 서명 · 도장을 넣는다.
   * stamps: [{bytes: PNG|JPG Uint8Array, place:{x,y,w}}], target: stampPages 인자
   */
  async function addStamps(doc, stamps, target) {
    const pages = doc.getPages();
    const idx = stampPages(target, pages.length);
    for (const s of stamps) {
      const isPng = s.bytes[0] === 0x89 && s.bytes[1] === 0x50;
      const img = isPng ? await doc.embedPng(s.bytes) : await doc.embedJpg(s.bytes);
      const aspect = img.height / img.width;
      for (const i of idx) {
        const page = pages[i];
        page.drawImage(img, stampPlacement(pageFrame(page), s.place, aspect));
      }
    }
    return idx.length;
  }

  // ── 나눠 저장 ──

  /**
   * 쪽 목록을 파일 단위로 나눈다. 삭제 예정(deleted)인 쪽은 먼저 뺀다.
   * mode: 'each' | 'every'(n쪽씩) | 'parts'(n개 파일로 똑같이) | 'cuts'(n: 자를 위치 배열, k쪽 다음에서 자름)
   */
  function splitGroups(items, mode, n) {
    const list = items.filter((it) => !(it && it.deleted));
    const total = list.length;
    if (!total) return [];
    let sizes = [];
    if (mode === 'each') sizes = Array(total).fill(1);
    else if (mode === 'every') {
      const k = Number(n);
      if (!Number.isInteger(k) || k < 1) throw new UserError('몇 쪽씩 나눌지 1 이상의 숫자로 적어 주세요.', '예: 10');
      for (let left = total; left > 0; left -= k) sizes.push(Math.min(k, left));
    } else if (mode === 'parts') {
      const k = Number(n);
      if (!Number.isInteger(k) || k < 1) throw new UserError('파일 수를 1 이상의 숫자로 적어 주세요.', '예: 4');
      if (k > total) throw new UserError(`${total}쪽은 ${total}개 파일까지만 나눌 수 있어요.`, `1~${total} 사이 숫자를 넣어 주세요.`);
      const base = Math.floor(total / k);
      const extra = total % k;
      sizes = Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
    } else if (mode === 'cuts') {
      const cuts = [...new Set((n || []).map(Number))].filter((c) => Number.isInteger(c) && c > 0 && c < total).sort((a, b) => a - b);
      let prev = 0;
      for (const c of cuts) { sizes.push(c - prev); prev = c; }
      sizes.push(total - prev);
    } else throw new UserError('나누는 방식을 골라 주세요.', '');
    const out = [];
    let at = 0;
    for (const s of sizes) {
      out.push({ from: at + 1, to: at + s, items: list.slice(at, at + s) });
      at += s;
    }
    return out;
  }

  /** 원본이름_01_1-10쪽.pdf (번호는 파일 수 자릿수만큼 0 채움) */
  function splitFileName(stem, index, count, from, to) {
    const width = Math.max(2, String(count).length);
    const no = String(index + 1).padStart(width, '0');
    return `${stem}_${no}_${from === to ? from : `${from}-${to}`}쪽.pdf`;
  }

  // ── 걸린 제한 보기 ──

  /**
   * 파일의 암호 · 권한 제한을 읽는다(제한을 푸는 기능은 없다).
   * @returns {Promise<{encrypted, needsPassword, print, copy, edit, annotate, forms, assemble, algorithm}>}
   */
  async function readRestrictions(bytes) {
    if (!looksLikePdf(bytes)) throw new UserError('PDF 파일이 아니에요.', 'PDF로 저장된 파일만 넣을 수 있어요.');
    const doc = await PDFDocument.load(copy(bytes), { ignoreEncryption: true, updateMetadata: false });
    const encRef = doc.context.trailerInfo.Encrypt;
    const all = { print: true, copy: true, edit: true, annotate: true, forms: true, assemble: true };
    if (!encRef) return { encrypted: false, needsPassword: false, algorithm: '', ...all };
    const enc = doc.context.lookup(encRef);
    const num = (k) => {
      const v = enc && enc.get(PDFLib.PDFName.of(k));
      return v && typeof v.asNumber === 'function' ? v.asNumber() : null;
    };
    const P = num('P');
    const V = num('V');
    const bit = (b) => (P == null ? true : (P & (1 << (b - 1))) !== 0);
    const info = await openPdf(bytes);
    return {
      encrypted: true,
      needsPassword: info.locked,
      algorithm: V >= 5 ? 'AES-256' : V === 4 ? 'AES-128 또는 RC4-128' : 'RC4',
      print: bit(3),
      edit: bit(4),
      copy: bit(5),
      annotate: bit(6),
      forms: bit(9) || bit(6),
      assemble: bit(11) || bit(4),
    };
  }

  return {
    pageFrame,
    embedFont,
    watermarkLayout,
    addWatermark,
    stampPlacement,
    stampPages,
    addStamps,
    splitGroups,
    splitFileName,
    readRestrictions,
    WM_OPACITY,
    moveGroup,
    moveToFront,
    moveToEnd,
    moveAfter,
    pickInOrder,
    rotate,
    A4,
    UserError,
    isEncryptedError,
    isWrongPasswordError,
    looksLikePdf,
    openPdf,
    decrypt,
    assemble,
    parseRange,
    encrypt,
    numberText,
    numberMetrics,
    numberSpot,
    addPageNumbers,
    layoutImage,
    normAngle,
  };
});
