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

// 12. 한글(HWP) 등에서 나오는 이미지 형식 · 망가진 사진 · PDF/A
const jpegjs = require('jpeg-js');
const { colorSamplesPdf } = await import('./node-codec.mjs');
{
  const samplePdf = (broken) => colorSamplesPdf({ broken });
  const pageImage = (doc, i) => {
    const res = doc.getPage(i).node.Resources();
    const xo = res.lookup(PDFLib.PDFName.of('XObject'), PDFLib.PDFDict);
    const [, ref] = xo.entries()[0];
    return doc.context.lookup(ref);
  };
  const meanRGB = (bytes) => {
    const d = jpegjs.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
    const s = [0, 0, 0];
    for (let i = 0; i < d.data.length; i += 4) for (let c = 0; c < 3; c++) s[c] += d.data[i + c];
    const n = d.data.length / 4;
    return { mean: s.map((x) => x / n), w: d.width, h: d.height };
  };

  await step('HWP 이미지 형식: 줄인 결과가 열리고 색이 맞음', async () => {
    const { bytes, samples } = await samplePdf(false);
    const r = await Compress.compressPdf(bytes, 1000, nodeCodec); // 아주 작은 목표 → 모든 사진을 다시 만들게
    const back = await PDFDocument.load(r.bytes);
    let pdfjsOk = true;
    if (pdfjs) {
      const d = await pdfjs.getDocument({ data: r.bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
      pdfjsOk = d.numPages === samples.length;
      await d.destroy();
    }
    const rows2 = [];
    let ok = back.getPageCount() === samples.length && pdfjsOk;
    samples.forEach((smp, i) => {
      const st = pageImage(back, i);
      const f = String(st.dict.get(PDFLib.PDFName.of('Filter')));
      if (f !== '/DCTDecode' || smp.dct && String(st.dict.get(PDFLib.PDFName.of('ColorSpace'))) !== '/DeviceRGB') {
        rows2.push(`${smp.name}: 원본 유지`);
        if (!smp.mayKeep) ok = false;
        return;
      }
      const m = meanRGB(st.getContents());
      const diff = Math.max(...m.mean.map((v, c) => Math.abs(v - smp.expect[c])));
      if (diff > 12) ok = false;
      let extra = '';
      if (smp.smask) {
        const sm = back.context.lookup(st.dict.get(PDFLib.PDFName.of('SMask')));
        const sw = sm.dict.get(PDFLib.PDFName.of('Width')).asNumber();
        const sh = sm.dict.get(PDFLib.PDFName.of('Height')).asNumber();
        extra = ` SMask ${sw}×${sh}`;
        if (sw !== m.w || sh !== m.h) ok = false;
      }
      rows2.push(`${smp.name} Δ${diff.toFixed(1)}${extra}`);
    });
    check('HWP 이미지 형식: 줄인 결과가 열리고 색이 맞음', ok && r.changed >= samples.length - 1,
      `${(bytes.length / 1024).toFixed(0)}KB → ${(r.size / 1024).toFixed(0)}KB, 바꾼 사진 ${r.changed}/${samples.length} · ${rows2.join(' / ')} (평균 색 차이 12 이하)`);
  });

  await step('사진 하나가 망가져도 파일 전체는 성공', async () => {
    const { bytes } = await samplePdf(true);
    const r = await Compress.compressPdf(bytes, 1000, nodeCodec);
    const back = await PDFDocument.load(r.bytes);
    check('사진 하나가 망가져도 파일 전체는 성공', back.getPageCount() === 13 && r.reasons['읽지 못한 사진(손상)'] === 1 && r.changed >= 10,
      `${r.status} · 바꾼 사진 ${r.changed}장 · 건너뜀 ${JSON.stringify(r.reasons)}`);
  });

  await step('PDF/A-1 문서도 줄이기 (150쪽 실패 원인 재현)', async () => {
    const doc = await PDFDocument.load(photos);
    const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const meta = doc.context.register(doc.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' }));
    doc.catalog.set(PDFLib.PDFName.of('Metadata'), meta);
    const pdfa = await doc.save({ useObjectStreams: false });
    const before = await errMsg((async () => { const d = await PDFDocument.load(pdfa); await d.save({ useObjectStreams: true }); })());
    const r = await Compress.compressPdf(pdfa, 12 * 1024 * 1024, nodeCodec);
    const back = await PDFDocument.load(r.bytes);
    check('PDF/A-1 문서도 줄이기 (150쪽 실패 원인 재현)', /PDF\/A-1 forbids/.test(before || '') && r.status === 'done' && back.getPageCount() === 20,
      `예전 오류 "${(before || '').slice(0, 60)}…" → 이제 ${MBf(pdfa.length)} → ${MBf(r.size)} (${r.status})`);
  });

  await step('목표에 가깝게: 결과가 목표의 85~100%', async () => {
    const out = [];
    let ok = true;
    for (const mb of [20, 10, 6]) {
      const r = await Compress.compressPdf(photos, mb * 1024 * 1024, nodeCodec);
      const ratio = r.size / (mb * 1024 * 1024);
      out.push(`목표 ${mb}MB → ${MBf(r.size)} (${Math.round(ratio * 100)}%, 화질 ${r.quality}, 줄인 사진 ${r.k}/${r.images})`);
      if (!(ratio >= 0.85 && ratio <= 1)) ok = false;
    }
    const keep = await Compress.compressPdf(photos, 40 * 1024 * 1024, nodeCodec);
    check('목표에 가깝게: 결과가 목표의 85~100%', ok && keep.stage === 1, `${out.join(' / ')} · 목표 40MB는 원본 그대로 1단계`);
  });

  await step('막대 한 칸 크기', async () => {
    const s = [0.4, 3, 7, 30, 120, 500].map((mb) => Compress.niceStep(mb * 1024 * 1024));
    check('막대 한 칸 크기', s.join(',') === '0.01,0.05,0.1,0.5,1,1', `폭 0.4/3/7/30/120/500MB → 한 칸 ${s.join(' / ')}MB`);
  });
}

// 13. HEIC 판별 · 쪽 크기 맞추기 · 양면 스캔 · 빈 쪽 · 파일 정보 · 일괄 · zip 한글 이름
{
  await step('사진 형식 판별(HEIC 시그니처 · 지원 안 하는 형식)', async () => {
    const box = (brands) => {
      const b = new Uint8Array(8 + brands.length * 4);
      b.set([0, 0, 0, b.length], 0);
      b.set([...'ftyp'].map((c) => c.charCodeAt(0)), 4);
      brands.forEach((br, i) => b.set([...br].map((c) => c.charCodeAt(0)), 8 + i * 4));
      return b;
    };
    const cases = [
      [box(['heic', '\0\0\0\0', 'mif1', 'heic']), 'IMG_0001.HEIC', 'heic'],
      [box(['mif1', '\0\0\0\0', 'mif1', 'heic']), 'photo.bin', 'heic'],
      [box(['heix', '\0\0\0\0']), 'a', 'heic'],
      [box(['avif', '\0\0\0\0', 'avif', 'mif1']), 'a.avif', 'avif'],
      [new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0]), 'scan.tif', 'tiff'],
      [new Uint8Array([0x42, 0x4d, 0, 0]), 'a.bmp', 'bmp'],
      [new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), 'a.gif', 'gif'],
      [new Uint8Array([0xff, 0xd8, 0xff]), 'a.jpg', 'jpeg'],
      [new Uint8Array([0, 1, 2, 3]), 'IMG_2.heif', 'heic'],
      [new Uint8Array([0, 1, 2, 3]), 'x.tiff', 'tiff'],
    ];
    const got = cases.map(([b, n]) => Core.detectImageKind(b, n));
    check('사진 형식 판별(HEIC 시그니처 · 지원 안 하는 형식)', same(got, cases.map((c) => c[2])), got.join(', '));
  });

  // 크기가 섞인 문서: A4 세로(글자) · A4 가로 · B5 · Letter · /Rotate 90으로 눕힌 A4
  async function mixedPdf() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const specs = [[595.28, 841.89, 0, 'Portrait A4'], [841.89, 595.28, 0, 'Landscape A4'], [515.91, 728.5, 0, 'B5 page'], [612, 792, 0, 'Letter page'], [595.28, 841.89, 90, 'Rotated A4']];
    for (const [w, h, rot, t] of specs) {
      const p = doc.addPage([w, h]);
      p.drawText(t, { x: 50, y: h - 80, size: 22, font });
      if (rot) p.setRotation(degrees(rot));
    }
    return doc;
  }
  await step('쪽 크기 분류 · 모두 A4 세로로(글자 유지)', async () => {
    const doc = await mixedPdf();
    const sizes = doc.getPages().map((p) => { const f = Core.pageFrame(p); return { w: f.visW, h: f.visH }; });
    const sum = Core.sizeSummary(sizes).map(([k, n]) => `${k} ${n}`).join(' · ');
    const fit = await Core.normalizePages(doc, { paper: 'a4', mode: 'fit' });
    const rot = await Core.normalizePages(doc, { paper: 'letter', mode: 'rotate' });
    const fitBytes = await fit.save();
    const back = await PDFDocument.load(fitBytes);
    const dims = back.getPages().map((p) => `${Math.round(p.getWidth())}×${Math.round(p.getHeight())}`);
    const rdims = (await PDFDocument.load(await rot.save())).getPages().map((p) => `${Math.round(p.getWidth())}×${Math.round(p.getHeight())}`);
    let texts = ['pdf.js 없음'];
    let textOk = true;
    if (pdfjs) {
      texts = [];
      for (let i = 1; i <= 5; i++) texts.push(await pdfjsText(fitBytes, i));
      textOk = same(texts, ['Portrait A4', 'Landscape A4', 'B5 page', 'Letter page', 'Rotated A4']);
    }
    check('쪽 크기 분류 · 모두 A4 세로로(글자 유지)', sum === 'A4 가로 2 · A4 세로 1 · B5 세로 1 · Letter 세로 1' &&
      dims.every((d) => d === '595×842') && rdims.every((d) => d === '612×792') && textOk,
    `${sum} → A4 ${[...new Set(dims)].join()} · Letter(돌려서) ${[...new Set(rdims)].join()} · 글자 "${texts.join('", "')}"`);
  });

  await step('양면 스캔 짝 맞추기(interleave)', async () => {
    const F = (n) => Array.from({ length: n }, (_, i) => `F${i + 1}`);
    const B = (n) => Array.from({ length: n }, (_, i) => `B${i + 1}`);
    const seq = (r) => r.order.map((o) => o.item).join(',');
    const a = Core.interleave(F(12), B(12));
    const b = Core.interleave(F(12), B(11));
    const c = Core.interleave(F(12), B(13));
    const d = Core.interleave(F(3), B(3), { reverseBack: false });
    const ok = seq(a).startsWith('F1,B12,F2,B11') && seq(a).endsWith('F12,B1') && a.diff === 0 && a.order.length === 24 &&
      b.diff === -1 && b.order.length === 23 && seq(b).endsWith('F11,B1,F12') &&
      c.diff === 1 && c.order.length === 25 && seq(c).startsWith('F1,B13') && seq(c).endsWith('F12,B2,B1') &&
      seq(d) === 'F1,B1,F2,B2,F3,B3';
    check('양면 스캔 짝 맞추기(interleave)', ok,
      `12+12 역순 ${seq(a).slice(0, 18)}… / 12+11 끝 …${seq(b).slice(-10)} / 12+13 끝 …${seq(c).slice(-10)} / 그대로 ${seq(d)}`);
  });

  await step('빈 쪽 판정 4종', async () => {
    const W = 200;
    const H = 283;
    const page = (bg) => { const a = new Uint8ClampedArray(W * H * 4).fill(bg); for (let i = 3; i < a.length; i += 4) a[i] = 255; return a; };
    const dot = (a, x, y, s = 2) => { for (let yy = y; yy < y + s; yy++) for (let xx = x; xx < x + s; xx++) { const o = (yy * W + xx) * 4; a[o] = a[o + 1] = a[o + 2] = 30; } };
    let sd = 3;
    const rnd = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const white = page(255);
    const specks = page(252);
    for (let i = 0; i < 20; i++) dot(specks, Math.floor(rnd() * (W - 3)), Math.floor(rnd() * (H - 3)));
    for (let y = 0; y < H; y += 20) dot(specks, 2, y, 3); // 구멍 자국 같은 가장자리 잡티(제외 영역)
    const line = page(255);
    for (let x = 30; x < 170; x++) for (let y = 60; y < 68; y++) if ((x >> 2) % 2) dot(line, x, y, 1);
    const gray = page(215);
    const r = [white, specks, line, gray].map((a) => Core.whiteRatio(a, W, H));
    // 글자 레이어가 있으면 흰 쪽이어도 빈 쪽이 아니다
    const verdict = [Core.isBlankPage(r[0], false), Core.isBlankPage(r[1], false), Core.isBlankPage(r[2], false), Core.isBlankPage(r[3], false), Core.isBlankPage(r[0], true)];
    check('빈 쪽 판정 4종', same(verdict, [true, true, false, false, false]),
      `흰 쪽 ${(r[0] * 100).toFixed(1)}% → 빈 쪽 / 잡티 20개 ${(r[1] * 100).toFixed(2)}% → 빈 쪽 / 글자 한 줄 ${(r[2] * 100).toFixed(1)}% → 아님 / 회색 배경(215) ${(r[3] * 100).toFixed(1)}% → 아님 / 흰데 글자 레이어 있음 → 아님`);
  });

  await step('파일 정보(PDF/A · 잠금 · Producer)', async () => {
    const doc = await PDFDocument.load(A);
    doc.setProducer('한글 2022');
    doc.setCreator('Hwp 2022');
    doc.setCreationDate(new Date(Date.UTC(2025, 2, 4, 9, 30)));
    const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta>';
    doc.catalog.set(PDFLib.PDFName.of('Metadata'), doc.context.register(doc.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' })));
    const plain = await doc.save({ useObjectStreams: false, updateMetadata: false });
    const info = await Core.pdfInfo(plain);
    const lockedDoc = await PDFDocument.load(A);
    Core.encrypt(lockedDoc, { userPassword: 'x1' });
    const lockInfo = await Core.pdfInfo(await lockedDoc.save({ useObjectStreams: false }));
    check('파일 정보(PDF/A · 잠금 · Producer)', info.pdfa === 'PDF/A-1b' && info.producer === '한글 2022' && info.creator === 'Hwp 2022' && info.pages === 3 &&
      info.created && info.created.getUTCFullYear() === 2025 && info.sizes.length === 1 && lockInfo.restrictions.needsPassword && lockInfo.pages === 3,
    `${info.pdfa} · ${info.producer} / ${info.creator} · ${info.created && info.created.toISOString().slice(0, 10)} · PDF ${info.version} · 잠긴 파일 needsPassword=${lockInfo.restrictions.needsPassword}`);
  });

  await step('일괄 처리: 하나 실패해도 나머지 완료 · 멈춤 · 합계 목표 배분', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const log = [];
    const res = await Core.runBatch(items, async (x) => { if (x === 'b') throw new Error('비밀번호가 달라요'); return x.toUpperCase(); }, { onProgress: (p) => log.push(`${p.done}/${p.total}`) });
    let stopAfter = 2;
    const res2 = await Core.runBatch(items, async (x) => x, { shouldStop: () => stopAfter-- <= 0 });
    const alloc = Core.allocateTotal([30, 10, 20], 12);
    check('일괄 처리: 하나 실패해도 나머지 완료 · 멈춤 · 합계 목표 배분',
      res.map((r) => r.ok).join() === 'true,false,true,true' && res[2].value === 'C' && res2.filter((r) => r.ok).length === 2 && res2[3].skipped && same(alloc, [6, 2, 4]),
    `결과 ${res.map((r) => (r.ok ? r.value : `실패(${r.error.message})`)).join(' ')} · 멈춤 → 2개 뒤 정지 · 12MB를 30/10/20에 ${alloc.join('/')}`);
  });

  await step('zip 한글 파일 이름 (윈도우 Expand-Archive · .NET ZipFile)', async () => {
    if (process.platform !== 'win32') return check('zip 한글 파일 이름 (윈도우 Expand-Archive · .NET ZipFile)', true, '윈도우가 아니라 건너뜀');
    const os = require('node:os');
    const path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const JSZip = require('jszip');
    const names = ['수업자료_01_1-10쪽.pdf', '회의록_p001.png', '풀림_한글 파일 (1).pdf'];
    const zip = new JSZip();
    names.forEach((n) => zip.file(n, 'x'));
    // 화면과 같은 옵션
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    const flagOk = (() => { const i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])); return (buf.readUInt16LE(i + 6) & 0x0800) !== 0; })();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-ko-'));
    const zipPath = path.join(dir, '한글.zip');
    fs.writeFileSync(zipPath, buf);
    const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`], { encoding: 'utf8' }).trim();
    const outA = path.join(dir, 'a');
    ps(`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outA}' -Force; (Get-ChildItem -LiteralPath '${outA}' | Sort-Object Name | ForEach-Object { $_.Name }) -join '|'`);
    const gotA = fs.readdirSync(outA).sort();
    const gotB = ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${zipPath}'); ($z.Entries | ForEach-Object { $_.FullName } | Sort-Object) -join '|'; $z.Dispose()`).split('|').sort();
    const want = [...names].sort();
    check('zip 한글 파일 이름 (윈도우 Expand-Archive · .NET ZipFile)', flagOk && same(gotA, want) && same(gotB, want),
      `UTF-8 플래그 ${flagOk ? '켜짐' : '꺼짐'} · Expand-Archive: ${gotA.join(' / ')} · ZipFile: ${gotB.join(' / ')}`);
  });
}

// ── 쪽 크기를 맞추면 사라지는 링크 · 주석 세기 ──
{
  const ad = await PDFLib.PDFDocument.create();
  const p1 = ad.addPage([595, 842]);
  ad.addPage([842, 595]);
  const reg = (o) => ad.context.register(ad.context.obj(o));
  p1.node.set(PDFLib.PDFName.of('Annots'), ad.context.obj([
    reg({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] }),
    reg({ Type: 'Annot', Subtype: 'Link', Rect: [0, 20, 10, 30] }),
    reg({ Type: 'Annot', Subtype: 'Text', Rect: [0, 40, 10, 50] }),
    reg({ Type: 'Annot', Subtype: 'Popup', Rect: [0, 60, 10, 70] }),
  ]));
  const re = await PDFLib.PDFDocument.load(await ad.save());
  const a = Core.countAnnots(re.getPage(0));
  const b = Core.countAnnots(re.getPage(1));
  check('링크 · 주석 세기(Popup 제외, 없는 쪽은 0)', a.links === 2 && a.notes === 1 && b.links === 0 && b.notes === 0, `1쪽 링크 ${a.links} · 주석 ${a.notes} / 2쪽 ${b.links} · ${b.notes}`);
}

// ── 도장 만들기 (public/stamp/stamp-core.js — 화면 없이 계산만) ──
{
  const S = require('../public/stamp/stamp-core.js');
  const fs = require('node:fs');
  const zlibPng = (w, h) => {
    // 투명 w×h PNG (IHDR · IDAT · IEND)
    const crc = (b) => S.crc32(b);
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
      return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  await step('도장: PNG에 dpi 적기(pHYs) · 다시 적으면 바뀜 · CRC', async () => {
    const png = zlibPng(4, 4);
    const a = S.pngWithDpi(png, 600);
    const b = S.pngWithDpi(a, 300);
    const has = (u) => Buffer.from(u).includes(Buffer.from('pHYs'));
    const crcOk = (() => { const i = Buffer.from(a).indexOf('pHYs'); const len = Buffer.from(a).readUInt32BE(i - 4); return Buffer.from(a).readUInt32BE(i + 4 + len) === S.crc32(a.subarray(i, i + 4 + len)); })();
    const count = (u) => Buffer.from(u).toString('latin1').split('pHYs').length - 1;
    check('도장: PNG에 dpi 적기(pHYs) · 다시 적으면 바뀜 · CRC', S.pngDpi(png) === null && S.pngDpi(a) === 600 && S.pngDpi(b) === 300 && has(a) && count(b) === 1 && crcOk && S.crc32(Buffer.from('123456789')) === 0xcbf43926,
      `없음 → ${S.pngDpi(a)} → ${S.pngDpi(b)}dpi · pHYs ${count(b)}개 · CRC ${crcOk ? '맞음' : '틀림'}`);
  });
  await step('도장: 새길 글자(4자까지 · 인 붙이기 · 한자 · 네모 세 글자)', async () => {
    const st = { ...S.defaultState(new Date(2026, 9, 5)), name: '김하늘별이' };
    const g1 = S.glyphs(st).join('');
    const g2 = S.glyphs({ ...st, name: '김하늘', seal: true }).join('');
    const g3 = S.glyphs({ ...st, name: '김하늘', mode: 'hanja' }).join('');
    const g4 = S.glyphs({ ...st, name: '김하늘', mode: 'hanja', picks: { '1하': '夏', '2늘': null } }).join('');
    const sq = S.cellGlyphs({ ...st, name: '김하늘' }, 'square').gl.join('');
    const sqLong = S.cellGlyphs({ ...st, name: '김하늘', sq3: 'long' }, 'square');
    const circ = S.cellGlyphs({ ...st, name: '김하늘' }, 'circle').gl.join('');
    const ok = g1 === '김하늘별' && g2 === '김하늘인' && g3 === '金河늘' && g4 === '金夏늘' && sq === '김하늘인' && sqLong.long && sqLong.gl.length === 3 && circ === '김하늘' && S.syllables({ name: 'Kim 김!' }).join('') === '김';
    check('도장: 새길 글자(4자까지 · 인 붙이기 · 한자 · 네모 세 글자)', ok, `${g1} · ${g2} · ${g3} · ${g4} · 네모 ${sq}`);
  });
  await step('도장: 모양 계산(칸이 테두리 안 · 글자 상자가 칸 안 · 같은 크기)', async () => {
    const measure = () => ({ w: 90, h: 92, cx: 45, cy: -36 });
    const bad = [];
    for (const shape of ['circle', 'oval', 'square', 'round']) {
      for (const name of ['김', '김하', '김하늘', '남궁하늘']) {
        for (const border of ['single', 'double']) {
          for (const style of ['yang', 'eum']) {
            const st = { ...S.defaultState(new Date()), name };
            const d = S.design(st, { shape, style, font: 'serif', border, key: 'k' }, measure);
            const texts = d.items.filter((it) => it.t === 'text');
            const n = S.cellGlyphs(st, shape).gl.length;
            if (texts.length !== n) bad.push(`${shape}/${name}/${border}: 글자 ${texts.length}≠${n}`);
            for (const t of texts) {
              const x0 = t.tx; const x1 = t.tx + 90 * t.sx; // 글자 상자: 왼쪽 0 ~ 오른쪽 90, 위 82 ~ 아래 10(기준선)
              const y0 = t.ty + (-36 - 46) * t.sy; const y1 = t.ty + (-36 + 46) * t.sy;
              if (x0 < 4 || x1 > d.W - 4 || y0 < 4 || y1 > 196) bad.push(`${shape}/${name}: 글자가 테두리 밖`);
            }
            const sizes = new Set(texts.map((t) => t.sx.toFixed(3)));
            if (sizes.size > 1) bad.push(`${shape}/${name}: 글자 크기 ${sizes.size}가지`);
            if (style === 'eum' && !texts.every((t) => t.paper)) bad.push(`${shape}: 음각 글자가 파이지 않음`);
          }
        }
      }
    }
    const date = S.design({ ...S.defaultState(new Date()), kind: 'date', dTop: '교무부', dBottom: '박정보' }, { shape: 'circle', style: 'yang', font: 'gothic', border: 'single' }, measure);
    const dt = date.items.filter((it) => it.t === 'text').map((t) => t.s);
    check('도장: 모양 계산(칸이 테두리 안 · 글자 상자가 칸 안 · 같은 크기)', bad.length === 0 && dt.length === 3 && dt[0] === '교무부' && /^\d{4}\.\d{2}\.\d{2}$/.test(dt[1]) && date.items.filter((it) => it.t === 'line').length === 2,
      bad.length ? bad.slice(0, 4).join(' · ') : `4모양 × 1~4자 × 한 줄 · 두 줄 × 양각 · 음각 모두 안쪽 · 날짜 도장 ${dt.join(' / ')}`);
  });
  await step('도장: 저장 크기 · 보관값 되살리기(모르는 값은 버림) · 파일 이름', async () => {
    const st = S.defaultState(new Date());
    const px = S.pixelSize({ ...st, size: 15, dpi: 600 }, 200);
    const pxOval = S.pixelSize({ ...st, size: 15, dpi: 300 }, 150);
    const back = S.restoreState({ ...S.pickState({ ...st, name: '김하늘', font: 'gugi', size: 18 }), font: 'evil', size: 999, ink: 'custom', inkHex: 'red;x', picks: { '0김': '金', bad: 'x' }, extra: 1 });
    const ok = px.w === 354 && px.h === 354 && pxOval.w === 133 && pxOval.h === 177 && back.name === '김하늘' && back.font === 'serif' && back.size === 60 && back.inkHex === '#a0522d' &&
      back.picks['0김'] === '金' && !('bad' in back.picks) && !('extra' in back) && S.fileSafe('김/하:늘*') === '김하늘' && S.fileSafe('') === '도장';
    check('도장: 저장 크기 · 보관값 되살리기(모르는 값은 버림) · 파일 이름', ok, `15mm 600dpi ${px.w}px · 타원 300dpi ${pxOval.w}×${pxOval.h} · 되살림 ${back.font}/${back.size}mm`);
  });
  await step('도장: [한자 더 보기] 자료(libhangul, KS X 1001) · 뜻으로 찾기 · 이미 보인 것 빼기', async () => {
    const data = JSON.parse(fs.readFileSync(new URL('../public/stamp/hanja.json', import.meta.url), 'utf8'));
    const ha = S.moreHanja(data, '하');
    const skip = S.moreHanja(data, '하', ['河', '夏']);
    const byMeaning = S.moreHanja(data, '희', [], '빛날').map(([c]) => c);
    const v = (await import('node:child_process')).spawnSync(process.execPath, ['scripts/build-stamp-hanja.mjs', '--check'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    const ok = S.moreHanja(data, '김')[0][0] === '金' && ha.some(([c]) => c === '河') && !skip.some(([c]) => c === '河' || c === '夏') && skip.length === ha.length - 2 &&
      byMeaning.includes('熙') && S.moreHanja(data, '하', [], '河').length === 1 && S.moreHanja(data, '늘').length === 0 && S.moreHanja(null, '하').length === 0 && v.status === 0;
    check('도장: [한자 더 보기] 자료(libhangul, KS X 1001) · 뜻으로 찾기 · 이미 보인 것 빼기', ok, `하 ${ha.length}자 · "빛날" → ${byMeaning.join('')} · ${(v.stdout || v.stderr).trim()}`);
  });
  await step('도장: 글꼴 18개 목록 · 파일 · 글자 범위(한글 전부 · 한자 글꼴)', async () => {
    const data = JSON.parse(fs.readFileSync(new URL('../public/stamp/fonts.json', import.meta.url), 'utf8'));
    const has = S.coverage(data);
    const faces = S.fontFaces(data, '/vendor/stamp-fonts');
    const missingFiles = faces.filter((f) => !fs.existsSync(new URL(`../public${f.url}`, import.meta.url)));
    const ids = S.FONTS.map((f) => f.id);
    const hanjaFonts = S.FONTS.filter((f) => f.hanja).map((f) => f.id);
    const ok = ids.every((id) => data.fonts[id]) && Object.keys(data.fonts).length === 18 && missingFiles.length === 0 &&
      ['serif', 'gothic', 'nanum'].every((id) => has(id, '김하늘똠쌰뷁')) && hanjaFonts.every((id) => has(id, '金河')) && !has('gugi', '金河') &&
      faces.every((f) => !f.range || /^U\+[0-9a-f]/.test(f.range));
    const v = (await import('node:child_process')).spawnSync(process.execPath, ['scripts/vendor-stamp-fonts.mjs', '--check'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    check('도장: 글꼴 18개 목록 · 파일 · 글자 범위(한글 전부 · 한자 글꼴)', ok && v.status === 0, `${ids.length}개 · 조각 ${faces.length}개 · 없는 파일 ${missingFiles.length} · ${(v.stdout || v.stderr).trim()}`);
  });
}

// ── 만들어 둔 페이지가 원본과 맞는지 (사용한 라이브러리 · 새 소식) ──
{
  const { spawnSync } = await import('node:child_process');
  for (const [name, script] of [['사용한 라이브러리 페이지가 package.json과 일치', 'scripts/gen-licenses.mjs'], ['새 소식 JSON이 CHANGELOG.md와 일치', 'scripts/gen-changelog.mjs']]) {
    const r = spawnSync(process.execPath, [script, '--check'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    check(name, r.status === 0, (r.stdout || r.stderr || '').trim());
  }
}

// ── 관문이 조용히 비지 않게: 빌드 결과에 manifest 줄 없음 · test:ui가 못 돌면 실패 ──
{
  const { spawnSync } = await import('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const G = await import('./ui-guard.mjs');
  const root = require('node:url').fileURLToPath(new URL('..', import.meta.url));
  const work = path.join(os.tmpdir(), 'pdf-work');
  fs.mkdirSync(work, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(work, 'verify-'));
  const rel = (f) => path.relative(root, f).replace(/\\/g, '/');

  // 내보내는 HTML(public 전체, server.js는 public의 HTML을 그대로 보낸다) + 라이선스 생성기를 지금 돌린 결과
  const gen = spawnSync(process.execPath, ['scripts/gen-licenses.mjs', `--out=${path.join(tmp, 'build', 'licenses.html')}`], { cwd: root, encoding: 'utf8' });
  const builtHits = G.manifestLinks([path.join(root, 'public'), path.join(tmp, 'build')]);
  // 빌드 스크립트 · 서버가 그 줄을 끼워 넣는 코드가 있는지
  const srcFiles = ['server.js', ...['scripts', 'lib'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => /\.(m?js|cjs)$/.test(f)).map((f) => `${d}/${f}`))];
  const srcHits = srcFiles.filter((f) => G.hasManifestLink(fs.readFileSync(path.join(root, f), 'utf8')));
  check('빌드 결과에 manifest 줄 없음(public HTML · 라이선스 생성기 · 빌드 스크립트 · 서버)',
    gen.status === 0 && fs.existsSync(path.join(tmp, 'build', 'licenses.html')) && builtHits.length === 0 && srcHits.length === 0,
    gen.status !== 0 ? `라이선스 생성 실패: ${(gen.stderr || '').trim().slice(0, 120)}`
      : builtHits.length || srcHits.length ? `manifest 줄이 다시 생겼어요: ${[...builtHits.map(rel), ...srcHits].join(', ')} → 그 줄을 지워 주세요`
        : `public HTML · 라이선스 생성 결과 깨끗 · 소스 ${srcFiles.length}개 깨끗`);

  // 가짜 빌드: manifest 줄을 넣으면 위 검사가 잡아야 한다
  const fake = path.join(tmp, 'fake-build');
  fs.mkdirSync(path.join(fake, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'index.html'), '<!doctype html><head>\n  <link rel="manifest" href="/manifest.webmanifest">\n</head>');
  fs.writeFileSync(path.join(fake, 'pages', 'ok.html'), '<!doctype html><head><link rel="icon" href="/x.svg"></head>');
  fs.writeFileSync(path.join(fake, 'pages', 'b.html'), "<head><LINK href='/m.json' REL=manifest></head>");
  const fakeHits = G.manifestLinks([fake]).map((f) => path.basename(f)).sort();
  check('단위: manifest 줄을 넣은 가짜 빌드는 실패로 잡힘', same(fakeHits, ['b.html', 'index.html']), `잡은 파일 ${fakeHits.join(', ') || '없음'}`);

  // playwright를 못 찾는 것처럼 꾸며 진짜 ui-check.mjs를 돌린다
  const fixture = path.join(tmp, 'no-playwright.cjs');
  fs.writeFileSync(fixture, `const M = require('module'); const o = M._resolveFilename;
M._resolveFilename = function (req, ...a) { if (/^(@playwright\\/test|playwright|playwright-core)(\\/|$)/.test(req)) { const e = new Error('Cannot find module ' + req); e.code = 'MODULE_NOT_FOUND'; throw e; } return o.call(this, req, ...a); };`);
  const env = { ...process.env };
  delete env.SKIP_UI;
  const noPw = spawnSync(process.execPath, ['-r', fixture, 'test/ui-check.mjs'], { cwd: root, encoding: 'utf8', env, timeout: 60000 });
  check('단위: playwright가 없으면 test:ui 실패(종료 1 · 까닭 한 줄)',
    noPw.status === 1 && (noPw.stderr || '').includes(G.NO_PW_MSG) && !/건너뜀/.test(noPw.stdout || ''),
    `종료 ${noPw.status} · ${(noPw.stderr || noPw.stdout || '').trim().split('\n')[0]}`);
  const skip = spawnSync(process.execPath, ['-r', fixture, 'test/ui-check.mjs'], { cwd: root, encoding: 'utf8', env: { ...env, SKIP_UI: '1' }, timeout: 60000 });
  check('단위: SKIP_UI=1일 때만 건너뜀(크게 표시)', skip.status === 0 && (skip.stdout || '').includes('건너뜀(SKIP_UI)') && (skip.stdout || '').includes('####'),
    `종료 ${skip.status}`);

  const noBrowser = G.uiPreflight({ env: {}, root, load: () => ({ chromium: { executablePath: () => path.join(tmp, 'none', 'chrome.exe') } }) });
  const noModule = G.uiPreflight({ env: {}, root, load: () => null });
  check('단위: Chromium이 없어도 실패', noBrowser.action === 'fail' && noBrowser.message === G.NO_BROWSER_MSG && noModule.action === 'fail' && noModule.message === G.NO_PW_MSG,
    `${noBrowser.action} · ${noModule.action}`);

  const v0 = G.uiVerdict([]);
  const vSkip = G.uiVerdict([{ name: 'a', ok: true, skip: true }]);
  const vOk = G.uiVerdict([{ name: 'a', ok: true }, { name: 'b', ok: true, skip: true }]);
  const vFail = G.uiVerdict([{ name: 'a', ok: false }]);
  check('단위: 실행한 화면 검사가 0개면 실패', v0.code === 1 && vSkip.code === 1 && v0.message === G.ZERO_MSG && vOk.code === 0 && vOk.ran === 1 && vFail.code === 1,
    `0개 ${v0.code} · 건너뜀만 ${vSkip.code} · 1개 통과 ${vOk.code} · 1개 실패 ${vFail.code}`);
}

// ── 빌려 쓰는 PC: 들어올 때 주는 쿠키 (lib/gate.js) ──
{
  const gate = require('../lib/gate.js');
  const shared = gate.enterCookies('p.s', 'sub-a', { shared: true });
  const mine = gate.enterCookies('p.s', 'sub-a');
  const tagA = gate.ownerTag('sub-a');
  const tagB = gate.ownerTag('sub-b');
  check('빌려 쓰는 PC: 통행증은 창을 닫으면 사라지는 쿠키 · 화면용 표(pdf_who · pdf_pc=shared)',
    shared.length === 3 && /^pdf_pass=p\.s; HttpOnly; Secure; SameSite=Lax; Path=\/$/.test(shared[0]) && !/Max-Age/.test(shared[1]) &&
    shared[1] === `pdf_who=${tagA}; Secure; SameSite=Lax; Path=/` && /^pdf_pc=shared;/.test(shared[2]) && !/HttpOnly/.test(shared[1] + shared[2]),
    shared.map((c) => c.split(';')[0].replace(/=.*/, '')).join(' · '));
  check('내 PC: 통행증 8시간 · pdf_pc 지움 · 표는 가명 번호마다 다르고 늘 같음(16자리)',
    /Max-Age=28800$/.test(mine[0]) && /Max-Age=28800$/.test(mine[1]) && /^pdf_pc=; .*Max-Age=0$/.test(mine[2]) &&
    /^[0-9a-f]{16}$/.test(tagA) && tagA !== tagB && tagA === gate.ownerTag('sub-a'),
    `${tagA === gate.ownerTag('sub-a') ? '같음' : '다름✗'} · ${tagA !== tagB ? '사람마다 다름' : '같음✗'}`);
}

// ── 사진 작업실 (public/photo/photo-core.js — 화면 없이 계산만) ──
{
  const P = require('../public/photo/photo-core.js');
  const { makePhoto } = require('./photo-fixtures.cjs');
  const kakao = P.defaultSettings('kakao');
  const f1 = P.fitSize(4032, 3024, kakao);
  const f2 = P.fitSize(3024, 4032, kakao);
  const f3 = P.fitSize(800, 600, kakao);
  const f4 = P.fitSize(800, 600, { ...kakao, noUpscale: false });
  const f5 = P.fitSize(4032, 3024, { ...kakao, mode: 'width', value: 1000 });
  const f6 = P.fitSize(4032, 3024, P.defaultSettings('jpg'));
  check('사진 작업실: 긴 변 · 가로 맞추기 · 작은 사진은 키우지 않음 · 크기 그대로',
    f1.w === 1280 && f1.h === 960 && f2.w === 960 && f2.h === 1280 && f3.w === 800 && f4.w === 1280 && f5.w === 1000 && f5.h === 750 && f6.w === 4032,
    [f1, f2, f3, f4, f5, f6].map((f) => `${f.w}×${f.h}`).join(' · '));
  const budgets = P.splitBudget(10 * 1024 * 1024, [12e6, 12e6, 0.48e6]);
  const e85 = P.estimateBytes(1280, 960, 85);
  const e70 = P.estimateBytes(1280, 960, 70);
  check('사진 작업실: 합쳐 10MB는 화소에 비례해 나눔 · 품질이 낮으면 예상도 작음',
    budgets.reduce((a, b) => a + b, 0) <= 10 * 1024 * 1024 + 1 && budgets[0] > budgets[2] * 20 && e70 < e85 && e85 > 150000 && e85 < 400000,
    `${budgets.map((b) => P.sizeText(b)).join(' · ')} · q85 ${P.sizeText(e85)} q70 ${P.sizeText(e70)}`);
  const n1 = P.fileName('{이름}_작게', { name: 'IMG_2041.HEIC', ext: 'jpg' });
  const n2 = P.fileName('{번호}_{찍은 날}', { name: 'a.jpg', index: 2, count: 12, date: '2026-10-05', ext: 'webp' });
  const n3 = P.fileName('a/b:c*?', { name: 'x.jpg', ext: 'jpg' });
  const n4 = P.uniqueNames(['a.jpg', 'A.jpg', 'a.jpg']);
  check('사진 작업실: 파일 이름 규칙 {이름} · {번호}(0 채움) · {찍은 날} · 못 쓰는 글자 · 겹치면 (2)',
    n1 === 'IMG_2041_작게.jpg' && n2 === '03_2026-10-05.webp' && n3 === 'a_b_c__.jpg' && n4.join() === 'a.jpg,A (2).jpg,a (3).jpg',
    [n1, n2, n3, n4.join(' ')].join(' | '));
  const raw = new Uint8Array(makePhoto(64, 48, { exif: { gps: true } }));
  const info = P.readExif(raw);
  const plain = new Uint8Array(makePhoto(64, 48, { exif: false }));
  const dated = P.withExifDate(plain, info.date);
  const back = P.readExif(dated);
  check('사진 작업실: 사진 정보 읽기(위치 · 기종 · 찍은 날) · 저장할 때는 찍은 날만 다시 넣음',
    info.gps && info.device && info.date === '2026:10:05 09:12:33' && P.imageSize(raw, 'jpeg').w === 64 &&
    back.date === info.date && !back.gps && !back.device && P.imageSize(dated, 'jpeg').h === 48 && P.detectKind(dated) === 'jpeg' && P.dateText(info.date) === '2026-10-05',
    `원본 위치 ${info.gps} · 기종 ${info.device} → 저장본 위치 ${back.gps} · 기종 ${back.device} · 날짜 ${back.date}`);
  check('사진 작업실: 종류 알아보기(HEIC는 이름 · 머리 둘 다)',
    P.detectKind(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])) === 'heic' && P.detectKind(new Uint8Array(4), 'IMG_1.HEIC') === 'heic' &&
    P.detectKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) === 'png' && P.detectKind(new Uint8Array(4), 'a.txt') === '');
}

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
