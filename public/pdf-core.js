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

  return {
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
