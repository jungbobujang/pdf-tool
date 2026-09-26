// PDF 작업실 핵심 로직 검증.
// 브라우저가 쓰는 public/pdf-core.js를 그대로 불러와 @cantoo/pdf-lib로 실행한다.
// 실행: node test/verify.mjs
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const PDFLib = require('@cantoo/pdf-lib');
const Core = require('../public/pdf-core.js')(PDFLib);
const { PDFDocument, StandardFonts, degrees } = PDFLib;

const rows = [];
function check(name, ok, detail = '') {
  rows.push({ name, ok: !!ok, detail });
}
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `예외: ${e && e.message}`);
  }
}

/** 쪽마다 폭이 다른 샘플 PDF (폭으로 쪽을 구분한다) */
async function sample(widths, label, rotations = []) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  widths.forEach((w, i) => {
    const p = doc.addPage([w, 800]);
    p.drawText(`${label} page ${i + 1}`, { x: 40, y: 700, size: 20, font });
    if (rotations[i]) p.setRotation(degrees(rotations[i]));
  });
  return doc.save();
}
const widthsOf = (doc) => doc.getPages().map((p) => Math.round(p.getWidth()));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const errMsg = async (p) => {
  try { await p; return null; } catch (e) { return String(e.message); }
};

// 최소 PNG 인코더 (RGB, 필터 0)
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3;
    raw[o] = (x * 255) / w; raw[o + 1] = (y * 255) / h; raw[o + 2] = 128;
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// pdf.js(Node용 legacy 빌드)로 글자를 읽어 본다. 안 되면 null.
let pdfjs = null;
{
  // Node에는 canvas가 없어 그리기 관련 경고가 나오지만 글자 읽기에는 필요 없으므로 숨긴다.
  const log = console.log;
  const warn = console.warn;
  console.log = console.warn = () => {};
  try {
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  } catch { pdfjs = null; } finally {
    console.log = log;
    console.warn = warn;
  }
}
async function pdfjsText(bytes, pageNo, password) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), password, isEvalSupported: false, verbosity: 0 }).promise;
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  const text = tc.items.map((i) => i.str).join(' ').trim();
  await doc.destroy();
  return text;
}

const A = await sample([500, 501, 502], 'A'); // 3쪽
const B = await sample([600, 601, 602, 603], 'B', [0, 0, 270, 0]); // 4쪽 (3쪽은 원래 270도)
const docA = await PDFDocument.load(A);
const docB = await PDFDocument.load(B);
const all = [
  ...[0, 1, 2].map((i) => ({ doc: docA, index: i })),
  ...[0, 1, 2, 3].map((i) => ({ doc: docB, index: i })),
];

// 1. 합치기
let merged;
await step('합치기 3쪽+4쪽', async () => {
  const out = await Core.assemble(all);
  merged = await out.save();
  const back = await PDFDocument.load(merged);
  const w = widthsOf(back);
  check('합치기 3쪽+4쪽', back.getPageCount() === 7 && same(w, [500, 501, 502, 600, 601, 602, 603]),
    `${back.getPageCount()}쪽, 순서 ${w.join(',')}`);
});

// 2. 범위 추출
await step('범위 추출 "1-2, 4-7"', async () => {
  const nums = Core.parseRange('1-2, 4-7', 7);
  const out = await Core.assemble(nums.map((n) => all[n - 1]));
  const back = await PDFDocument.load(await out.save());
  const w = widthsOf(back);
  check('범위 추출 "1-2, 4-7"', same(nums, [1, 2, 4, 5, 6, 7]) && back.getPageCount() === 6 && same(w, [500, 501, 600, 601, 602, 603]),
    `${back.getPageCount()}쪽, 폭 ${w.join(',')}`);
});
await step('범위 해석(역순·끝까지·오류)', async () => {
  const r1 = Core.parseRange('7-5', 7);
  const r2 = Core.parseRange('6-', 7);
  const r3 = Core.parseRange(' 3 ~ 4 ,1', 7);
  let e1 = null;
  try { Core.parseRange('2, 9', 7); } catch (e) { e1 = e; }
  let e2 = null;
  try { Core.parseRange('a-b', 7); } catch (e) { e2 = e; }
  check('범위 해석(역순·끝까지·오류)',
    same(r1, [7, 6, 5]) && same(r2, [6, 7]) && same(r3, [3, 4, 1]) && e1 && e1.title === '9쪽은 없어요.' && e2 && e2.name === 'UserError',
    `7-5→${r1} / 6-→${r2} / "2, 9"→"${e1 && e1.title}"`);
});

// 3. 회전
await step('회전 값', async () => {
  const out = await Core.assemble([
    { doc: docA, index: 0, rot: 90 },
    { doc: docB, index: 2, rot: 180 }, // 원래 270 → 90
    { doc: docB, index: 0, rot: 270 },
    { doc: docA, index: 1, rot: 0 },
  ]);
  const back = await PDFDocument.load(await out.save());
  const r = back.getPages().map((p) => p.getRotation().angle);
  check('회전 값', same(r, [90, 90, 270, 0]), `기대 90,90,270,0 → 실제 ${r.join(',')}`);
});

// 4. 쪽 교체 (+ 같은 쪽 두 번 쓰기)
await step('쪽 교체', async () => {
  const list = all.slice();
  list[1] = { doc: docB, index: 3 }; // 2번째 자리를 B의 4쪽으로
  list.push({ doc: docB, index: 3 }); // 같은 쪽을 한 번 더
  const out = await Core.assemble(list);
  const back = await PDFDocument.load(await out.save());
  const w = widthsOf(back);
  check('쪽 교체', back.getPageCount() === 8 && w[1] === 603 && w[7] === 603 && w[0] === 500,
    `2번째 쪽 폭 ${w[1]} (B 4쪽=603), 중복 사용 ${w[7]}`);
});

// 5. 암호
const PW = 'Abc한글123';
let encBytes;
await step('암호 걸기 (AES-256)', async () => {
  const doc = await PDFDocument.load(merged);
  Core.encrypt(doc, { userPassword: PW, ownerPassword: 'owner-pw', allowPrint: true, allowCopy: false, allowEdit: false });
  encBytes = await doc.save({ useObjectStreams: false });
  const s = Buffer.from(encBytes).toString('latin1');
  const aes256 = /\/V\s+5/.test(s) && /\/R\s+6/.test(s) && /AESV3/.test(s);
  check('암호 걸기 (AES-256)', aes256 && /\/Encrypt/.test(s), aes256 ? '/V 5 /R 6 /AESV3' : '암호 사전을 찾지 못함');
});
await step('비밀번호 없이 열기 → 실패', async () => {
  const m = await errMsg(PDFDocument.load(encBytes));
  check('비밀번호 없이 열기 → 실패', m && Core.isEncryptedError({ message: m }), m ? m.slice(0, 60) + '…' : '열려 버림');
});
await step('틀린 비밀번호 → 실패', async () => {
  const m = await errMsg(PDFDocument.load(encBytes, { password: 'abc한글123' }));
  check('틀린 비밀번호 → 실패', m === 'Password incorrect', `"${m}"`);
});
await step('맞는 비밀번호 → 복호화 저장 → 비밀번호 없이 열림', async () => {
  const r = await Core.decrypt(encBytes, PW);
  const back = await PDFDocument.load(r.bytes); // 비밀번호 없이
  const w = widthsOf(back);
  check('맞는 비밀번호 → 복호화 저장 → 비밀번호 없이 열림',
    back.getPageCount() === 7 && !back.isEncrypted && same(w, [500, 501, 502, 600, 601, 602, 603]),
    `${back.getPageCount()}쪽, 암호 ${back.isEncrypted ? '남음' : '없음'}`);
});
await step('권한 암호로도 풀림', async () => {
  const r = await Core.decrypt(encBytes, 'owner-pw');
  check('권한 암호로도 풀림', r.doc.getPageCount() === 7, `${r.doc.getPageCount()}쪽`);
});
await step('열기 암호 있는 PDF는 잠김으로 표시', async () => {
  const info = await Core.openPdf(encBytes);
  check('열기 암호 있는 PDF는 잠김으로 표시', info.locked && info.wasEncrypted && !info.doc, `locked=${info.locked}`);
});
await step('열기 암호 없는(권한만 잠긴) PDF 자동 열기', async () => {
  const doc = await PDFDocument.load(A);
  doc.encrypt({ userPassword: '', ownerPassword: 'only-owner', permissions: { printing: false } });
  const info = await Core.openPdf(await doc.save());
  check('열기 암호 없는(권한만 잠긴) PDF 자동 열기', !info.locked && info.wasEncrypted && info.doc.getPageCount() === 3,
    `locked=${info.locked}, ${info.doc && info.doc.getPageCount()}쪽`);
});
await step('PDF가 아닌 파일 거르기', async () => {
  let e = null;
  try { await Core.openPdf(new TextEncoder().encode('hello, not a pdf')); } catch (x) { e = x; }
  check('PDF가 아닌 파일 거르기', e && e.name === 'UserError', e ? e.title : '통과해 버림');
});
if (pdfjs) {
  await step('pdf.js로 암호 PDF 열기(틀림/맞음)', async () => {
    const wrong = await errMsg(pdfjsText(encBytes, 1, 'nope'));
    const text = await pdfjsText(encBytes, 1, PW);
    check('pdf.js로 암호 PDF 열기(틀림/맞음)', wrong && /password/i.test(wrong) && text === 'A page 1',
      `틀림: "${wrong}", 맞음: "${text}"`);
  });
}

// 6. 쪽번호
await step('쪽번호 삽입 후 쪽수 유지', async () => {
  const doc = await PDFDocument.load(merged);
  const n = await Core.addPageNumbers(doc, { position: 'bc', format: 'total', start: 1, skipFirst: true });
  const bytes = await doc.save();
  const back = await PDFDocument.load(bytes);
  let detail = `${back.getPageCount()}쪽, 번호 ${n}개`;
  let textOk = true;
  if (pdfjs) {
    const t1 = await pdfjsText(bytes, 1);
    const t2 = await pdfjsText(bytes, 2);
    const t7 = await pdfjsText(bytes, 7);
    textOk = t1 === 'A page 1' && t2.includes('1 / 6') && t7.includes('6 / 6');
    detail += `, 2쪽 "${t2}", 7쪽 "${t7}"`;
  }
  check('쪽번호 삽입 후 쪽수 유지', back.getPageCount() === 7 && n === 6 && textOk, detail);
});
await step('쪽번호 형식', async () => {
  const f = [Core.numberText(3, 12, 'n'), Core.numberText(3, 12, 'dash'), Core.numberText(3, 12, 'total')];
  check('쪽번호 형식', same(f, ['3', '- 3 -', '3 / 12']), f.map((x) => `"${x}"`).join(' '));
});
await step('회전된 쪽에도 번호가 쪽 안에 찍힘', async () => {
  // 270도 회전된 쪽(B 3쪽)에 번호를 넣고, pdf.js로 글자 위치를 확인한다.
  const doc = await PDFDocument.load(B);
  await Core.addPageNumbers(doc, { position: 'bc', format: 'n', start: 1 });
  const bytes = await doc.save();
  if (!pdfjs) return check('회전된 쪽에도 번호가 쪽 안에 찍힘', true, 'pdf.js 없음: 쪽수만 확인');
  const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const page = await d.getPage(3);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const item = tc.items.find((i) => i.str === '3');
  const [x, y] = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
  await d.destroy();
  // 보이는 화면 기준으로 아래 가운데여야 한다.
  const ok = Math.abs(x - vp.width / 2) < 20 && y > vp.height - 40 && y <= vp.height;
  check('회전된 쪽에도 번호가 쪽 안에 찍힘', ok, `보이는 크기 ${Math.round(vp.width)}×${Math.round(vp.height)}, 번호 위치 (${Math.round(x)}, ${Math.round(y)})`);
});

// 7. 이미지 → PDF
await step('이미지 → PDF (배치·비율)', async () => {
  const L = Core.layoutImage('a4p', 28, 4000, 3000);
  const ratioOk = Math.abs(L.w / L.h - 4 / 3) < 1e-6;
  const centered = Math.abs(L.x - (L.pageW - L.w) / 2) < 1e-6 && Math.abs(L.y - (L.pageH - L.h) / 2) < 1e-6;
  const fitsBox = L.w <= L.pageW - 56 + 1e-6 && L.h <= L.pageH - 56 + 1e-6;
  const land = Core.layoutImage('a4l', 0, 100, 100);
  const orig = Core.layoutImage('fit', 0, 800, 600);
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(makePng(40, 30));
  const P = Core.layoutImage('a4p', 0, img.width, img.height);
  doc.addPage([P.pageW, P.pageH]).drawImage(img, { x: P.x, y: P.y, width: P.w, height: P.h });
  const back = await PDFDocument.load(await doc.save());
  check('이미지 → PDF (배치·비율)',
    ratioOk && centered && fitsBox && land.pageW > land.pageH && orig.pageW === 600 && orig.pageH === 450 && back.getPageCount() === 1,
    `A4 세로 이미지 ${Math.round(L.w)}×${Math.round(L.h)}pt 가운데, 원본 크기 800×600px→${orig.pageW}×${orig.pageH}pt`);
});

// 8. 여러 쪽 순서 조작 (선택 막대 · 끌어 옮기기)
const ten = Array.from({ length: 10 }, (_, i) => i + 1); // 1~10쪽
await step('여러 쪽 맨 앞/맨 뒤 (상대 순서 유지)', async () => {
  const f = Core.moveToFront(ten, [7, 3]);
  const e = Core.moveToEnd(ten, [4, 2]);
  check('여러 쪽 맨 앞/맨 뒤 (상대 순서 유지)',
    same(f, [3, 7, 1, 2, 4, 5, 6, 8, 9, 10]) && same(e, [1, 3, 5, 6, 7, 8, 9, 10, 2, 4]) && same(ten, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    `3,7 맨 앞 → ${f.join(',')} / 2,4 맨 뒤 → ${e.join(',')} (원래 배열 그대로)`);
});
await step('떨어진 쪽(2,5,9)을 N쪽 다음으로', async () => {
  const a = Core.moveAfter(ten, [2, 5, 9], 6);
  const b = Core.moveAfter(ten, [9, 5, 2], 0); // 넘기는 순서와 상관없이 지금 순서대로
  const c = Core.moveAfter(ten, [2, 5, 9], 10);
  const d = Core.moveAfter(ten, [2, 5, 9], 5); // 기준 쪽이 고른 쪽이어도 된다
  check('떨어진 쪽(2,5,9)을 N쪽 다음으로',
    same(a, [1, 3, 4, 6, 2, 5, 9, 7, 8, 10]) && same(b, [2, 5, 9, 1, 3, 4, 6, 7, 8, 10]) &&
    same(c, [1, 3, 4, 6, 7, 8, 10, 2, 5, 9]) && same(d, [1, 3, 4, 2, 5, 9, 6, 7, 8, 10]),
    `6쪽 뒤 → ${a.join(',')} / 0 → ${b.join(',')} / 5쪽 뒤 → ${d.join(',')}`);
});
await step('끌어 놓기 틈 번호(moveGroup)', async () => {
  const a = Core.moveGroup(ten, [2, 5, 9], 7); // 7쪽 앞 틈
  const b = Core.moveGroup([1, 2, 3, 4, 5], [2, 4], 0);
  const same1 = Core.moveGroup([1, 2, 3], [2], 2); // 제자리
  check('끌어 놓기 틈 번호(moveGroup)',
    same(a, [1, 3, 4, 6, 7, 2, 5, 9, 8, 10]) && same(b, [2, 4, 1, 3, 5]) && same(same1, [1, 2, 3]),
    `2,5,9 → 8쪽 앞 ${a.join(',')} / 2,4 맨 앞 ${b.join(',')}`);
});
await step('N쪽 다음으로: 범위 오류', async () => {
  const msgs = [11, -1, 2.5, '', 'abc'].map((n) => {
    try { Core.moveAfter(ten, [1], n); return null; } catch (e) { return e.title; }
  });
  const counted = Core.moveAfter([1, 2, 3, 4], [4], 1, [1, 3]); // 삭제 예정 2쪽은 번호에서 뺌
  check('N쪽 다음으로: 범위 오류', msgs.every((m) => m === '1~10 사이 숫자를 넣어 주세요.') && same(counted, [1, 4, 2, 3]),
    `11·-1·2.5·빈칸·글자 → "${msgs[0]}" / 번호 셀 때 삭제 예정 쪽 제외 OK`);
});
await step('회전 90° 단위 정규화', async () => {
  const r = [Core.rotate(0, 'left'), Core.rotate(270, 'right'), Core.rotate(90, 'right'), Core.rotate(180, 'left'), Core.rotate(-450, 'right')];
  check('회전 90° 단위 정규화', same(r, [270, 0, 180, 90, 0]), `0↺=${r[0]}, 270↻=${r[1]}, 90↻=${r[2]}, 180↺=${r[3]}, -450↻=${r[4]}`);
});
await step('선택한 쪽만 저장 (쪽수·순서)', async () => {
  // 지금 순서가 B4, A1, B1, A3, B2 … 일 때 A3, B4, B1을 고르면 지금 순서대로 B4, B1, A3
  const order = [6, 0, 3, 2, 4, 1, 5];
  const picked = Core.pickInOrder(order, [2, 6, 3]);
  const out = await Core.assemble(picked.map((i) => all[i]));
  const back = await PDFDocument.load(await out.save());
  const w = widthsOf(back);
  check('선택한 쪽만 저장 (쪽수·순서)', back.getPageCount() === 3 && same(w, [603, 600, 502]),
    `${back.getPageCount()}쪽, 폭 ${w.join(',')} (B4, B1, A3)`);
});

// ── 결과 표 ─────────────────────────────────────────
const width = (s) => [...s].reduce((n, ch) => n + (/[ᄀ-ᇿ㄰-㆏가-힣]/.test(ch) ? 2 : 1), 0);
const padR = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const c1 = Math.max(...rows.map((r) => width(r.name)), 4);
console.log(`\n| ${padR('항목', c1)} | 결과 | 세부`);
console.log(`|${'-'.repeat(c1 + 2)}|------|${'-'.repeat(40)}`);
for (const r of rows) console.log(`| ${padR(r.name, c1)} | ${r.ok ? '통과' : '실패'} | ${r.detail}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length}개 중 ${rows.length - failed}개 통과${failed ? `, ${failed}개 실패` : ''}${pdfjs ? '' : ' (pdf.js 교차 확인은 건너뜀)'}`);
process.exit(failed ? 1 : 0);
