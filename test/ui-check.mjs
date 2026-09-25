// 헤드리스 브라우저 점검 (playwright가 있을 때만).
// 실행: node test/ui-check.mjs            점검만
//       node test/ui-check.mjs --screens  점검 + docs/screens/ 에 스크린샷 3장 저장
//   playwright를 프로젝트 밖에 설치했다면 PLAYWRIGHT_DIR=그 폴더 로 알려 준다.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS = process.argv.includes('--screens');

function loadPlaywright() {
  const bases = [process.env.PLAYWRIGHT_DIR, root].filter(Boolean);
  for (const base of bases) {
    const req = createRequire(path.join(path.resolve(base), 'noop.js'));
    for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
      try { return req(name); } catch { /* 다음 후보 */ }
    }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) {
  console.log('playwright가 없어 브라우저 점검을 건너뜀');
  process.exit(0);
}

const PDFLib = require('@cantoo/pdf-lib');
const { PDFDocument, StandardFonts, rgb } = PDFLib;
const JSZip = require('jszip');

const PORT = 4000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ui-'));

/** 문서처럼 보이는 샘플 PDF (제목 + 글줄 모양) */
async function samplePdf(n, label, w = 595, h = 842) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([w + i, h]);
    p.drawText(`${label} ${i + 1}`, { x: 60, y: h - 110, size: 40, font, color: rgb(0.1, 0.13, 0.2) });
    p.drawRectangle({ x: 60, y: h - 140, width: 120, height: 6, color: rgb(0.2, 0.33, 1) });
    for (let k = 0; k < 16; k++) {
      const lw = 380 + ((k * 53 + i * 31) % 90);
      p.drawRectangle({ x: 60, y: h - 190 - k * 34, width: k % 5 === 4 ? lw * 0.55 : lw, height: 9, color: rgb(0.82, 0.85, 0.9) });
    }
  }
  return doc;
}
async function writePdf(name, doc, opts) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, await doc.save(opts));
  return f;
}

// CSP가 eval을 막으므로 waitForFunction 대신 evaluate로 기다린다.
async function until(pg, fn, arg, { timeout = 10000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await pg.evaluate(fn, arg)) return;
    if (Date.now() > end) throw new Error(`기다리다 시간 초과: ${String(fn).slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const visible = (pg, sel) => pg.$eval(sel, (e) => {
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
});
const radio = (pg, name, value) => pg.click(`label:has(> input[name="${name}"][value="${value}"])`);

const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });

function watch(pg, list) {
  pg.on('console', (m) => m.type() === 'error' && list.push(m.text()));
  pg.on('pageerror', (e) => list.push(String(e)));
  pg.on('response', (r) => r.status() >= 400 && list.push(`${r.status()} ${r.url()}`));
}

const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('http://') && resolve());
  server.on('error', reject);
  setTimeout(() => reject(new Error('서버가 뜨지 않음')), 10000);
});

const browser = await pw.chromium.launch();
try {
  const fileA = await writePdf('보고서A.pdf', await samplePdf(3, 'A'));
  const fileB = await writePdf('자료B.pdf', await samplePdf(4, 'B'));
  const encDoc = await samplePdf(2, 'E');
  encDoc.encrypt({ userPassword: 'secret1', ownerPassword: 'owner1' });
  const fileEnc = await writePdf('잠긴C.pdf', encDoc, { useObjectStreams: false });
  const notPdf = path.join(tmp, '가짜.pdf');
  fs.writeFileSync(notPdf, 'this is not a pdf');

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, colorScheme: 'light' });
  const page = await ctx.newPage();

  // 테스트 사진: 화면을 찍어 PNG, 그리고 EXIF 방향값 6(90도 회전)을 넣은 JPEG
  await page.setContent('<div style="width:200px;height:100px;background:linear-gradient(90deg,red,blue)"></div>');
  const png = path.join(tmp, '사진.png');
  fs.writeFileSync(png, await page.screenshot({ type: 'png', clip: { x: 8, y: 8, width: 200, height: 100 } }));
  const jpg = await page.screenshot({ type: 'jpeg', quality: 90, clip: { x: 8, y: 8, width: 200, height: 100 } });
  const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]);
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (app1Body.length + 2) >> 8, (app1Body.length + 2) & 0xff]), app1Body]);
  const phone = path.join(tmp, '휴대폰.jpg');
  fs.writeFileSync(phone, Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]));

  const errors = [];
  watch(page, errors);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await until(page, () => window.__pdfWorkshop && window.__pdfWorkshop.ready);

  // ── 1. 처음 화면 ──
  check('첫 화면 콘솔 에러 0개', errors.length === 0, errors.length ? errors.join(' | ').slice(0, 200) : '0개');
  const home = await page.evaluate(() => {
    const t = document.getElementById('home-title').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.tool-card')].map((c) => {
      const r = c.getBoundingClientRect();
      return { t: c.querySelector('strong').textContent, w: Math.round(r.width), h: Math.round(r.height), bottom: r.bottom };
    });
    return {
      title: document.getElementById('home-title').textContent,
      tw: Math.round(t.width), th: Math.round(t.height),
      cards, vh: innerHeight,
      work: document.getElementById('view-work').hidden,
      font: document.fonts.check('800 16px "Pretendard Variable"'),
    };
  });
  check('처음 화면: 제목이 보임', home.tw > 200 && home.th > 20 && home.work, `"${home.title}" ${home.tw}×${home.th}, 작업 화면 숨김`);
  check('처음 화면: 도구 카드 5개가 보임', home.cards.length === 5 && home.cards.every((c) => c.w > 100 && c.h > 100 && c.bottom <= home.vh),
    home.cards.map((c) => `${c.t}(${c.w}×${c.h})`).join(', '));
  check('Pretendard 글꼴 적용', home.font, home.font ? '"Pretendard Variable" 로드됨' : '대체 글꼴 사용 중');

  // 배포 버전 표시
  const ver = await (await fetch(`${BASE}/version`)).json();
  check('/version 응답에 commit이 있다', typeof ver.commit === 'string' && /^([0-9a-f]{7}|dev)$/.test(ver.commit) && !Number.isNaN(Date.parse(ver.builtAt)),
    JSON.stringify(ver));
  await until(page, () => document.getElementById('home-version').textContent.length > 0);
  const homeVer = await page.evaluate(() => {
    const el = document.getElementById('home-version');
    const r = el.getBoundingClientRect();
    return { text: el.textContent, w: r.width, h: r.height, right: Math.round(r.right), mainRight: Math.round(document.querySelector('.home-main').getBoundingClientRect().right) };
  });
  await page.click('.tool-card[data-open="edit"]');
  const sideVer = await page.evaluate(() => {
    const el = document.getElementById('side-version');
    const r = el.getBoundingClientRect();
    return { text: el.textContent, visible: r.width > 0 && r.height > 0 && r.bottom <= innerHeight };
  });
  await page.click('#logo');
  const html = await (await fetch(`${BASE}/`)).text();
  const busted = ['style.css', 'pdf-core.js', 'app.js'].every((a) => html.includes(`${a}?v=${ver.commit}`));
  check('화면에 v 표시가 보인다 (+ 파일 주소에 ?v=커밋)', homeVer.text === `v ${ver.commit}` && homeVer.w > 0 && homeVer.h > 0 && sideVer.text === `v ${ver.commit}` && sideVer.visible && busted,
    `처음 화면 "${homeVer.text}", 사이드바 "${sideVer.text}", ?v=${ver.commit} ${busted ? '적용' : '없음'}`);

  // ── 2. 카드 → 작업 화면, 로고 → 처음 화면 ──
  const tools = ['edit', 'img2pdf', 'pdf2img', 'lock', 'number'];
  const nav = [];
  for (const t of tools) {
    await page.click(`.tool-card[data-open="${t}"]`);
    const st = await page.evaluate((name) => ({
      work: !document.getElementById('view-work').hidden,
      home: document.getElementById('view-home').hidden,
      panel: !document.getElementById(`panel-${name}`).hidden,
      others: [...document.querySelectorAll('.panel')].filter((p) => !p.hidden).length,
      sel: document.querySelector('.tab[aria-selected="true"]').dataset.tab,
      h1: document.querySelector(`#panel-${name} h1`).getBoundingClientRect().height,
    }), t);
    const ok1 = st.work && st.home && st.panel && st.others === 1 && st.sel === t && st.h1 > 0;
    await page.click('#logo');
    const back = await page.evaluate(() => !document.getElementById('view-home').hidden && document.getElementById('view-work').hidden);
    nav.push(`${t}:${ok1 && back ? 'OK' : 'X'}`);
  }
  check('도구 카드 → 해당 도구, 로고 → 처음 화면', nav.every((x) => x.endsWith('OK')), nav.join(' '));

  // 사이드바 키보드 이동
  await page.click('.tool-card[data-open="edit"]');
  await page.focus('#tab-edit');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const kb = await page.evaluate(() => ({ sel: document.querySelector('.tab[aria-selected="true"]').dataset.tab, focus: document.activeElement.id }));
  const tabRects = await page.$$eval('.tab', (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 100 && r.height > 30;
  }));
  check('사이드바 도구 5개 · 화살표 키 이동', tabRects.length === 5 && tabRects.every(Boolean) && kb.sel === 'pdf2img' && kb.focus === 'tab-pdf2img',
    `↓↓ → ${kb.sel}`);
  await page.click('#logo');

  // ── 3. 처음 화면에서 PDF + 사진을 함께 넣기 ──
  await page.setInputFiles('#home-input', [fileA, fileB, png]);
  await until(page, () => document.querySelectorAll('#edit-grid .page-card').length === 7);
  await until(page, () => document.querySelectorAll('#edit-grid .page-card canvas').length === 7, undefined, { timeout: 15000 });
  await until(page, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('사진 1장은')));
  const routed = await page.evaluate(() => ({
    tab: document.querySelector('.tab[aria-selected="true"]').dataset.tab,
    work: !document.getElementById('view-work').hidden,
    imgs: document.querySelectorAll('#img-grid .img-card').length,
    chips: [...document.querySelectorAll('#edit-chips .chip:not(.add)')].map((c) => c.textContent.trim()),
    add: !!document.querySelector('#edit-chips .chip.add'),
    empty: document.getElementById('edit-empty').hidden,
  }));
  check('처음 화면에 PDF+사진 → 편집 화면, 사진은 사진→PDF로', routed.work && routed.tab === 'edit' && routed.imgs === 1 && routed.chips.length === 2 && routed.add && routed.empty,
    `편집 칩 ${routed.chips.join(' / ')} + "PDF 더 넣기", 사진→PDF 목록 ${routed.imgs}장, 알림 표시`);

  // 드래그: 1번 카드를 3번 카드 뒤로
  const labels = () => page.$$eval('#edit-grid .page-src', (els) => els.map((e) => e.textContent));
  const c1 = await page.locator('#edit-grid .page-card').nth(0).boundingBox();
  const c3 = await page.locator('#edit-grid .page-card').nth(2).boundingBox();
  await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2);
  await page.mouse.down();
  await page.mouse.move(c1.x + c1.width / 2 + 20, c1.y + c1.height / 2, { steps: 4 });
  const markerShown = await page.$('.drop-marker') !== null;
  await page.mouse.move(c3.x + c3.width * 0.8, c3.y + c3.height / 2, { steps: 10 });
  await page.mouse.up();
  const afterDrag = await labels();
  check('마우스로 끌어 순서 바꾸기(+놓일 위치 표시)', markerShown && afterDrag.slice(0, 3).join(',') === '보고서A · 2쪽,보고서A · 3쪽,보고서A · 1쪽',
    `표시 ${markerShown ? '있음' : '없음'} → ${afterDrag.slice(0, 3).join(', ')}`);

  // 회전, 삭제 예정, 되돌리기 띠
  const card0 = page.locator('#edit-grid .page-card').nth(0);
  await card0.hover();
  await card0.locator('.card-tools [data-act="rot"]').click();
  await page.waitForTimeout(400);
  const rotated = await card0.getAttribute('aria-label');
  const card1 = page.locator('#edit-grid .page-card').nth(1);
  await card1.hover();
  await card1.locator('.card-tools [data-act="del"]').click();
  const delCount = await page.textContent('#edit-count');
  const band = await card1.locator('.del-band').evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { text: e.textContent, shown: r.height > 0, bg: getComputedStyle(e).backgroundColor };
  });
  await card1.locator('.del-band').click();
  const restored = await card1.evaluate((e) => !e.classList.contains('deleted'));
  await card1.hover();
  await card1.locator('.card-tools [data-act="del"]').click(); // 다시 삭제 예정으로
  check('회전 · 삭제 예정 띠 · 되돌리기', /90도 회전/.test(rotated) && band.shown && band.text === '삭제 예정 · 되돌리기' && band.bg === 'rgb(209, 67, 67)' && restored && /6쪽 저장 예정/.test(delCount),
    `${rotated} / "${band.text}" / ${delCount}`);

  // 교체
  const card2 = page.locator('#edit-grid .page-card').nth(2);
  await card2.hover();
  await card2.locator('.card-tools [data-act="rep"]').click();
  await page.selectOption('#replace-src', { label: '자료B.pdf (4쪽)' });
  await page.selectOption('#replace-page', '3');
  await page.click('#replace-ok');
  const repLabel = await card2.locator('.page-src').textContent();
  check('쪽 교체 대화상자', repLabel === '자료B · 4쪽', repLabel);

  // 합쳐서 저장
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#edit-save')]);
  let saved = await PDFDocument.load(fs.readFileSync(await dl.path()));
  const rot0 = saved.getPage(0).getRotation().angle;
  check('합쳐서 저장', /^합본_\d{8}\.pdf$/.test(dl.suggestedFilename()) && saved.getPageCount() === 6 && rot0 === 90,
    `${dl.suggestedFilename()} · ${saved.getPageCount()}쪽 · 1쪽 회전 ${rot0}`);

  // 범위 저장
  await page.fill('#edit-range', '1-2, 4');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#edit-save-range')]);
  saved = await PDFDocument.load(fs.readFileSync(await dl.path()));
  check('범위만 저장', saved.getPageCount() === 3 && dl.suggestedFilename() === '보고서A_1-2,4.pdf', `${dl.suggestedFilename()} · ${saved.getPageCount()}쪽`);

  await page.fill('#edit-range', '1-99');
  await page.click('#edit-save-range');
  const rangeToast = await page.locator('.toast.error .toast-title').first().textContent();
  check('잘못된 범위는 알림으로 안내', /99쪽은 없어요/.test(rangeToast), rangeToast);
  await page.fill('#edit-range', '');

  // 나눠 저장
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#edit-split')]);
  const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  check('나눠 저장(zip)', Object.keys(zip.files).length === 6, `${dl.suggestedFilename()} · 파일 ${Object.keys(zip.files).length}개`);

  // 홀수·짝수·역순 메뉴
  await page.click('#edit-more');
  const menuOpen = await visible(page, '#edit-menu');
  await page.click('#edit-odd');
  const oddCount = await page.textContent('#edit-count');
  const menuClosed = await page.$eval('#edit-menu', (e) => e.hidden);
  await page.click('#edit-more');
  await page.click('#edit-reverse');
  check('홀수·짝수·역순 메뉴 (저장 없이 선택만)', menuOpen && menuClosed && /3쪽 저장 예정/.test(oddCount), `메뉴 열림/닫힘 OK · ${oddCount}`);

  // 저장 막대가 마지막 줄을 가리지 않음 (맨 아래로 스크롤했을 때)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(200);
  const cover = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#edit-grid .page-card')];
    const last = cards[cards.length - 1].getBoundingClientRect();
    const bar = document.getElementById('edit-bar').getBoundingClientRect();
    return { lastBottom: Math.round(last.bottom), barTop: Math.round(bar.top) };
  });
  check('저장 막대가 마지막 줄을 가리지 않음', cover.lastBottom <= cover.barTop, `마지막 카드 아래 ${cover.lastBottom}px ≤ 막대 위 ${cover.barTop}px`);

  // 가짜 PDF
  await page.setInputFiles('#edit-input', [notPdf]);
  const badLoc = page.locator('.toast.error', { hasText: '가짜.pdf' });
  await badLoc.waitFor();
  const badToast = await badLoc.first().innerText();
  check('손상/가짜 PDF는 알림으로 안내', /PDF 파일이 아니에요/.test(badToast), badToast.replace(/\s+/g, ' ').trim());

  // 잠긴 PDF → 노란 안내줄
  await page.setInputFiles('#edit-input', [fileEnc]);
  const note = page.locator('#edit-locks .lock-note');
  await note.waitFor();
  const noteText = (await note.innerText()).replace(/\s+/g, ' ');
  const noteBg = await note.evaluate((e) => getComputedStyle(e).backgroundColor);
  await note.locator('button', { hasText: '비밀번호 넣기' }).click();
  await note.locator('input').fill('wrong');
  await note.locator('button', { hasText: '풀기' }).click();
  const noteMsg = await note.locator('.msg').textContent();
  await note.locator('input').fill('secret1');
  await note.locator('button', { hasText: '풀기' }).click();
  await until(page, () => !document.querySelector('#edit-locks .lock-note'));
  const cardsAfter = await page.$$eval('#edit-grid .page-card', (els) => els.length);
  check('잠긴 PDF: 노란 안내줄 → 비밀번호 → 합류', /잠겨 있어요/.test(noteText) && noteBg === 'rgb(255, 247, 224)' && /비밀번호가 맞지 않아요/.test(noteMsg) && cardsAfter === 9,
    `"${noteText.slice(0, 40)}…" / 틀림: "${noteMsg}" / 풀린 뒤 카드 ${cardsAfter}장`);

  // ── 4. 사진 → PDF ──
  await page.click('#tab-img2pdf');
  await page.click('#img-clear');
  await page.setInputFiles('#img-input', [png, png]);
  await until(page, () => document.querySelectorAll('#img-grid .img-card').length === 2);
  await radio(page, 'img-paper', 'a4l');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#img-save')]);
  saved = await PDFDocument.load(fs.readFileSync(await dl.path()));
  const sz = saved.getPage(0).getSize();
  check('사진 → PDF (A4 가로, 알약 선택)', saved.getPageCount() === 2 && Math.round(sz.width) === 842 && Math.round(sz.height) === 595,
    `${dl.suggestedFilename()} · ${saved.getPageCount()}쪽 · ${Math.round(sz.width)}×${Math.round(sz.height)}`);

  await page.click('#img-clear');
  await page.setInputFiles('#img-input', [phone]);
  await until(page, () => document.querySelectorAll('#img-grid .img-card').length === 1);
  await radio(page, 'img-paper', 'fit');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#img-save')]);
  saved = await PDFDocument.load(fs.readFileSync(await dl.path()));
  const dims = [];
  for (const [, obj] of saved.context.enumerateIndirectObjects()) {
    const dict = obj && obj.dict;
    if (dict && String(dict.get(PDFLib.PDFName.of('Subtype'))) === '/Image') {
      dims.push(`${dict.get(PDFLib.PDFName.of('Width'))}×${dict.get(PDFLib.PDFName.of('Height'))}`);
    }
  }
  const psz = saved.getPage(0).getSize();
  check('휴대폰 사진 EXIF 회전 반영', dims[0] === '100×200' && psz.height > psz.width,
    `200×100 + 방향값 6 → PDF 그림 ${dims.join(',')}`);

  // ── 5. PDF → 사진 ──
  await page.click('#tab-pdf2img');
  await page.setInputFiles('#p2i-input', [fileB]);
  await until(page, () => document.querySelectorAll('#p2i-grid .pick-card').length === 4);
  await page.locator('#p2i-grid .pick-card').nth(1).click();
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#p2i-save')]);
  const zip2 = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  const names = Object.keys(zip2.files);
  check('PDF → 사진 (3쪽 선택 → zip)', names.length === 3 && names.every((n) => n.endsWith('.png')), `${dl.suggestedFilename()} · ${names.join(', ')}`);

  // ── 6. 암호 ──
  await page.click('#tab-lock');
  const lockCols = await page.evaluate(() => [...document.querySelectorAll('.lock-card')].map((c) => Math.round(c.getBoundingClientRect().left)));
  await page.setInputFiles('#unlock-input', [fileEnc]);
  await page.fill('#unlock-pw', 'SECRET1');
  await page.click('#unlock-save');
  const unlockErr = await page.textContent('#unlock-error');
  check('암호: 좌우 두 카드 · 틀린 비밀번호 문장 안내', lockCols.length === 2 && lockCols[1] > lockCols[0] + 200 && unlockErr === '비밀번호가 맞지 않아요. 대소문자와 한/영 상태를 확인해 주세요.', unlockErr);
  await page.fill('#unlock-pw', 'secret1');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#unlock-save')]);
  saved = await PDFDocument.load(fs.readFileSync(await dl.path()));
  check('암호 풀어서 저장', saved.getPageCount() === 2 && !saved.isEncrypted, `${dl.suggestedFilename()} · 비밀번호 없이 열림`);

  await page.setInputFiles('#lock-input', [fileA]);
  await page.fill('#lock-pw', 'open-pw');
  await page.fill('#lock-owner', 'owner-pw');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#lock-save')]);
  const lockedBytes = fs.readFileSync(await dl.path());
  let noPw = null;
  try { await PDFDocument.load(lockedBytes); } catch (e) { noPw = e.message; }
  const reopened = await PDFDocument.load(lockedBytes, { password: 'open-pw' });
  check('암호 걸어서 저장 (AES-256)', noPw && /encrypted/.test(noPw) && reopened.getPageCount() === 3 && /\/AESV3/.test(lockedBytes.toString('latin1')),
    `${dl.suggestedFilename()} · 암호 없이 못 엶, 열기 암호로 3쪽`);

  await page.click('#unlock-send');
  await until(page, () => !document.getElementById('panel-edit').hidden);
  const cardsSent = await page.$$eval('#edit-grid .page-card', (els) => els.length);
  check('풀고 편집으로 보내기', cardsSent === 11, `편집 카드 ${cardsSent}장`);

  // ── 7. 쪽번호 ──
  await page.click('#tab-number');
  await page.setInputFiles('#num-input', [fileB]);
  await page.waitForSelector('#num-mark:not([hidden])');
  await radio(page, 'num-fmt', 'total');
  await page.waitForTimeout(200);
  const markText = await page.textContent('#num-mark');
  const markBox = await page.locator('#num-mark').boundingBox();
  const canBox = await page.locator('#num-canvas').boundingBox();
  const inside = markBox.x > canBox.x && markBox.x + markBox.width < canBox.x + canBox.width && markBox.y > canBox.y + canBox.height * 0.85;
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#num-save')]);
  saved = await PDFDocument.load(fs.readFileSync(await dl.path()));
  check('쪽번호 미리보기 · 저장', markText === '1 / 4' && inside && saved.getPageCount() === 4,
    `미리보기 "${markText}" (쪽 아래쪽 안), ${dl.suggestedFilename()} ${saved.getPageCount()}쪽`);

  // 도구를 옮겨도 상태 유지
  await page.click('#tab-edit');
  await page.click('#tab-number');
  const kept = await page.evaluate(() => ({
    edit: document.querySelectorAll('#edit-grid .page-card').length,
    num: !document.getElementById('num-layout').hidden,
  }));
  check('도구를 옮겨 다녀도 상태 유지', kept.edit === 11 && kept.num, `편집 카드 ${kept.edit}장, 쪽번호 미리보기 유지`);

  // ── 8. 로고 → 초기화 + 처음 화면 ──
  await page.click('#logo');
  const resetState = await page.evaluate(() => ({
    home: !document.getElementById('view-home').hidden,
    cards: document.querySelectorAll('#edit-grid .page-card').length,
    chips: document.querySelectorAll('#edit-chips .chip').length,
    imgs: document.querySelectorAll('#img-grid .img-card').length,
    num: document.getElementById('num-layout').hidden,
    path: location.pathname,
  }));
  check('로고 → 새로고침 없이 초기화하고 처음 화면', resetState.home && resetState.cards === 0 && resetState.chips === 0 && resetState.imgs === 0 && resetState.num,
    JSON.stringify(resetState));
  check('전체 흐름 동안 콘솔 에러 0개', errors.length === 0, errors.length ? errors.join(' | ').slice(0, 300) : '0개');
  await ctx.close();

  // ── 9. 400px 휴대폰 (다크 모드) ──
  const mctx = await browser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true, colorScheme: 'dark', deviceScaleFactor: 2 });
  const m = await mctx.newPage();
  const merr = [];
  watch(m, merr);
  await m.goto(BASE, { waitUntil: 'networkidle' });
  const mh = await m.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    title: document.getElementById('home-title').getBoundingClientRect().width,
    cols: new Set([...document.querySelectorAll('.tool-card')].map((c) => Math.round(c.getBoundingClientRect().left))).size,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  check('400px 처음 화면: 가로 스크롤 없음, 카드 1칸', mh.sw <= 400 && mh.title > 0 && mh.cols === 1, `scrollWidth ${mh.sw}, 카드 열 ${mh.cols}개`);
  await m.setInputFiles('#home-input', [fileA, fileB]);
  await until(m, () => document.querySelectorAll('#edit-grid .page-card canvas').length >= 4, undefined, { timeout: 15000 });
  const sw = {};
  for (const t of tools) {
    await m.click(`#tab-${t}`);
    sw[t] = await m.evaluate(() => document.documentElement.scrollWidth);
  }
  await m.click('#tab-edit');
  const side = await m.evaluate(() => {
    const s = document.querySelector('.sidebar');
    return { h: Math.round(s.getBoundingClientRect().height), desc: getComputedStyle(document.querySelector('.tab-desc')).display, safe: getComputedStyle(document.querySelector('.side-safe')).display };
  });
  await m.locator('#edit-grid .page-card').nth(0).tap();
  await m.waitForTimeout(400);
  const toolsOpacity = await m.locator('#edit-grid .page-card').nth(0).locator('.card-tools').evaluate((e) => getComputedStyle(e).opacity);
  check('400px 작업 화면: 가로 스크롤 없음, 위쪽 도구 줄', Object.values(sw).every((v) => v <= 400) && side.h < 80 && side.desc === 'none' && side.safe === 'none',
    `scrollWidth ${Object.entries(sw).map(([k, v]) => `${k}:${v}`).join(' ')}, 도구 줄 높이 ${side.h}px`);
  check('다크 모드 · 카드 탭하면 버튼 표시', mh.bg === 'rgb(15, 19, 32)' && Number(toolsOpacity) > 0.9, `배경 ${mh.bg}, 버튼 불투명도 ${toolsOpacity}`);
  check('휴대폰 화면 콘솔 에러 0개', merr.length === 0, merr.length ? merr.join(' | ').slice(0, 200) : '0개');
  await mctx.close();

  // ── 10. 스크린샷 ──
  if (SCREENS) {
    const out = path.join(root, 'docs', 'screens');
    fs.mkdirSync(out, { recursive: true });
    const sA = await writePdf('회의자료.pdf', await samplePdf(4, 'Meeting'));
    const sB = await writePdf('부록.pdf', await samplePdf(3, 'Appendix'));

    const d = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'light', deviceScaleFactor: 1 });
    const p = await d.newPage();
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(out, 'home.png') });
    await p.setInputFiles('#home-input', [sA, sB]);
    await until(p, () => document.querySelectorAll('#edit-grid .page-card canvas').length === 7, undefined, { timeout: 15000 });
    const c = p.locator('#edit-grid .page-card').nth(2);
    await c.hover();
    await c.locator('.card-tools [data-act="del"]').click();
    await p.locator('#edit-grid .page-card').nth(4).hover();
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(out, 'edit-with-files.png') });
    await d.close();

    const mo = await browser.newContext({ viewport: { width: 400, height: 860 }, colorScheme: 'light', deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const mp = await mo.newPage();
    await mp.goto(BASE, { waitUntil: 'networkidle' });
    await mp.evaluate(() => document.fonts.ready);
    await mp.screenshot({ path: path.join(out, 'mobile-home.png') });
    await mo.close();
    console.log(`스크린샷: ${out}`);
  }
} catch (e) {
  check('실행 중 예외', false, String((e && e.stack) || e).slice(0, 400));
} finally {
  await browser.close();
  server.kill();
}

const wide = (s) => [...s].reduce((n, ch) => n + (/[ᄀ-ᇿ㄰-㆏가-힣]/.test(ch) ? 2 : 1), 0);
const padR = (s, n) => s + ' '.repeat(Math.max(0, n - wide(s)));
const c1 = Math.max(...rows.map((r) => wide(r.name)));
console.log(`\n| ${padR('항목', c1)} | 결과 | 세부`);
console.log(`|${'-'.repeat(c1 + 2)}|------|${'-'.repeat(40)}`);
for (const r of rows) console.log(`| ${padR(r.name, c1)} | ${r.ok ? '통과' : '실패'} | ${r.detail}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length}개 중 ${rows.length - failed}개 통과${failed ? `, ${failed}개 실패` : ''}`);
process.exit(failed ? 1 : 0);
