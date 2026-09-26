// 헤드리스 브라우저 점검 (playwright가 있을 때만).
// 실행: node test/ui-check.mjs            점검만
//       node test/ui-check.mjs --screens  점검 + docs/screens/ 에 스크린샷 5장 저장
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
const { photoJpeg } = await import('./node-codec.mjs');
const uiMeasures = [];

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
  check('처음 화면: 도구 카드 6개가 보임', home.cards.length === 6 && home.cards.every((c) => c.w > 100 && c.h > 100 && c.bottom <= home.vh),
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
  const tools = ['edit', 'img2pdf', 'pdf2img', 'decorate', 'compress', 'security'];
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
  check('사이드바 도구 6개 · 화살표 키 이동', tabRects.length === 6 && tabRects.every(Boolean) && kb.sel === 'pdf2img' && kb.focus === 'tab-pdf2img',
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

  // 나눠 저장 (패널 → 1쪽씩 → zip)
  await page.click('#edit-split');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#split-save')]);
  await page.click('#split-close');
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
  check('PDF → 사진 (3쪽 선택 → zip, 이름_p1.png)', names.length === 3 && names.join(',') === '자료B_p1.png,자료B_p3.png,자료B_p4.png', `${dl.suggestedFilename()} · ${names.join(', ')}`);

  // ── 6. 암호 ──
  await page.click('#tab-security');
  const lockCols = await page.evaluate(() => [...document.querySelectorAll('.two-col .lock-card')].map((c) => Math.round(c.getBoundingClientRect().left)));
  await page.setInputFiles('#unlock-input', [fileEnc]);
  await page.fill('#unlock-pw', 'SECRET1');
  await page.click('#unlock-save');
  await until(page, () => !document.getElementById('unlock-error').hidden);
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

  // ── 7. 꾸미기(쪽번호) ──
  await page.click('#tab-decorate');
  await page.setInputFiles('#decor-input', [fileB]);
  await page.waitForSelector('#decor-preview .pv-num');
  await page.click('#decor-options .acc[data-item="number"] label:has(> input[value="total"])');
  await page.waitForTimeout(200);
  const markText = await page.textContent('#decor-preview .pv-num');
  const markBox = await page.locator('#decor-preview .pv-num').boundingBox();
  const canBox = await page.locator('#decor-preview .pv-canvas').boundingBox();
  const inside = markBox.x > canBox.x && markBox.x + markBox.width < canBox.x + canBox.width && markBox.y > canBox.y + canBox.height * 0.85;
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#decor-save')]);
  saved = await PDFDocument.load(fs.readFileSync(await dl.path()));
  check('꾸미기: 쪽번호 미리보기 · 저장', markText === '1 / 4' && inside && saved.getPageCount() === 4 && dl.suggestedFilename() === '자료B_꾸미기.pdf',
    `미리보기 "${markText}" (쪽 아래쪽 안), ${dl.suggestedFilename()} ${saved.getPageCount()}쪽`);

  // 도구를 옮겨도 상태 유지
  await page.click('#tab-edit');
  await page.click('#tab-decorate');
  const kept = await page.evaluate(() => ({
    edit: document.querySelectorAll('#edit-grid .page-card').length,
    num: !document.getElementById('decor-layout').hidden,
  }));
  check('도구를 옮겨 다녀도 상태 유지', kept.edit === 11 && kept.num, `편집 카드 ${kept.edit}장, 꾸미기 미리보기 유지`);

  // ── 8. 로고 → 초기화 + 처음 화면 ──
  await page.click('#logo');
  const resetState = await page.evaluate(() => ({
    home: !document.getElementById('view-home').hidden,
    cards: document.querySelectorAll('#edit-grid .page-card').length,
    chips: document.querySelectorAll('#edit-chips .chip').length,
    imgs: document.querySelectorAll('#img-grid .img-card').length,
    num: document.getElementById('decor-layout').hidden,
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
    desc: getComputedStyle(document.querySelector('.tool-desc')).display,
    n: document.querySelectorAll('.tool-card').length,
  }));
  check('400px 처음 화면: 가로 스크롤 없음, 작은 카드 2칸 × 3줄(설명 숨김)', mh.sw <= 400 && mh.title > 0 && mh.cols === 2 && mh.n === 6 && mh.desc === 'none', `scrollWidth ${mh.sw}, 카드 ${mh.n}개 · 열 ${mh.cols}개, 설명 ${mh.desc}`);
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

  // ── 10. 여러 쪽 선택 · 선택 막대 · 되돌리기 · 사용법 패널 (1440px) ──
  {
    const fileMany = await writePdf('수업자료.pdf', await samplePdf(30, 'P'));
    const wctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, colorScheme: 'light' });
    const w = await wctx.newPage();
    const werr = [];
    watch(w, werr);
    await w.goto(BASE, { waitUntil: 'networkidle' });
    await w.setInputFiles('#home-input', [fileMany]);
    await until(w, () => document.querySelectorAll('#edit-grid .page-card').length === 30);
    const cardsW = w.locator('#edit-grid .page-card');
    const srcLabels = () => w.$$eval('#edit-grid .page-src', (els) => els.map((e) => e.textContent));
    const selected = () => w.$$eval('#edit-grid .page-card', (els) => els.map((e, i) => (e.classList.contains('selected') ? i : -1)).filter((i) => i >= 0));
    const lastToast = () => w.locator('.toast .toast-title').first().textContent();
    // 좁으면 덜 쓰는 버튼이 "더보기" 안에 있다.
    const selAct = async (act) => {
      const direct = w.locator(`#edit-selbar .sel-extra[data-sel="${act}"]`);
      if (await direct.isVisible()) return direct.click();
      await w.click('#sel-more');
      return w.click(`#sel-menu [data-sel="${act}"]`);
    };

    const cap = await srcLabels();
    check('파일 1개일 때 캡션은 "N쪽"', cap[0] === '1쪽' && cap[29] === '30쪽', `"${cap[0]}", "${cap[29]}"`);

    const guideW = await w.evaluate(() => {
      const g = document.getElementById('edit-guide').getBoundingClientRect();
      const grid = document.getElementById('edit-grid').getBoundingClientRect();
      return { gw: Math.round(g.width), gh: Math.round(g.height), open: getComputedStyle(document.getElementById('guide-open')).display, gridRight: Math.round(grid.right), gLeft: Math.round(g.left), st: window.__pdfWorkshop.guide() };
    });
    check('1440px: 오른쪽 사용법 패널 보임(움직임 재생)', guideW.gw === 320 && guideW.gh > 300 && guideW.open === 'none' && guideW.gridRight <= guideW.gLeft && guideW.st.playing.every(Boolean),
      `패널 ${guideW.gw}×${guideW.gh}, 그리드 오른쪽 ${guideW.gridRight} ≤ 패널 왼쪽 ${guideW.gLeft}, 예시 재생 ${guideW.st.playing.join('/')}`);

    // Ctrl+클릭 2개
    await cardsW.nth(1).click();
    await cardsW.nth(3).click({ modifiers: ['Control'] });
    const s1 = await selected();
    const barText = await w.textContent('#sel-count');
    check('Ctrl+클릭으로 2쪽 선택 + 선택 막대', s1.join(',') === '1,3' && barText === '2쪽 선택됨' && await visible(w, '#edit-selbar'),
      `선택 ${s1.map((i) => i + 1).join(',')}쪽, "${barText}"`);

    // Shift 범위
    await cardsW.nth(2).click();
    await cardsW.nth(5).click({ modifiers: ['Shift'] });
    const s2 = await selected();
    await cardsW.nth(8).click({ modifiers: ['Control', 'Shift'] });
    const s3 = await selected();
    check('Shift+클릭 범위 (+Ctrl+Shift로 더하기)', s2.join(',') === '2,3,4,5' && s3.join(',') === '2,3,4,5,6,7,8',
      `3쪽→Shift 6쪽: ${s2.map((i) => i + 1).join(',')} / 이어서 Ctrl+Shift 9쪽: ${s3.map((i) => i + 1).join(',')}`);

    // 네모 선택: 1·2번 카드 사이 틈에서 시작해 둘째 줄 2번째 카드 가운데까지
    const cols = await w.evaluate(() => getComputedStyle(document.getElementById('edit-grid')).gridTemplateColumns.split(' ').length);
    const b0 = await cardsW.nth(0).boundingBox();
    const b1 = await cardsW.nth(1).boundingBox();
    const bT = await cardsW.nth(cols + 1).boundingBox();
    await w.mouse.move((b0.x + b0.width + b1.x) / 2, b0.y + 30);
    await w.mouse.down();
    await w.mouse.move(bT.x + bT.width / 2, bT.y + bT.height / 2, { steps: 8 });
    const boxShown = await w.$('.select-box') !== null;
    await w.mouse.up();
    const s4 = await selected();
    check('네모 선택 (빈 곳에서 끌기)', boxShown && s4.join(',') === `1,${cols + 1}`, `네모 ${boxShown ? '보임' : '없음'}, 한 줄 ${cols}칸, 선택 ${s4.map((i) => i + 1).join(',')}쪽`);

    // 떨어진 2쪽·4쪽을 골라 4쪽을 끌어 맨 앞(1쪽 왼쪽)에 놓기
    await cardsW.nth(1).click();
    await cardsW.nth(3).click({ modifiers: ['Control'] });
    const d3 = await cardsW.nth(3).boundingBox();
    const d0 = await cardsW.nth(0).boundingBox();
    await w.mouse.move(d3.x + d3.width / 2, d3.y + d3.height / 2);
    await w.mouse.down();
    await w.mouse.move(d3.x + d3.width / 2 - 30, d3.y + d3.height / 2, { steps: 4 });
    const stack = await w.evaluate(() => {
      const s = document.querySelector('.drag-stack');
      return s ? { badge: s.querySelector('.stack-badge').textContent, backs: s.querySelectorAll('.stack-back').length } : null;
    });
    await w.mouse.move(d0.x + d0.width * 0.2, d0.y + d0.height / 2, { steps: 10 });
    await w.mouse.up();
    const moved = await srcLabels();
    check('선택한 2쪽을 끌어 맨 앞으로 (상대 순서 유지)', stack && stack.badge === '2쪽' && stack.backs === 1 && moved.slice(0, 5).join(',') === '2쪽,4쪽,1쪽,3쪽,5쪽',
      `끄는 모양 ${stack ? `"${stack.badge}" 배지 + 겹친 카드` : '없음'} → ${moved.slice(0, 5).join(', ')}`);

    // Delete → 삭제 예정, Ctrl+Z → 복구, 한 번 더 → 순서 복구
    await w.keyboard.press('Delete');
    const delState = await w.evaluate(() => ({
      del: [...document.querySelectorAll('#edit-grid .page-card')].map((e, i) => (e.classList.contains('deleted') ? i : -1)).filter((i) => i >= 0),
      count: document.getElementById('edit-count').textContent,
      btn: document.getElementById('sel-del').textContent,
    }));
    check('Delete 키로 선택한 쪽 삭제 예정 (+버튼이 "복구"로)', delState.del.join(',') === '0,1' && /28쪽 저장 예정/.test(delState.count) && delState.btn === '복구',
      `삭제 예정 ${delState.del.map((i) => i + 1).join(',')}번 카드, ${delState.count}, 버튼 "${delState.btn}"`);
    await w.keyboard.press('Control+z');
    const undo1 = await w.evaluate(() => document.querySelectorAll('#edit-grid .page-card.deleted').length);
    const t1 = await lastToast();
    await w.keyboard.press('Control+z');
    const t2 = await lastToast();
    const back = await srcLabels();
    await w.keyboard.press('Control+Shift+z');
    const redo = await srcLabels();
    check('Ctrl+Z 되돌리기 · Ctrl+Shift+Z 다시 하기', undo1 === 0 && t1 === '되돌렸어요: 2쪽 삭제' && t2 === '되돌렸어요: 2쪽 옮기기' && back.slice(0, 4).join(',') === '1쪽,2쪽,3쪽,4쪽' && redo.slice(0, 2).join(',') === '2쪽,4쪽',
      `"${t1}" → "${t2}" → ${back.slice(0, 4).join(',')} → 다시 하기 ${redo.slice(0, 2).join(',')}`);

    // 선택 막대: 몇 쪽 뒤로…, 범위 오류, 회전, 선택한 쪽만 저장
    await w.keyboard.press('Escape');
    const cleared = await w.$eval('#edit-selbar', (e) => e.hidden);
    await cardsW.nth(0).click(); // 지금 순서: 2,4,1,3,5,…
    await cardsW.nth(1).click({ modifiers: ['Control'] });
    await selAct('after');
    await w.fill('#sel-after-n', '99');
    await w.click('#sel-after button[type="submit"]');
    const rangeErr = await lastToast();
    await w.fill('#sel-after-n', '3');
    await w.click('#sel-after button[type="submit"]');
    const after = await srcLabels();
    check('Esc 해제 · "몇 쪽 뒤로…" (범위 오류 안내)', cleared && rangeErr === '1~30 사이 숫자를 넣어 주세요.' && after.slice(0, 5).join(',') === '1쪽,2쪽,4쪽,3쪽,5쪽',
      `"${rangeErr}" / 3쪽 다음으로 → ${after.slice(0, 5).join(',')}`);
    await w.click('#edit-selbar [data-sel="rotl"]');
    const rotLabel = await cardsW.nth(1).getAttribute('aria-label');
    const [dlSel] = await Promise.all([w.waitForEvent('download'), selAct('save')]);
    const selDoc = await PDFDocument.load(fs.readFileSync(await dlSel.path()));
    const selRot = selDoc.getPages().map((p) => p.getRotation().angle);
    check('왼쪽 90° · 선택한 쪽만 저장', /270도 회전/.test(rotLabel) && dlSel.suggestedFilename() === '수업자료_선택2쪽.pdf' && selDoc.getPageCount() === 2 && selRot.join(',') === '270,270' &&
      Math.round(selDoc.getPage(0).getWidth()) === 596 && Math.round(selDoc.getPage(1).getWidth()) === 598,
    `${dlSel.suggestedFilename()} · ${selDoc.getPageCount()}쪽(2쪽, 4쪽 순서) · 회전 ${selRot.join(',')}`);

    // 스크롤해도 선택 막대가 보임
    await w.evaluate(() => window.scrollTo(0, 1600));
    await w.waitForTimeout(150);
    const sticky = await w.evaluate(() => {
      const r = document.getElementById('edit-selbar').getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), sy: Math.round(scrollY) };
    });
    check('스크롤 후에도 선택 막대가 위에 보임', sticky.sy > 500 && sticky.top >= 0 && sticky.top <= 16 && sticky.bottom < 900,
      `scrollY ${sticky.sy}, 막대 top ${sticky.top}px`);

    // 끄는 중 아래 가장자리 → 자동 스크롤
    await w.evaluate(() => window.scrollTo(0, 0));
    const a0 = await cardsW.nth(0).boundingBox();
    await w.mouse.move(a0.x + a0.width / 2, a0.y + a0.height / 2);
    await w.mouse.down();
    await w.mouse.move(a0.x + a0.width / 2, 700, { steps: 5 });
    const barTop = await w.evaluate(() => document.getElementById('edit-bar').getBoundingClientRect().top);
    await w.mouse.move(a0.x + a0.width / 2, barTop - 5, { steps: 3 });
    await w.waitForTimeout(600);
    const scrolled = await w.evaluate(() => Math.round(scrollY));
    await w.mouse.move(a0.x + a0.width / 2, a0.y + a0.height / 2, { steps: 2 });
    await w.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
    await w.mouse.up();
    check('끄는 중 화면 아래 가장자리에서 자동 스크롤', scrolled > 50, `0.6초 동안 ${scrolled}px 내려감`);

    // Ctrl+A
    await w.evaluate(() => window.scrollTo(0, 0));
    await w.keyboard.press('Control+a');
    const all = (await selected()).length;
    await w.keyboard.press('Escape');
    check('Ctrl+A 전체 선택', all === 30, `${all}쪽 선택`);

    // 접기 → 새로고침해도 접힘 유지
    await w.click('#guide-fold');
    const folded = await w.evaluate(() => ({ st: window.__pdfWorkshop.guide(), rail: document.getElementById('guide-rail').getBoundingClientRect().width }));
    await w.reload({ waitUntil: 'networkidle' });
    // 주소가 #edit 이므로 새로고침하면 편집 도구가 바로 열린다.
    await until(w, () => !document.getElementById('view-work').hidden && !document.getElementById('panel-edit').hidden);
    const afterReload = await w.evaluate(() => ({ st: window.__pdfWorkshop.guide(), rail: document.getElementById('guide-rail').getBoundingClientRect().width, body: document.querySelector('#edit-guide .guide-body').getBoundingClientRect().width }));
    await w.click('#guide-rail');
    const unfolded = await w.evaluate(() => window.__pdfWorkshop.guide());
    check('접기 → 새로고침해도 접힘 유지 (접히면 움직임 멈춤)', folded.st.collapsed && folded.rail > 30 && folded.st.playing.every((p) => !p) &&
      afterReload.st.collapsed && afterReload.rail > 30 && afterReload.body === 0 && !unfolded.collapsed && unfolded.playing.every(Boolean),
    `접힘 막대 ${Math.round(afterReload.rail)}px, 새로고침 후 collapsed=${afterReload.st.collapsed}, 펼치면 재생 ${unfolded.playing.every(Boolean)}`);
    check('1440px 흐름 콘솔 에러 0개', werr.length === 0, werr.length ? werr.join(' | ').slice(0, 300) : '0개');
    await wctx.close();

    // 1000px: 패널 숨김 + "사용법" 버튼으로 서랍
    const nctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, colorScheme: 'light' });
    const n = await nctx.newPage();
    const nerr = [];
    watch(n, nerr);
    await n.goto(BASE, { waitUntil: 'networkidle' });
    await n.click('.tool-card[data-open="edit"]');
    const hiddenState = await n.evaluate(() => ({
      w: document.getElementById('edit-guide').getBoundingClientRect().width,
      btn: document.getElementById('guide-open').getBoundingClientRect().width,
      st: window.__pdfWorkshop.guide(),
    }));
    await n.click('#guide-open');
    await n.waitForTimeout(300);
    const drawer = await n.evaluate(() => {
      const r = document.getElementById('edit-guide').getBoundingClientRect();
      return { w: Math.round(r.width), right: Math.round(r.right), st: window.__pdfWorkshop.guide(), backdrop: !document.getElementById('guide-backdrop').hidden };
    });
    await n.keyboard.press('Escape');
    const closed = await n.evaluate(() => document.getElementById('edit-guide').getBoundingClientRect().width);
    check('1000px: 패널 숨김 → "사용법" 버튼으로 서랍 열기 · Esc로 닫기',
      hiddenState.w === 0 && hiddenState.btn > 0 && hiddenState.st.playing.every((p) => !p) && drawer.w >= 300 && drawer.right === 1000 && drawer.backdrop && drawer.st.playing.every(Boolean) && closed === 0,
      `숨김(폭 ${hiddenState.w}) → 서랍 ${drawer.w}px, 재생 ${drawer.st.playing.every(Boolean)} → Esc 닫힘`);
    check('1000px 콘솔 에러 0개', nerr.length === 0, nerr.length ? nerr.join(' | ').slice(0, 200) : '0개');
    await nctx.close();

    // 400px 터치: 길게 누르기 → 선택 모드, 탭으로 더하기, 가로 스크롤 없음
    const tctx = await browser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true, colorScheme: 'light', deviceScaleFactor: 2 });
    const t = await tctx.newPage();
    const terr = [];
    watch(t, terr);
    await t.goto(BASE, { waitUntil: 'networkidle' });
    await t.setInputFiles('#home-input', [fileMany]);
    await until(t, () => document.querySelectorAll('#edit-grid .page-card').length === 30);
    const tb = await t.locator('#edit-grid .page-card').nth(1).boundingBox();
    const cdp = await tctx.newCDPSession(t);
    const pt = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await t.waitForTimeout(650);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const lp = await t.evaluate(() => ({ mode: document.getElementById('edit-grid').classList.contains('select-mode'), n: document.querySelectorAll('#edit-grid .page-card.selected').length }));
    await t.locator('#edit-grid .page-card').nth(2).tap(); // 첫 줄(아래쪽 카드는 저장 막대에 가려짐)
    await t.waitForTimeout(100);
    const lp2 = await t.evaluate(() => ({ n: document.querySelectorAll('#edit-grid .page-card.selected').length, sw: document.documentElement.scrollWidth, bar: !document.getElementById('edit-selbar').hidden }));
    await t.click('#edit-selbar [data-sel="clear"]');
    const lp3 = await t.evaluate(() => document.getElementById('edit-grid').classList.contains('select-mode'));
    check('400px 터치: 길게 누르면 선택 모드 → 탭으로 추가 · 가로 스크롤 없음', lp.mode && lp.n === 1 && lp2.n === 2 && lp2.bar && lp2.sw <= 400 && !lp3 && terr.length === 0,
      `길게 누름 → 선택 ${lp.n}쪽, 탭 → ${lp2.n}쪽, ✕ → 선택 모드 꺼짐, scrollWidth ${lp2.sw}${terr.length ? `, 에러 ${terr.join(' | ').slice(0, 120)}` : ''}`);
    await tctx.close();
  }

  // ── 11. 저장 두 가지 · 설정하고 저장 · 나눠 저장 · PDF → 사진 막대 · 용량 줄이기 ──
  {
    const fileMany = await writePdf('수업자료.pdf', await samplePdf(30, 'P'));
    const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, colorScheme: 'light' });
    const s = await sctx.newPage();
    const serr = [];
    watch(s, serr);
    await s.goto(BASE, { waitUntil: 'networkidle' });
    await s.setInputFiles('#home-input', [fileMany]);
    await until(s, () => document.querySelectorAll('#edit-grid .page-card').length === 30);

    // 바로 저장 · 설정하고 저장 버튼, Ctrl+S
    const btns = await s.evaluate(() => {
      const bar = [...document.querySelectorAll('#edit-bar > *')].map((e) => e.id || e.className);
      return { bar, quick: document.getElementById('edit-save').textContent.trim(), opts: document.getElementById('edit-save-opts').textContent.trim() };
    });
    const saveEvt = s.evaluate(() => new Promise((r) => document.addEventListener('keydown', function f(e) { if (e.key.toLowerCase() === 's') { document.removeEventListener('keydown', f); r(e.defaultPrevented); } })));
    let [dlS] = await Promise.all([s.waitForEvent('download'), s.keyboard.press('Control+s')]);
    const prevented = await saveEvt;
    const quickDoc = await PDFDocument.load(fs.readFileSync(await dlS.path()));
    const order = btns.bar.join(' ');
    check('저장 막대: [설정하고 저장…][바로 저장] · Ctrl+S = 바로 저장', btns.quick === '바로 저장' && btns.opts === '설정하고 저장…' &&
      order.indexOf('edit-save-opts') < order.indexOf('edit-save ') + 999 && order.indexOf('edit-save-opts') > order.indexOf('edit-split') && prevented &&
      /^합본_\d{8}\.pdf$/.test(dlS.suggestedFilename()) && quickDoc.getPageCount() === 30,
    `Ctrl+S → ${dlS.suggestedFilename()} ${quickDoc.getPageCount()}쪽 (브라우저 저장창 막음: ${prevented})`);

    // 설정하고 저장 창 (Ctrl+Shift+S)
    await s.locator('#edit-grid .page-card').nth(4).click();
    await s.keyboard.press('Control+Shift+s');
    await s.waitForSelector('#save-dialog[open]');
    await until(s, () => document.querySelector('#sd-preview .pv-canvas').width > 10);
    const acc = (k) => `#sd-items .acc[data-item="${k}"] .acc-head`;
    for (const k of ['number', 'watermark', 'stamp', 'lock', 'size']) await s.click(acc(k));
    const opened = await s.$$eval('#sd-items .acc', (els) => els.map((e) => !e.querySelector('.acc-body').hidden));
    await s.click(acc('size')); // 다시 끄기
    const sizeClosed = await s.$eval('#sd-items .acc[data-item="size"] .acc-body', (e) => e.hidden);
    // 서명 그리기
    await s.click('#sd-items [data-act="draw"]');
    await s.waitForSelector('#sign-dialog[open]');
    const pad = await s.locator('#sign-canvas').boundingBox();
    await s.mouse.move(pad.x + 40, pad.y + 110);
    await s.mouse.down();
    for (let i = 1; i <= 16; i++) await s.mouse.move(pad.x + 40 + i * 18, pad.y + 110 + Math.sin(i / 2) * 30);
    await s.mouse.up();
    await s.click('#sign-ok');
    await s.waitForSelector('#sd-preview .pv-stamp');
    // 암호가 다르면 저장 버튼이 꺼진다
    await s.fill('#sd-items input[data-f="pw"]', 'pw-1234');
    await s.fill('#sd-items input[data-f="pw2"]', 'pw-9999');
    const mismatch = await s.evaluate(() => ({ disabled: document.getElementById('sd-save').disabled, msg: document.querySelector('#sd-items .acc[data-item="lock"] .form-error').textContent }));
    await s.fill('#sd-items input[data-f="pw2"]', 'pw-1234');
    const matched = await s.$eval('#sd-save', (e) => !e.disabled);
    // 도장을 끌어서 옮기기
    const st = s.locator('#sd-preview .pv-stamp').first();
    const b0 = await st.boundingBox();
    await s.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
    await s.mouse.down();
    await s.mouse.move(b0.x + b0.width / 2 - 120, b0.y + b0.height / 2 - 150, { steps: 6 });
    await s.mouse.up();
    const b1 = await st.boundingBox();
    const moved = b1.x < b0.x - 100 && b1.y < b0.y - 120;
    check('설정하고 저장 창: 항목 토글 · 암호 불일치면 저장 꺼짐 · 도장 끌기', opened.every(Boolean) && sizeClosed && mismatch.disabled && /두 암호가 달라요/.test(mismatch.msg) && matched && moved,
      `5개 항목 펼침/접힘 OK · 불일치 "${mismatch.msg}" · 도장 (${Math.round(b0.x)},${Math.round(b0.y)})→(${Math.round(b1.x)},${Math.round(b1.y)})`);

    // Esc로 닫힘
    await s.keyboard.press('Escape');
    const closedByEsc = await s.$eval('#save-dialog', (d) => !d.open);
    // 다시 열어 "이 설정 기억하기" 켜고 저장 → 비밀번호는 저장 안 됨
    await s.click('#edit-save-opts');
    await s.waitForSelector('#save-dialog[open]');
    for (const k of ['number', 'watermark', 'lock']) await s.click(acc(k));
    await s.fill('#sd-items input[data-f="pw"]', 'secret-77');
    await s.fill('#sd-items input[data-f="pw2"]', 'secret-77');
    await s.fill('#sd-name', '결과:최종?');
    const cleaned = await s.$eval('#sd-name', (e) => e.value);
    await s.check('#sd-remember');
    [dlS] = await Promise.all([s.waitForEvent('download', { timeout: 60000 }), s.click('#sd-save')]);
    const outBytes = fs.readFileSync(await dlS.path());
    let noPwErr = null;
    try { await PDFDocument.load(outBytes); } catch (e) { noPwErr = e.message; }
    const outDoc = await PDFDocument.load(outBytes, { password: 'secret-77' });
    const stored = await s.evaluate(() => localStorage.getItem('pdfws.saveOpts'));
    await s.click('#edit-save-opts');
    await s.waitForSelector('#save-dialog[open]');
    const reopened = await s.evaluate(() => ({
      on: [...document.querySelectorAll('#sd-items .acc')].filter((a) => a.classList.contains('on')).map((a) => a.dataset.item),
      pw: document.querySelector('#sd-items input[data-f="pw"]').value,
      remember: document.getElementById('sd-remember').checked,
    }));
    await s.keyboard.press('Escape');
    check('설정 기억하기(비밀번호 제외) · 쓸 수 없는 글자는 _ · 저장 결과에 암호', closedByEsc && cleaned === '결과_최종_' && dlS.suggestedFilename() === '결과_최종_.pdf' &&
      /encrypted/i.test(noPwErr || '') && outDoc.getPageCount() === 30 && stored && !stored.includes('secret-77') &&
      reopened.on.join(',') === 'number,watermark,lock' && reopened.pw === '' && reopened.remember,
    `Esc 닫힘 · "${cleaned}" → ${dlS.suggestedFilename()} · 다시 열면 ${reopened.on.join('+')} 켜짐, 비밀번호 칸 "${reopened.pw}"`);

    // 바로 저장은 기억한 설정을 쓰지 않는다
    [dlS] = await Promise.all([s.waitForEvent('download'), s.click('#edit-save')]);
    const plain = await PDFDocument.load(fs.readFileSync(await dlS.path()));
    check('바로 저장은 기억한 설정과 상관없이 그대로', plain.getPageCount() === 30 && !plain.isEncrypted, `${dlS.suggestedFilename()} · 암호 없음`);

    // 나눠 저장 4가지
    await s.click('#edit-split');
    const planText = async () => s.evaluate(() => ({ btn: document.getElementById('split-save').textContent, files: document.querySelectorAll('#split-files li').length, more: document.getElementById('split-more').textContent, first: document.querySelector('#split-files li .f-name')?.textContent }));
    const eachP = await planText();
    await s.click('.mode-card:has(input[value="every"]) [data-every="10"]');
    const everyP = await planText();
    await s.click('.mode-card:has(input[value="parts"])');
    await s.fill('#split-parts', '4');
    const partsP = await planText();
    await s.click('.mode-card:has(input[value="cuts"])');
    const cutsVisible = await s.$eval('#edit-grid', (g) => g.classList.contains('cut-mode'));
    for (const i of [2, 9]) {
      const card = s.locator('#edit-grid .page-card').nth(i);
      await card.hover();
      await card.locator('.cut-slot').click({ force: true });
    }
    const cutsP = await planText();
    check('나눠 저장 4가지 방식 미리보기', eachP.btn === '30개 파일 저장' && everyP.btn === '3개 파일 저장' && everyP.first === '수업자료_01_1-10쪽.pdf' &&
      partsP.btn === '4개 파일 저장' && /마지막 파일은 7쪽/.test(partsP.more) && cutsVisible && cutsP.btn === '3개 파일 저장' && /마지막 파일은 20쪽|모두 3개/.test(cutsP.more),
    `1쪽씩 ${eachP.btn} / 10쪽씩 ${everyP.btn} (${everyP.first}) / 4개로 ${partsP.more} / 자르기 2곳 ${cutsP.btn}`);
    [dlS] = await Promise.all([s.waitForEvent('download'), s.click('#split-save')]);
    const zipCut = await JSZip.loadAsync(fs.readFileSync(await dlS.path()));
    const cutNames = Object.keys(zipCut.files).sort();
    check('자르기 위치대로 zip 저장', cutNames.join(',') === '수업자료_01_1-3쪽.pdf,수업자료_02_4-10쪽.pdf,수업자료_03_11-30쪽.pdf', `${dlS.suggestedFilename()}: ${cutNames.join(', ')}`);
    if (SCREENS) {
      await s.evaluate(() => window.scrollTo(0, 0));
      await s.mouse.move(700, 880);
      await s.waitForTimeout(300);
      await s.evaluate(() => document.getElementById('toasts').replaceChildren());
      await s.screenshot({ path: path.join(root, 'docs', 'screens', 'split-panel.png') });
    }
    await s.click('#split-close');

    // PDF → 사진 막대
    await s.click('#tab-pdf2img');
    await s.setInputFiles('#p2i-input', [fileB]);
    await until(s, () => document.querySelectorAll('#p2i-grid .pick-card').length === 4);
    const copyAll = await s.$eval('#p2i-copy', (e) => e.disabled);
    await s.click('#p2i-none');
    await s.locator('#p2i-grid .pick-card').nth(1).click();
    const copyOne = await s.$eval('#p2i-copy', (e) => !e.disabled);
    await s.click('#p2i-bar label:has(> input[value="webp"])');
    const webp = await s.evaluate(() => ({ warn: !document.getElementById('p2i-webp').hidden, q: !document.getElementById('p2i-q').disabled }));
    await until(s, () => /약 /.test(document.getElementById('p2i-est').textContent), undefined, { timeout: 15000 });
    const estText = await s.textContent('#p2i-est');
    [dlS] = await Promise.all([s.waitForEvent('download'), s.click('#p2i-save')]);
    const webpName = dlS.suggestedFilename();
    await s.click('#p2i-bar label:has(> input[value="png"])');
    const pngQ = await s.$eval('#p2i-q', (e) => e.disabled);
    check('PDF → 사진: 형식 전환 · WEBP 안내 · 예상 용량 · 복사는 한 쪽일 때만', copyAll && copyOne && webp.warn && webp.q && pngQ && /^약 /.test(estText) && webpName === '자료B_p2.webp',
      `4쪽 선택 복사 꺼짐 → 1쪽 켜짐 · WEBP 안내 ${webp.warn} · ${estText} · ${webpName}`);
    if (SCREENS) {
      await s.click('#p2i-bar label:has(> input[value="jpg"])');
      await s.click('#p2i-all');
      await until(s, () => /약 /.test(document.getElementById('p2i-est').textContent), undefined, { timeout: 15000 });
      await s.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await s.waitForTimeout(400);
      await s.evaluate(() => document.getElementById('toasts').replaceChildren());
      await s.screenshot({ path: path.join(root, 'docs', 'screens', 'pdf2img-bar.png') });
    }

    // 용량 줄이기: 슬라이더 ↔ 숫자, 눈금 칩, 목표 10MB
    const heavy = await PDFDocument.create();
    const hf = await heavy.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 8; i++) {
      const img = await heavy.embedJpg(photoJpeg(1200, 1000, i + 3));
      const pg = heavy.addPage([595, 842]);
      pg.drawImage(img, { x: 40, y: 250, width: 515, height: 430 });
      pg.drawText(`Photo page ${i + 1}`, { x: 40, y: 760, size: 24, font: hf });
    }
    const heavyFile = await writePdf('현장사진.pdf', heavy);
    const heavySize = fs.statSync(heavyFile).size;
    await s.click('#tab-compress');
    await s.setInputFiles('#cmp-input', [heavyFile]);
    await s.waitForSelector('#cmp-target:not([hidden])', { timeout: 60000 });
    const ticks = await s.$$eval('#cmp-ticks .vol-tick', (els) => els.map((e) => Number(e.dataset.mb)));
    await s.fill('#cmp-mb', '6');
    const thumbNow = await s.$eval('#cmp-thumb', (e) => e.getAttribute('aria-valuenow'));
    await s.focus('#cmp-thumb');
    await s.keyboard.press('ArrowRight');
    const afterKey = await s.$eval('#cmp-mb', (e) => e.value);
    await s.click('.vol-tick[data-mb="10"]');
    const tickVal = await s.$eval('#cmp-mb', (e) => e.value);
    const t0 = Date.now();
    await s.click('#cmp-go');
    await s.waitForSelector('#cmp-result:not([hidden])', { timeout: 120000 });
    const took = Date.now() - t0;
    const st2 = await s.evaluate(() => window.__pdfWorkshop.compress());
    const summary = (await s.textContent('#cmp-summary')).trim();
    const heavyMB = heavySize / 1024 / 1024;
    const expectTicks = [10, 20, 5, 2].filter((v) => v < heavyMB);
    check('용량 줄이기: 슬라이더 ↔ 숫자 입력 · 눈금 칩은 원래보다 작은 것만', thumbNow === '6' && afterKey === '6.5' && tickVal === '10' &&
      ticks.join(',') === expectTicks.join(',') && ticks.every((v) => v < heavyMB),
    `원래 ${heavyMB.toFixed(1)}MB → 칩 ${ticks.join(', ')}MB · 숫자 6 → 막대 ${thumbNow} · → 키 ${afterKey} · 칩 → ${tickVal}`);
    const res = st2.files[0];
    check('용량 줄이기: 목표 10MB 결과 (글자 남김)', res.result <= 10 * 1024 * 1024 && /✓ 목표\(10MB\) 이하/.test(summary) && res.stage === 2,
      `${summary} · ${res.stage}단계 · ${(took / 1000).toFixed(1)}초 · Worker ${await s.evaluate(() => window.__pdfWorkshop.worker)}`);
    uiMeasures.push(`현장사진 PDF(8장) ${heavyMB.toFixed(1)}MB → 목표 10MB: ${(res.result / 1024 / 1024).toFixed(1)}MB · ${(took / 1000).toFixed(1)}초 · ${res.stage}단계 (브라우저)`);
    [dlS] = await Promise.all([s.waitForEvent('download'), s.click('#cmp-save')]);
    const shrunk = fs.readFileSync(await dlS.path());
    const shrunkDoc = await PDFDocument.load(shrunk);
    check('줄인 파일 저장', dlS.suggestedFilename() === '현장사진_줄임.pdf' && shrunkDoc.getPageCount() === 8 && shrunk.length <= 10 * 1024 * 1024,
      `${dlS.suggestedFilename()} · ${shrunkDoc.getPageCount()}쪽 · ${(shrunk.length / 1024 / 1024).toFixed(1)}MB`);
    // 비교해 보기
    await s.click('#cmp-compare');
    await until(s, () => document.querySelectorAll('#cv-a canvas, #cv-b canvas').length === 2, undefined, { timeout: 20000 });
    const cmpOk = await s.evaluate(() => document.getElementById('compare-dialog').open);
    await s.keyboard.press('Escape');
    check('비교해 보기 (원본 · 결과 나란히)', cmpOk, '두 칸에 같은 쪽을 그림');
    if (SCREENS) {
      await s.evaluate(() => window.scrollTo(0, 0));
      await s.waitForTimeout(300);
      await s.evaluate(() => document.getElementById('toasts').replaceChildren());
      await s.screenshot({ path: path.join(root, 'docs', 'screens', 'compress.png') });
    }

    // 설정하고 저장 창 스크린샷 (새 창: 기억한 설정 없이)
    if (SCREENS) {
      const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
      const d = await dctx.newPage();
      await d.goto(BASE, { waitUntil: 'networkidle' });
      await d.evaluate(() => document.fonts.ready);
      await d.setInputFiles('#home-input', [await writePdf('회의자료.pdf', await samplePdf(6, 'Meeting'))]);
      await until(d, () => document.querySelectorAll('#edit-grid .page-card').length === 6);
      await d.click('#edit-save-opts');
      await d.waitForSelector('#save-dialog[open]');
      for (const k of ['number', 'watermark', 'stamp']) await d.click(`#sd-items .acc[data-item="${k}"] .acc-head`);
      await d.click('#sd-items [data-act="draw"]');
      await d.waitForSelector('#sign-dialog[open]');
      const sp = await d.locator('#sign-canvas').boundingBox();
      await d.mouse.move(sp.x + 60, sp.y + 120);
      await d.mouse.down();
      for (let i = 1; i <= 24; i++) await d.mouse.move(sp.x + 60 + i * 14, sp.y + 115 - Math.sin(i / 2.2) * 38 + (i % 5) * 2);
      await d.mouse.up();
      await d.click('#sign-ok');
      await d.waitForSelector('#sd-preview .pv-stamp');
      await d.click('#sd-items .acc[data-item="number"] label:has(> input[value="total"])');
      await d.evaluate(() => { document.querySelector('.sd-options').scrollTop = 0; document.getElementById('toasts').replaceChildren(); });
      await d.waitForTimeout(800);
      await d.screenshot({ path: path.join(root, 'docs', 'screens', 'save-dialog.png') });
      await dctx.close();
    }
    check('저장·나눠 저장·사진·용량 흐름 콘솔 에러 0개', serr.length === 0, serr.length ? serr.join(' | ').slice(0, 300) : '0개');
    await sctx.close();
  }

  // ── 12. 스크린샷 ──
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
    await p.screenshot({ path: path.join(out, 'home-6tools.png'), fullPage: true });
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

    // 여러 쪽 선택 + 사용법 패널 (1440px)
    const sMany = await writePdf('수업자료.pdf', await samplePdf(12, 'Lesson'));
    const wd = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', deviceScaleFactor: 1 });
    const wp = await wd.newPage();
    await wp.goto(BASE, { waitUntil: 'networkidle' });
    await wp.evaluate(() => document.fonts.ready);
    await wp.setInputFiles('#home-input', [sMany]);
    await until(wp, () => document.querySelectorAll('#edit-grid .page-card canvas').length >= 10, undefined, { timeout: 15000 });
    const wc = wp.locator('#edit-grid .page-card');
    await wc.nth(1).click();
    await wc.nth(3).click({ modifiers: ['Control'] });
    await wc.nth(6).click({ modifiers: ['Control'] });
    await wp.mouse.move(5, 5);
    await wp.waitForTimeout(4200); // 예시가 "2쪽 선택됨" 장면쯤 오도록
    await wp.screenshot({ path: path.join(out, 'multiselect.png') });
    await wd.close();

    // 1000px: 사용법 서랍
    const nd = await browser.newContext({ viewport: { width: 1000, height: 800 }, colorScheme: 'light', deviceScaleFactor: 1 });
    const np = await nd.newPage();
    await np.goto(BASE, { waitUntil: 'networkidle' });
    await np.evaluate(() => document.fonts.ready);
    await np.setInputFiles('#home-input', [sMany]);
    await until(np, () => document.querySelectorAll('#edit-grid .page-card canvas').length >= 6, undefined, { timeout: 15000 });
    await np.click('#guide-open');
    await np.waitForTimeout(4200);
    await np.screenshot({ path: path.join(out, 'guide-drawer.png') });
    await nd.close();
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
if (uiMeasures.length) console.log(`\n용량 줄이기 실측(브라우저)\n- ${uiMeasures.join('\n- ')}`);
console.log(`\n${rows.length}개 중 ${rows.length - failed}개 통과${failed ? `, ${failed}개 실패` : ''}`);
process.exit(failed ? 1 : 0);
