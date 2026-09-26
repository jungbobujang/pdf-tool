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

// 9. 나눠 저장 계획
await step('나눠 저장: 10쪽씩 · 4개로 똑같이 · 자르기 · 삭제 예정 제외', async () => {
  const p23 = Array.from({ length: 23 }, (_, i) => ({ n: i + 1 }));
  const sizes = (g) => g.map((x) => x.items.length).join(',');
  const every = Core.splitGroups(p23, 'every', 10);
  const parts = Core.splitGroups(p23, 'parts', 4);
  const cuts = Core.splitGroups(p23, 'cuts', [3, 10]);
  const each = Core.splitGroups(p23.slice(0, 5), 'each');
  const withDel = [...p23.slice(0, 5)];
  withDel[1] = { ...withDel[1], deleted: true };
  const del = Core.splitGroups(withDel, 'every', 2);
  let tooMany = null;
  try { Core.splitGroups(p23.slice(0, 3), 'parts', 5); } catch (e) { tooMany = e.title; }
  const name = Core.splitFileName('수업자료', 0, 3, 1, 10);
  const name12 = Core.splitFileName('A', 11, 120, 23, 23);
  check('나눠 저장: 10쪽씩 · 4개로 똑같이 · 자르기 · 삭제 예정 제외',
    sizes(every) === '10,10,3' && sizes(parts) === '6,6,6,5' && sizes(cuts) === '3,7,13' && cuts[1].from === 4 && cuts[1].to === 10 &&
    sizes(each) === '1,1,1,1,1' && del.map((g) => g.items.map((x) => x.n).join('+')).join(',') === '1+3,4+5' &&
    tooMany === '3쪽은 3개 파일까지만 나눌 수 있어요.' && name === '수업자료_01_1-10쪽.pdf' && name12 === 'A_012_23쪽.pdf',
    `10쪽씩 ${sizes(every)} / 4개 ${sizes(parts)} / [3,10] ${sizes(cuts)} / 2쪽 삭제 예정 → ${del.map((g) => g.items.map((x) => x.n).join('+')).join(', ')} / ${name}`);
});

// 10. 워터마크 · 도장 · 적용 순서
const fontkit = require('@cantoo/fontkit');
const fs = require('node:fs');
const FONT = fs.readFileSync(new URL('../node_modules/pretendard/dist/public/static/Pretendard-Bold.otf', import.meta.url));

await step('한글 워터마크 (서브셋 글꼴)', async () => {
  const doc = await PDFDocument.load(B);
  const font = await Core.embedFont(doc, fontkit, FONT);
  await Core.addWatermark(doc, { text: '내부 자료', layout: 'diagonal', strength: 'normal', color: 'red' }, font);
  const bytes = await doc.save();
  const back = await PDFDocument.load(bytes);
  const grow = bytes.length - B.length;
  let text = 'pdf.js 없음';
  let ok = true;
  if (pdfjs) {
    text = await pdfjsText(bytes, 3); // 270도 회전된 쪽
    ok = text.includes('내부 자료');
  }
  const tile = Core.watermarkLayout(595, 842, 4, 'tile');
  check('한글 워터마크 (서브셋 글꼴)', back.getPageCount() === 4 && grow < 1024 * 1024 && ok && tile.spots.length > 10,
    `4쪽 유지, 크기 +${(grow / 1024).toFixed(1)}KB (1MB 미만), 회전된 3쪽 글자 "${text.slice(0, 20)}", 바둑판 ${tile.spots.length}자리`);
});

// content stream을 풀어 마지막 이미지가 놓인 자리(보이는 좌표 비율)를 구한다.
function lastImageBox(page) {
  const contents = page.node.Contents();
  const arr = contents instanceof PDFLib.PDFArray ? contents.asArray() : [contents];
  const src = arr.map((r) => {
    const s = page.doc.context.lookup(r);
    const raw = Buffer.from(s.getContents());
    const f = s.dict.get(PDFLib.PDFName.of('Filter'));
    return (f && String(f) === '/FlateDecode' ? zlib.inflateSync(raw) : raw).toString('latin1');
  }).join('\n');
  const toks = src.split(/\s+/).filter(Boolean);
  const doAt = toks.lastIndexOf('Do');
  let qAt = doAt;
  while (qAt > 0 && toks[qAt] !== 'q') qAt--;
  let M = [1, 0, 0, 1, 0, 0];
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  for (let i = qAt; i < doAt; i++) if (toks[i] === 'cm') M = mul(toks.slice(i - 6, i).map(Number), M);
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [u * M[0] + v * M[2] + M[4], u * M[1] + v * M[3] + M[5]]);
  const f = Core.pageFrame(page);
  const { x: bx, y: by, width: bw, height: bh } = f.box;
  const vis = pts.map(([x, y]) => {
    if (f.rot === 90) return [y - by, bx + bw - x];
    if (f.rot === 180) return [bx + bw - x, by + bh - y];
    if (f.rot === 270) return [by + bh - y, x - bx];
    return [x - bx, y - by];
  });
  const xs = vis.map((p) => p[0]);
  const ys = vis.map((p) => p[1]);
  return {
    x: Math.min(...xs) / f.visW, y: (f.visH - Math.max(...ys)) / f.visH,
    w: (Math.max(...xs) - Math.min(...xs)) / f.visW, h: (Math.max(...ys) - Math.min(...ys)) / f.visH, visW: f.visW, visH: f.visH,
  };
}

await step('도장 이미지가 비율 위치에 (회전된 쪽 포함)', async () => {
  const doc = await PDFDocument.load(B); // 3쪽은 270도 회전
  const png = makePng(40, 30);
  const place = { x: 0.7, y: 0.8, w: 0.2 };
  const n = await Core.addStamps(doc, [{ bytes: png, place }], 'all');
  const back = await PDFDocument.load(await doc.save());
  const boxes = [0, 2].map((i) => lastImageBox(back.getPage(i)));
  const near = (a, b) => Math.abs(a - b) < 0.002;
  const ok = boxes.every((b) => near(b.x, 0.7) && near(b.y, 0.8) && near(b.w, 0.2) && near(b.h, (0.2 * b.visW * 0.75) / b.visH));
  const last = Core.stampPages('last', 4);
  check('도장 이미지가 비율 위치에 (회전된 쪽 포함)', n === 4 && ok && last.join() === '3',
    boxes.map((b, k) => `${k ? '3쪽(270°)' : '1쪽'} x${b.x.toFixed(3)} y${b.y.toFixed(3)} w${b.w.toFixed(3)}`).join(' / '));
});

await step('적용 순서: 쪽번호→워터마크→도장→암호', async () => {
  const doc = await PDFDocument.load(A);
  await Core.addPageNumbers(doc, { position: 'bc', format: 'total', start: 1 });
  const font = await Core.embedFont(doc, fontkit, FONT);
  await Core.addWatermark(doc, { text: '대외비', layout: 'tile', strength: 'light', color: 'gray' }, font);
  await Core.addStamps(doc, [{ bytes: makePng(20, 20), place: { x: 0.8, y: 0.85, w: 0.1 } }], 'last');
  Core.encrypt(doc, { userPassword: 'pw1234' });
  const bytes = await doc.save({ useObjectStreams: false });
  const noPw = await errMsg(PDFDocument.load(bytes));
  const back = await PDFDocument.load(bytes, { password: 'pw1234' });
  const img = lastImageBox(back.getPage(2));
  let text = '';
  if (pdfjs) text = await pdfjsText(bytes, 3, 'pw1234');
  check('적용 순서: 쪽번호→워터마크→도장→암호', /encrypted/i.test(noPw || '') && back.getPageCount() === 3 && Math.abs(img.x - 0.8) < 0.002 &&
    (!pdfjs || (text.includes('3 / 3') && text.includes('대외비'))),
  `암호 없이 못 엶, 비밀번호로 3쪽 · 3쪽 글자 "${text.replace(/\s+/g, ' ').slice(0, 40)}…" · 도장 x=${img.x.toFixed(2)}`);
});

// 11. 용량 줄이기 엔진
const Compress = require('../public/compress.js')(PDFLib, require('pako'));
const { nodeCodec, photoJpeg } = await import('./node-codec.mjs');
const MBf = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
const measures = [];

async function photoPdf(count) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const img = await doc.embedJpg(photoJpeg(1200, 1000, i + 1));
    const p = doc.addPage([595, 842]);
    p.drawImage(img, { x: 40, y: 250, width: 515, height: 430 });
    p.drawText(`Photo page ${i + 1}`, { x: 40, y: 760, size: 24, font });
  }
  return doc.save();
}
const photos = await photoPdf(20);
await step('용량 줄이기: 사진 20장 PDF → 목표 10MB', async () => {
  const r = await Compress.compressPdf(photos, 10 * 1024 * 1024, nodeCodec);
  const back = await PDFDocument.load(r.bytes);
  const text = pdfjs ? await pdfjsText(r.bytes, 7) : 'pdf.js 없음';
  measures.push(`사진 20장 PDF ${MBf(photos.length)} → 목표 10MB: ${MBf(r.size)} · ${(r.ms / 1000).toFixed(1)}초 · ${r.stage}단계`);
  check('용량 줄이기: 사진 20장 PDF → 목표 10MB', photos.length > 25 * 1024 * 1024 && r.status === 'done' && r.size <= 10 * 1024 * 1024 &&
    back.getPageCount() === 20 && (!pdfjs || text.includes('Photo page 7')),
  `${MBf(photos.length)} → ${MBf(r.size)} (${r.stage}단계, 화질 ${r.quality}, ${(r.ms / 1000).toFixed(1)}초), 20쪽, 7쪽 글자 "${text}"`);
});
await step('용량 줄이기: 목표 2MB · 0.2MB (3단계 제안)', async () => {
  const r2 = await Compress.compressPdf(photos, 2 * 1024 * 1024, nodeCodec);
  const r0 = await Compress.compressPdf(photos, 0.2 * 1024 * 1024, nodeCodec);
  measures.push(`사진 20장 PDF → 목표 2MB: ${MBf(r2.size)} · ${(r2.ms / 1000).toFixed(1)}초 · ${r2.status === 'done' ? `${r2.stage}단계에서 끝` : '3단계 제안'}`);
  measures.push(`사진 20장 PDF → 목표 0.2MB: ${MBf(r0.size)} · ${(r0.ms / 1000).toFixed(1)}초 · ${r0.status === 'raster' ? '2단계로 부족 → 3단계 제안' : r0.status}`);
  const ok2 = (r2.status === 'done' && r2.size <= 2 * 1024 * 1024) || r2.status === 'raster';
  check('용량 줄이기: 목표 2MB · 0.2MB (3단계 제안)', ok2 && r0.status === 'raster' && r0.stage === 2 && r0.size < r2.size + 1,
    `2MB → ${r2.status === 'done' ? `${MBf(r2.size)} 성공` : `3단계 제안 (${MBf(r2.size)})`} / 0.2MB → "${r0.status}" 가장 세게 ${MBf(r0.size)}`);
});
await step('용량 줄이기: 글자만 있는 PDF는 "더 못 줄임"', async () => {
  const a = await Compress.analyzePdf(A, nodeCodec);
  const r = await Compress.compressPdf(A, 200, nodeCodec);
  check('용량 줄이기: 글자만 있는 PDF는 "더 못 줄임"', r.status === 'cannot' && a.mostlyText && a.images === 0,
    `${A.length}B → 목표 200B: "${r.status}", 분석 mostlyText=${a.mostlyText}`);
});
await step('사진 줄이기: 5MB JPG → 1MB 이하', async () => {
  const big = photoJpeg(2400, 1500, 7, 93);
  const hd = nodeCodec.decodeJpeg(big);
  const t0 = Date.now();
  const r = await Compress.compressImage(hd, big.length, 1024 * 1024, nodeCodec);
  measures.push(`사진 JPG ${MBf(big.length)} → 목표 1MB: ${MBf(r.bytes.length)} · ${((Date.now() - t0) / 1000).toFixed(1)}초 · ${r.w}×${r.h}`);
  check('사진 줄이기: 5MB JPG → 1MB 이하', big.length > 4.5 * 1024 * 1024 && r.reached && r.bytes.length <= 1024 * 1024,
    `${MBf(big.length)} → ${MBf(r.bytes.length)} (${r.w}×${r.h}, 화질 ${r.quality})`);
});

// ── 결과 표 ─────────────────────────────────────────
const width = (s) => [...s].reduce((n, ch) => n + (/[ᄀ-ᇿ㄰-㆏가-힣]/.test(ch) ? 2 : 1), 0);
const padR = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const c1 = Math.max(...rows.map((r) => width(r.name)), 4);
console.log(`\n| ${padR('항목', c1)} | 결과 | 세부`);
console.log(`|${'-'.repeat(c1 + 2)}|------|${'-'.repeat(40)}`);
for (const r of rows) console.log(`| ${padR(r.name, c1)} | ${r.ok ? '통과' : '실패'} | ${r.detail}`);
const failed = rows.filter((r) => !r.ok).length;
if (measures.length) console.log(`\n용량 줄이기 실측\n- ${measures.join('\n- ')}`);
console.log(`\n${rows.length}개 중 ${rows.length - failed}개 통과${failed ? `, ${failed}개 실패` : ''}${pdfjs ? '' : ' (pdf.js 교차 확인은 건너뜀)'}`);
process.exit(failed ? 1 : 0);
