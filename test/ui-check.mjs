// 헤드리스 브라우저 점검 (playwright가 있을 때만).
// 실행: node test/ui-check.mjs            점검만
//       node test/ui-check.mjs --screens  점검 + docs/screens/ 에 스크린샷 저장
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
  // 작업 중 새로고침 · 이동에는 "작업 중인 내용이 사라져요" 확인이 뜬다. 점검에서는 그대로 진행한다.
  pg.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
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
  const badCopy = await badLoc.first().locator('.toast-copy').count();
  check('손상/가짜 PDF는 알림으로 안내 (+[오류 내용 복사])', /PDF 파일이 아니에요/.test(badToast) && badCopy === 1, badToast.replace(/\s+/g, ' ').trim());

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
    // 위 안내줄 · 아래 저장 막대에 가리지 않는 곳으로 카드를 올린다
    await t.evaluate(() => { const c = document.querySelectorAll('#edit-grid .page-card')[1]; window.scrollTo(0, c.getBoundingClientRect().top + scrollY - 150); });
    await t.waitForTimeout(200);
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
    const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
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
    const vnow = () => s.$eval('#cmp-thumb', (e) => Number(e.getAttribute('aria-valuenow')));
    const firstVal = await s.$eval('#cmp-mb', (e) => e.value);
    const stepText = await s.textContent('#cmp-step');
    await s.fill('#cmp-mb', '6');
    const thumbNow = await s.$eval('#cmp-thumb', (e) => e.getAttribute('aria-valuenow'));
    await s.focus('#cmp-thumb');
    await s.keyboard.press('ArrowRight');
    const afterKey = await s.$eval('#cmp-mb', (e) => e.value);
    // 실제 마우스: 손잡이를 눌러 오른쪽으로 끌기
    const tb = await s.locator('#cmp-thumb').boundingBox();
    const before = await vnow();
    await s.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await s.mouse.down();
    await s.mouse.move(tb.x + tb.width / 2 + 60, tb.y + tb.height / 2, { steps: 4 });
    await s.mouse.move(tb.x + tb.width / 2 + 140, tb.y + tb.height / 2 + 6, { steps: 6 });
    await s.mouse.up();
    const afterDrag = await vnow();
    const dragInput = await s.$eval('#cmp-mb', (e) => e.value);
    // 트랙 클릭(25% 지점)
    const tr = await s.locator('#cmp-track').boundingBox();
    await s.mouse.click(tr.x + tr.width * 0.25, tr.y + tr.height / 2);
    const afterClick = await vnow();
    const rg = await s.evaluate(() => window.__pdfWorkshop.compress().range);
    const expectClick = (rg.min + (rg.max - rg.min) * 0.25) / 1024 / 1024;
    // 터치로 끌기
    const cdpT = await sctx.newCDPSession(s);
    const tb2 = await s.locator('#cmp-thumb').boundingBox();
    const tp = { x: tb2.x + tb2.width / 2, y: tb2.y + tb2.height / 2 };
    const beforeTouch = await vnow();
    await cdpT.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp] });
    for (let i = 1; i <= 6; i++) await cdpT.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tp.x + i * 20, y: tp.y }] });
    await cdpT.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const afterTouch = await vnow();
    const onStep = (v) => Math.abs(v / 0.2 - Math.round(v / 0.2)) < 1e-6;
    check('목표 막대: 한 칸 0.2MB · 마우스 끌기 · 트랙 클릭 · 터치 끌기(실제 포인터)', stepText === '한 칸 0.2MB' && firstVal === '10.0' &&
      afterDrag > before + 1 && onStep(afterDrag) && String(afterDrag.toFixed(1)) === dragInput &&
      Math.abs(afterClick - expectClick) <= 0.2 && afterTouch > beforeTouch + 0.5,
    `${stepText}, 처음 ${firstVal} · 끌기 ${before}→${afterDrag}MB · 트랙 25% → ${afterClick}MB(기대 ${expectClick.toFixed(2)}) · 터치 ${beforeTouch}→${afterTouch}MB`);
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
    check('용량 줄이기: 슬라이더 ↔ 숫자 입력 · 눈금 칩은 원래보다 작은 것만', thumbNow === '6.0' && afterKey === '6.2' && tickVal === '10.0' &&
      ticks.join(',') === expectTicks.join(',') && ticks.every((v) => v < heavyMB),
    `원래 ${heavyMB.toFixed(1)}MB → 칩 ${ticks.join(', ')}MB · 숫자 6 → 막대 ${thumbNow} · → 키 ${afterKey} · 칩 → ${tickVal}`);
    const res = st2.files[0];
    const ratio = res.result / (10 * 1024 * 1024);
    check('용량 줄이기: 목표 10MB에 가깝게(85~100%) · 목표 · 결과 · 화질 표시', ratio <= 1 && ratio >= 0.85 && /✓ 목표\(10\.0MB\) 이하/.test(summary) && /목표 10\.0MB · 결과 [\d.]+MB · 화질 /.test(summary) && res.stage === 2,
      `${summary.replace(/\s+/g, ' ')} · ${res.stage}단계 · ${(took / 1000).toFixed(1)}초 · Worker ${await s.evaluate(() => window.__pdfWorkshop.worker)}`);
    uiMeasures.push(`현장사진 PDF(8장) ${heavyMB.toFixed(1)}MB → 목표 10MB: ${(res.result / 1024 / 1024).toFixed(1)}MB(${Math.round(ratio * 100)}%) · ${(took / 1000).toFixed(1)}초 · ${res.stage}단계 (브라우저)`);

    // Worker가 죽으면 메인 스레드에서 다시
    await s.evaluate(() => { self.__pdfTestFailWorker = true; });
    await s.fill('#cmp-mb', '8');
    await s.click('#cmp-go');
    await s.waitForSelector('#cmp-result:not([hidden])', { timeout: 120000 });
    const fb = await s.evaluate(() => ({ r: window.__pdfWorkshop.compress().files[0].result, stage: window.__pdfWorkshop.lastStage(), errs: document.querySelectorAll('.toast.error').length }));
    check('Worker가 멈추면 메인 스레드에서 다시 해서 끝냄', fb.r && fb.r <= 8 * 1024 * 1024 && fb.errs === 0,
      `결과 ${(fb.r / 1024 / 1024).toFixed(1)}MB · 오류 알림 ${fb.errs}개`);
    [dlS] = await Promise.all([s.waitForEvent('download'), s.click('#cmp-save')]);
    const shrunk = fs.readFileSync(await dlS.path());
    const shrunkDoc = await PDFDocument.load(shrunk);
    check('줄인 파일 저장', dlS.suggestedFilename() === '현장사진_줄임.pdf' && shrunkDoc.getPageCount() === 8 && shrunk.length <= 8 * 1024 * 1024,
      `${dlS.suggestedFilename()} · ${shrunkDoc.getPageCount()}쪽 · ${(shrunk.length / 1024 / 1024).toFixed(1)}MB`);
    // 비교해 보기
    await s.click('#cmp-compare');
    await until(s, () => document.querySelectorAll('#cv-a canvas, #cv-b canvas').length === 2, undefined, { timeout: 20000 });
    const cmpOk = await s.evaluate(() => document.getElementById('compare-dialog').open);
    await s.keyboard.press('Escape');
    check('비교해 보기 (원본 · 결과 나란히)', cmpOk, '두 칸에 같은 쪽을 그림');

    // 작은 파일(0.5MB): 한 칸 0.01MB, 두 자리까지
    {
      const small = await PDFDocument.create();
      const sf = await small.embedFont(StandardFonts.Helvetica);
      const img = await small.embedJpg(photoJpeg(680, 520, 11));
      const pg = small.addPage([595, 842]);
      pg.drawImage(img, { x: 40, y: 300, width: 515, height: 394 });
      pg.drawText('Small photo', { x: 40, y: 760, size: 24, font: sf });
      const smallFile = await writePdf('작은사진.pdf', small);
      await s.click('#cmp-files .cf-x');
      await s.setInputFiles('#cmp-input', [smallFile]);
      await s.waitForSelector('#cmp-target:not([hidden])', { timeout: 60000 });
      const sm = await s.evaluate(() => ({ step: document.getElementById('cmp-step').textContent, bubble: document.getElementById('cmp-bubble').textContent, input: document.getElementById('cmp-mb').value, locked: document.getElementById('cmp-vol').classList.contains('locked') }));
      await s.focus('#cmp-thumb');
      await s.keyboard.press('ArrowLeft');
      const smLeft = await s.$eval('#cmp-mb', (e) => e.value);
      await s.fill('#cmp-mb', '9');
      const sameMsg = await s.evaluate(() => ({ msg: document.getElementById('cmp-msg').textContent, go: document.getElementById('cmp-go').disabled }));
      const sizeMB = fs.statSync(smallFile).size / 1024 / 1024;
      check('작은 파일: 한 칸 0.01MB · 두 자리 표시 · 원래 이상이면 "원본 그대로"', sm.step === '한 칸 0.01MB' && /^\d\.\d\dMB$/.test(sm.bubble) && /^\d\.\d\d$/.test(sm.input) && !sm.locked &&
        Math.abs(Number(sm.input) - Number(smLeft) - 0.01) < 1e-6 && /원본 그대로면 돼요/.test(sameMsg.msg) && sameMsg.go,
      `${sizeMB.toFixed(2)}MB 파일 · ${sm.step} · 막대 ${sm.bubble} · ← 키 ${sm.input}→${smLeft} · 9MB 입력: "${sameMsg.msg}" [줄이기] 꺼짐`);
      await s.click('#cmp-files .cf-x');
    }

    // 줄일 여지 5% 미만: 막대 잠김 + 안내, 3단계는 숫자로
    {
      const textOnly = await PDFDocument.create();
      const tf = await textOnly.embedFont(StandardFonts.Helvetica);
      for (let i = 0; i < 40; i++) {
        const pg = textOnly.addPage([595, 842]);
        for (let k = 0; k < 40; k++) pg.drawText(`Line ${k} of page ${i}: The quick brown fox jumps over the lazy dog ${i * k}`, { x: 30, y: 800 - k * 19, size: 10, font: tf });
      }
      const textFile = await writePdf('글자만.pdf', textOnly);
      await s.setInputFiles('#cmp-input', [textFile]);
      await s.waitForSelector('#cmp-target:not([hidden])', { timeout: 60000 });
      const lk = await s.evaluate(() => ({ locked: document.getElementById('cmp-vol').classList.contains('locked'), msg: document.getElementById('cmp-msg').textContent, tab: document.getElementById('cmp-thumb').tabIndex }));
      const v0 = await s.$eval('#cmp-mb', (e) => e.value);
      const tr2 = await s.locator('#cmp-track').boundingBox();
      await s.mouse.click(tr2.x + tr2.width * 0.1, tr2.y + tr2.height / 2, { force: true }).catch(() => {});
      const v1 = await s.$eval('#cmp-mb', (e) => e.value);
      await s.fill('#cmp-mb', '0.01');
      const low = await s.evaluate(() => ({ msg: document.getElementById('cmp-msg').textContent, go: document.getElementById('cmp-go').disabled }));
      check('여지 5% 미만이면 막대 잠김 + 안내, 숫자로 3단계', lk.locked && lk.tab === -1 && /더 줄일 여지가 거의 없어요/.test(lk.msg) && v0 === v1 &&
        /최소 약 .*3단계/.test(low.msg) && !low.go,
      `잠김 ${lk.locked} · "${lk.msg.slice(0, 40)}…" · 트랙 클릭해도 ${v0} 그대로 · 0.01 입력: [줄이기] 켜짐`);
      await s.click('#cmp-files .cf-x');
    }

    // 오류 알림에 [오류 내용 복사] (파일 이름은 넣지 않음)
    {
      await s.evaluate(() => document.getElementById('toasts').replaceChildren());
      await s.setInputFiles('#cmp-input', [notPdf]);
      await s.waitForSelector('.toast.error .toast-copy', { timeout: 20000 });
      await s.click('.toast.error .toast-copy');
      await s.waitForTimeout(300);
      const clip = await s.evaluate(() => navigator.clipboard.readText());
      const btnText = await s.textContent('.toast.error .toast-copy');
      check('오류 알림: [오류 내용 복사] · 파일 이름 · 내용 빠짐', btnText === '복사했어요 ✓' && /\[PDF 작업실 오류 보고\]/.test(clip) && /오류: UserError/.test(clip) && /브라우저: /.test(clip) && !/가짜/.test(clip) && !/this is not a pdf/.test(clip),
        clip.split('\n').slice(0, 6).join(' / ').slice(0, 220));
      await s.click('#cmp-files .cf-x');
    }
    if (SCREENS) {
      await s.evaluate(() => window.scrollTo(0, 0));
      await s.waitForTimeout(300);
      await s.evaluate(() => document.getElementById('toasts').replaceChildren());
      await s.screenshot({ path: path.join(root, 'docs', 'screens', 'compress.png') });
    }

    if (SCREENS) {
    // 색 변환 확인: HWP에서 흔한 이미지 형식을 줄이기 전·후 나란히 (docs/screens/compress-colors.png)
    {
      const { colorSamplesPdf } = await import('./node-codec.mjs');
      const cs = await colorSamplesPdf();
      const colorFile = path.join(tmp, '색샘플.pdf');
      fs.writeFileSync(colorFile, cs.bytes);
      const cctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light', acceptDownloads: true, deviceScaleFactor: 1 });
      const c = await cctx.newPage();
      await c.goto(`${BASE}/#compress`, { waitUntil: 'networkidle' });
      await c.setInputFiles('#cmp-input', [colorFile]);
      await c.waitForSelector('#cmp-target:not([hidden])', { timeout: 60000 });
      await c.fill('#cmp-mb', '0.01'); // 가장 세게 → 모든 사진을 다시 만든다
      await c.click('#cmp-go');
      await c.waitForSelector('#confirm-dialog[open]', { timeout: 60000 });
      await c.click('#cf-no'); // 3단계는 하지 않고 여기까지
      await c.waitForSelector('#cmp-result:not([hidden])', { timeout: 60000 });
      const [dlc] = await Promise.all([c.waitForEvent('download'), c.click('#cmp-save')]);
      const outBytes = fs.readFileSync(await dlc.path());
      await c.evaluate(async ({ a, b, names }) => {
        const bin = (s) => Uint8Array.from(atob(s), (x) => x.charCodeAt(0));
        const [da, db] = await Promise.all([a, b].map((x) => pdfjsLib.getDocument({ data: bin(x) }).promise));
        const wrap = document.createElement('div');
        wrap.id = 'color-sheet';
        wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#EEF1F6;padding:18px 22px;font:13px/1.4 "Pretendard Variable",sans-serif;color:#172033;overflow:hidden';
        wrap.innerHTML = '<h2 style="margin:0 0 4px;font-size:18px">용량 줄이기 색 확인 — 왼쪽 원본, 오른쪽 줄인 결과(pdf.js로 그림)</h2><p style="margin:0 0 12px;color:#667085">가장 세게 줄인 상태(크기 0.35배 · 품질 0.4). 결과는 모두 DeviceRGB JPEG로 다시 넣음.</p>';
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px 14px';
        wrap.append(grid);
        for (let i = 0; i < names.length; i++) {
          const cell = document.createElement('div');
          cell.style.cssText = 'background:#fff;border-radius:10px;padding:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)';
          cell.innerHTML = `<b style="display:block;margin-bottom:6px">${names[i]}</b>`;
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:6px';
          for (const d of [da, db]) {
            const pg = await d.getPage(i + 1);
            const vp = pg.getViewport({ scale: 0.55 });
            const cv = document.createElement('canvas');
            cv.width = vp.width; cv.height = vp.height;
            await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
            row.append(cv);
          }
          cell.append(row);
          grid.append(cell);
        }
        document.body.append(wrap);
      }, { a: Buffer.from(cs.bytes).toString('base64'), b: outBytes.toString('base64'), names: cs.samples.map((x) => x.name) });
      await c.waitForTimeout(300);
      await c.evaluate(() => document.getElementById('toasts').replaceChildren());
      const sheetH = await c.evaluate(() => Math.ceil(document.querySelector('#color-sheet > div').getBoundingClientRect().bottom + 18));
      await c.screenshot({ path: path.join(root, 'docs', 'screens', 'compress-colors.png'), clip: { x: 0, y: 0, width: 1280, height: Math.min(1000, sheetH) } });
      await cctx.close();
    }
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

  // ── 13. 쪽 크기 · 빈 쪽 · 양면 스캔 · 파일 정보 · 일괄 처리 · HEIC ──
  {
    const { rgb: rgbC, degrees: degC } = PDFLib;
    async function mk(name, specs) {
      const d = await PDFDocument.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      for (const s of specs) {
        const w = s.w || 595.28;
        const hh = s.h || 841.89;
        const pg = d.addPage([w, hh]);
        if (s.text) pg.drawText(s.text, { x: 50, y: hh - 80, size: 22, font: f });
        if (s.lines) for (let k = 0; k < 18; k++) pg.drawRectangle({ x: 50, y: hh - 130 - k * 30, width: Math.min(420, w - 100), height: 8, color: rgbC(0.72, 0.74, 0.8) });
        if (s.specks) for (let k = 0; k < 20; k++) pg.drawRectangle({ x: 60 + ((k * 97) % 450), y: 80 + ((k * 131) % 650), width: 1.5, height: 1.5, color: rgbC(0.2, 0.2, 0.2) });
        if (s.rot) pg.setRotation(degC(s.rot));
      }
      return writePdf(name, d);
    }
    const mixedFile = await mk('자료모음.pdf', [
      { text: 'Page 1', lines: 1 }, { text: 'Page 2', lines: 1 }, { w: 841.89, h: 595.28, text: 'Landscape 3', lines: 1 },
      { w: 515.91, h: 728.5, text: 'B5 page 4', lines: 1 }, {}, { specks: 1 }, { text: 'Page 7', lines: 1 },
    ]);
    const frontFile = await mk('앞면.pdf', [1, 2, 3, 4].map((i) => ({ text: `Front ${i}`, lines: 1 })));
    const backFile = await mk('뒷면.pdf', [4, 3, 2, 1].map((i) => ({ text: `Back ${i}`, lines: 1 })));
    const back3File = await mk('뒷면3.pdf', [3, 2, 1].map((i) => ({ text: `Back ${i}`, lines: 1 })));

    const xctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
    const x = await xctx.newPage();
    const xerr = [];
    watch(x, xerr);
    await x.goto(`${BASE}/#edit`, { waitUntil: 'networkidle' });
    await x.setInputFiles('#edit-input', [mixedFile]);
    await until(x, () => document.querySelectorAll('#edit-grid .page-card').length === 7);
    // 크기 안내줄
    await until(x, () => !document.getElementById('edit-sizes').hidden);
    const sizeText = await x.textContent('#edit-sizes-text');
    // 빈 쪽 안내줄 (썸네일 렌더를 재사용해 찾는다)
    await until(x, () => !document.getElementById('edit-blank').hidden && /빈 쪽으로 보이는 쪽이/.test(document.getElementById('edit-blank-text').textContent) && !/찾는 중/.test(document.getElementById('edit-blank-text').textContent), undefined, { timeout: 20000 });
    const blankText = await x.textContent('#edit-blank-text');
    const badges = await x.$$eval('#edit-grid .page-card.blank', (els) => els.length);
    if (SCREENS) {
      await x.evaluate(() => { document.getElementById('toasts').replaceChildren(); window.scrollTo(0, 0); });
      await x.waitForTimeout(300);
      await x.screenshot({ path: path.join(root, 'docs', 'screens', 'blank-pages.png') });
    }
    await x.click('#blank-mark');
    const afterMark = await x.evaluate(() => ({ del: document.querySelectorAll('#edit-grid .page-card.deleted').length, count: document.getElementById('edit-count').textContent, hidden: document.getElementById('edit-blank').hidden }));
    check('빈 쪽 찾기 → 안내줄 · "빈 쪽?" 배지 · 삭제 예정 표시', /2개 있어요 \(5, 6쪽\)/.test(blankText) && badges === 2 && afterMark.del === 2 && /5쪽 저장 예정/.test(afterMark.count) && afterMark.hidden,
      `"${blankText}" · 배지 ${badges}개 → 삭제 예정 ${afterMark.del}쪽, ${afterMark.count}`);
    // 크기 맞추기: 모두 A4 세로로 → 바로 저장
    await x.click('#edit-sizes label:has(> input[value="fit"])');
    if (SCREENS) {
      await x.evaluate(() => { document.getElementById('toasts').replaceChildren(); window.scrollTo(0, 0); });
      await x.waitForTimeout(200);
      await x.screenshot({ path: path.join(root, 'docs', 'screens', 'page-size.png') });
    }
    let [dlx] = await Promise.all([x.waitForEvent('download'), x.click('#edit-save')]);
    const fitDoc = await PDFDocument.load(fs.readFileSync(await dlx.path()));
    const fitDims = [...new Set(fitDoc.getPages().map((pg) => `${Math.round(pg.getWidth())}×${Math.round(pg.getHeight())}`))];
    const fitText = await x.evaluate(async (b64) => {
      const d = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
      const out = [];
      for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((it) => it.str).join(''));
      return out;
    }, fs.readFileSync(await dlx.path()).toString('base64'));
    check('쪽 크기가 섞이면 안내줄 → "모두 A4 세로로" 저장(글자 유지)', /A4 세로 5 · A4 가로 1 · B5 세로 1/.test(sizeText) && fitDoc.getPageCount() === 5 && fitDims.join() === '595×842' && fitText.join('|') === 'Page 1|Page 2|Landscape 3|B5 page 4|Page 7',
      `"${sizeText.slice(0, 44)}…" → ${fitDoc.getPageCount()}쪽 모두 ${fitDims.join()} · 글자 ${fitText.join(', ')}`);
    await x.click('#edit-sizes label:has(> input[value="keep"])');

    // ⓘ 팝오버: 열기 · Esc · 바깥 클릭
    await x.locator('#edit-chips .info-btn').first().click();
    await until(x, () => !document.getElementById('info-pop').hidden && document.querySelectorAll('#ip-list dt').length >= 6, undefined, { timeout: 10000 });
    const info = await x.evaluate(() => [...document.querySelectorAll('#ip-list dt')].map((dt) => `${dt.textContent}=${dt.nextElementSibling.textContent}`));
    if (SCREENS) {
      await x.evaluate(() => document.getElementById('toasts').replaceChildren());
      await x.screenshot({ path: path.join(root, 'docs', 'screens', 'file-info.png') });
    }
    await x.keyboard.press('Escape');
    const closedEsc = await x.$eval('#info-pop', (e) => e.hidden);
    await x.locator('#edit-chips .info-btn').first().click();
    await until(x, () => !document.getElementById('info-pop').hidden);
    await x.mouse.click(700, 600);
    const closedOut = await x.$eval('#info-pop', (e) => e.hidden);
    check('파일 정보 ⓘ: 쪽수 · 크기 분포 · 프로그램 · 잠금 · 형식 · 글자 · 날짜, Esc · 바깥 클릭으로 닫힘', info.length === 7 && info.some((r) => /^쪽 크기=A4 세로 5/.test(r)) && info.some((r) => /^글자=있음/.test(r)) && closedEsc && closedOut,
      info.join(' / ').slice(0, 230));

    // 양면 스캔: 4쪽 + 4쪽 → 짝 확인 → 저장, 4 + 3 → 경고 → 그대로 진행
    await x.setInputFiles('#edit-input', [frontFile, backFile, back3File]);
    await until(x, () => document.querySelectorAll('#edit-chips .chip:not(.add)').length === 4);
    await x.click('#edit-duplex');
    await x.selectOption('#dx-front-sel', { label: '앞면.pdf (4쪽)' });
    await x.selectOption('#dx-back-sel', { label: '뒷면.pdf (4쪽)' });
    const dxOk = await x.evaluate(() => ({ st: document.getElementById('dx-status').textContent, strip: document.querySelectorAll('#dx-strip i').length, save: !document.getElementById('dx-save').disabled }));
    if (SCREENS) {
      await x.evaluate(() => document.getElementById('toasts').replaceChildren());
      await x.locator('#duplex-panel').scrollIntoViewIfNeeded();
      await x.waitForTimeout(200);
      await x.screenshot({ path: path.join(root, 'docs', 'screens', 'duplex.png') });
    }
    [dlx] = await Promise.all([x.waitForEvent('download'), x.click('#dx-save')]);
    const dxName = dlx.suggestedFilename();
    const dxText = await x.evaluate(async (b64) => {
      const d = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
      const out = [];
      for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((it) => it.str).join(''));
      return out;
    }, fs.readFileSync(await dlx.path()).toString('base64'));
    await x.selectOption('#dx-back-sel', { label: '뒷면3.pdf (3쪽)' });
    const dxWarn = await x.evaluate(() => ({ warn: !document.getElementById('dx-warn').hidden && document.getElementById('dx-warn-text').textContent, save: document.getElementById('dx-save').disabled }));
    await x.click('#dx-go-anyway');
    await x.click('#dx-expand');
    const expanded = await x.$$eval('#edit-grid .page-src', (els) => els.map((e) => e.textContent).slice(-7));
    check('양면 스캔: 짝 확인 → 저장(앞1·뒤1…) · 쪽수 다르면 경고 → 그대로 진행 → 펼치기', /✓ 앞면 4쪽 · 뒷면 4쪽, 짝이 맞아요/.test(dxOk.st) && dxOk.strip === 8 && dxOk.save &&
      dxName === '앞면_양면.pdf' && dxText.join(',') === 'Front 1,Back 1,Front 2,Back 2,Front 3,Back 3,Front 4,Back 4' &&
      /뒷면이 1쪽 모자라요/.test(dxWarn.warn || '') && dxWarn.save && expanded.length === 7,
    `${dxOk.st} → ${dxName}: ${dxText.join(' ')} · 4+3: "${String(dxWarn.warn).slice(0, 30)}…" → 펼침 ${expanded.join(' ')}`);

    // 일괄 처리: 보안(풀기) 3개 중 1개 비밀번호 다름 → 따로 처리
    const lockedSample = async (name, pwd, n) => {
      const d = await samplePdf(n, name);
      d.encrypt({ userPassword: pwd, ownerPassword: pwd });
      return writePdf(`${name}.pdf`, d, { useObjectStreams: false });
    };
    const l1 = await lockedSample('가정통신문1', 'aaa', 2);
    const l2 = await lockedSample('가정통신문2', 'aaa', 3);
    const l3 = await lockedSample('가정통신문3', 'bbb', 1);
    await x.click('#tab-security');
    await x.setInputFiles('#unlock-input', [l1, l2, l3]);
    await x.fill('#unlock-pw', 'aaa');
    await x.click('#unlock-save');
    await until(x, () => document.querySelectorAll('#sec-batch .br-badge.done, #sec-batch .br-badge.fail').length === 3, undefined, { timeout: 20000 });
    const b1 = await x.evaluate(() => ({ badges: [...document.querySelectorAll('#sec-batch .br-badge')].map((e) => e.textContent), prog: document.querySelector('#sec-batch .batch-progress span').textContent }));
    if (SCREENS) {
      await x.evaluate(() => document.getElementById('toasts').replaceChildren());
      await x.locator('#sec-batch .batch:not([hidden])').scrollIntoViewIfNeeded();
      await x.waitForTimeout(200);
      await x.screenshot({ path: path.join(root, 'docs', 'screens', 'batch.png') });
    }
    await x.fill('#sec-batch .batch-row.fail input[type="password"]', 'bbb');
    await x.click('#sec-batch .batch-row.fail button:has-text("다시")');
    await until(x, () => document.querySelectorAll('#sec-batch .br-badge.done').length === 3, undefined, { timeout: 10000 });
    await x.fill('#sec-batch .prefix input', '풀림_');
    [dlx] = await Promise.all([x.waitForEvent('download'), x.click('#sec-batch [data-b="save"]')]);
    const bz = await JSZip.loadAsync(fs.readFileSync(await dlx.path()));
    const bnames = Object.keys(bz.files).sort();
    const bdocs = await Promise.all(bnames.map(async (n) => (await PDFDocument.load(await bz.files[n].async('uint8array'))).getPageCount()));
    check('일괄 처리(보안): 목록 모드 · 진행 · 실패 줄 따로 처리 · 접두어 zip', b1.badges.join() === '완료,완료,실패' && /3 \/ 3 처리 · 실패 1/.test(b1.prog) &&
      bnames.join() === '풀림_가정통신문1_암호해제.pdf,풀림_가정통신문2_암호해제.pdf,풀림_가정통신문3_암호해제.pdf' && bdocs.join() === '2,3,1',
    `${b1.prog} → 따로 처리 → ${dlx.suggestedFilename()}: ${bnames.join(', ')}`);

    // 일괄 처리(꾸미기): 쪽번호를 두 파일에
    await x.click('#tab-decorate');
    await x.setInputFiles('#decor-input', [frontFile, back3File]);
    await until(x, () => !document.querySelector('#decor-batch .batch').hidden && !document.getElementById('decor-layout').hidden, undefined, { timeout: 10000 });
    await x.click('#decor-batch [data-b="run"]');
    await until(x, () => document.querySelectorAll('#decor-batch .br-badge.done').length === 2, undefined, { timeout: 20000 });
    [dlx] = await Promise.all([x.waitForEvent('download'), x.click('#decor-batch [data-b="save"]')]);
    const dz = await JSZip.loadAsync(fs.readFileSync(await dlx.path()));
    const dnames = Object.keys(dz.files).sort();
    const d2 = await dz.files[dnames[1]].async('uint8array');
    const dText = await x.evaluate(async (b64) => {
      const d = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
      return (await (await d.getPage(1)).getTextContent()).items.map((it) => it.str).join(' ');
    }, Buffer.from(d2).toString('base64'));
    check('일괄 처리(꾸미기): 같은 설정을 파일마다(쪽번호 1부터)', dnames.join() === '뒷면3_꾸미기.pdf,앞면_꾸미기.pdf' && /\b1\b/.test(dText),
      `${dnames.join(', ')} · 뒷면3 1쪽 글자 "${dText.slice(0, 30)}"`);

    // 일괄 처리(용량 줄이기): 합계 목표를 크기에 비례해 나눔
    await x.click('#tab-compress');
    const heavyA = await PDFDocument.create();
    for (let i = 0; i < 3; i++) heavyA.addPage([595, 842]).drawImage(await heavyA.embedJpg(photoJpeg(1000, 800, 30 + i)), { x: 40, y: 250, width: 515, height: 412 });
    const heavyB = await PDFDocument.create();
    heavyB.addPage([595, 842]).drawImage(await heavyB.embedJpg(photoJpeg(1000, 800, 40)), { x: 40, y: 250, width: 515, height: 412 });
    const hA = await writePdf('사진A.pdf', heavyA);
    const hB = await writePdf('사진B.pdf', heavyB);
    await x.setInputFiles('#cmp-input', [hA, hB]);
    await x.waitForSelector('#cmp-target:not([hidden])', { timeout: 60000 });
    await x.click('#cmp-basis label:has(> input[value="total"])');
    const totalMB = ((fs.statSync(hA).size + fs.statSync(hB).size) / 1024 / 1024) * 0.6;
    await x.fill('#cmp-mb', totalMB.toFixed(2));
    await x.click('#cmp-go');
    await x.waitForSelector('#cmp-result:not([hidden])', { timeout: 120000 });
    const cst = await x.evaluate(() => window.__pdfWorkshop.compress());
    const sumOut = cst.files.reduce((a, f) => a + (f.result || 0), 0) / 1024 / 1024;
    const badgesC = await x.$$eval('#cmp-files .br-badge', (els) => els.map((e) => e.textContent));
    check('일괄 처리(용량 줄이기): "전체 합쳐서" 목표를 비례 배분 · 상태 배지', badgesC.join() === '완료,완료' && sumOut <= totalMB + 0.01 && sumOut >= totalMB * 0.8,
      `합계 목표 ${totalMB.toFixed(2)}MB → 결과 합 ${sumOut.toFixed(2)}MB · ${cst.files.map((f) => `${(f.size / 1048576).toFixed(1)}→${(f.result / 1048576).toFixed(2)}MB`).join(', ')}`);

    // HEIC (아이폰 사진) — 샘플이 있을 때만
    const heicSamples = String(process.env.HEIC_SAMPLES || '').split(';').filter((f) => f && fs.existsSync(f));
    if (heicSamples.length) {
      await x.click('#tab-img2pdf');
      await x.click('#img-clear').catch(() => {});
      const t0 = Date.now();
      await x.setInputFiles('#img-input', heicSamples);
      await until(x, () => document.getElementById('busy').hidden && document.querySelectorAll('#img-grid .img-card').length > 0, undefined, { timeout: 60000 });
      const heicMs = Date.now() - t0;
      const heicNames = await x.$$eval('#img-grid .page-src', (els) => els.map((e) => e.textContent));
      const tiff = path.join(tmp, '스캔.tif');
      fs.writeFileSync(tiff, Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]));
      await x.setInputFiles('#img-input', [tiff]);
      const tiffToast = await x.locator('.toast', { hasText: 'TIFF는 아직 지원하지 않아요' }).first().textContent({ timeout: 5000 }).catch(() => '');
      check('HEIC(아이폰) → JPEG 변환 · TIFF 안내', heicNames.length === heicSamples.length && heicNames.every((n) => /\.jpg$/.test(n)) && /TIFF는 아직 지원하지 않아요/.test(tiffToast),
        `${heicSamples.length}장 → ${heicNames.join(', ')} · 변환기 첫 로딩 포함 ${(heicMs / 1000).toFixed(1)}초 · TIFF 알림 OK`);
      uiMeasures.push(`HEIC ${heicSamples.length}장 변환(변환기 첫 로딩 포함): ${(heicMs / 1000).toFixed(1)}초`);
    } else {
      rows.push({ name: 'HEIC(아이폰) → JPEG 변환 · TIFF 안내', ok: true, detail: '건너뜀: HEIC 샘플 없음(HEIC_SAMPLES로 경로를 알려 주세요)', skip: true });
    }
    check('쪽 크기 · 빈 쪽 · 양면 · 정보 · 일괄 흐름 콘솔 에러 0개', xerr.length === 0, xerr.length ? xerr.join(' | ').slice(0, 300) : '0개');
    await xctx.close();

    // 400px: 새 패널도 가로 스크롤 없음
    const mx = await browser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
    const mp2 = await mx.newPage();
    const mxerr = [];
    watch(mp2, mxerr);
    await mp2.goto(`${BASE}/#edit`, { waitUntil: 'networkidle' });
    await mp2.setInputFiles('#edit-input', [mixedFile, frontFile, backFile]);
    await until(mp2, () => document.querySelectorAll('#edit-grid .page-card').length === 15);
    await until(mp2, () => !document.getElementById('edit-sizes').hidden);
    await mp2.click('#edit-duplex');
    const sw1 = await mp2.evaluate(() => document.documentElement.scrollWidth);
    await mp2.locator('#edit-chips .info-btn').first().tap();
    await until(mp2, () => !document.getElementById('info-pop').hidden);
    await mp2.waitForTimeout(400); // 올라오는 움직임이 끝난 뒤
    const sheet = await mp2.evaluate(() => ({ sheet: document.getElementById('info-pop').classList.contains('sheet'), bottom: Math.round(document.getElementById('info-pop').getBoundingClientRect().bottom), vh: innerHeight }));
    await mp2.keyboard.press('Escape');
    await mp2.goto(`${BASE}/#security`, { waitUntil: 'networkidle' });
    await mp2.setInputFiles('#unlock-input', [l1, l2, l3]);
    const sw2 = await mp2.evaluate(() => document.documentElement.scrollWidth);
    check('400px: 양면 패널 · 크기 안내 · 일괄 목록 가로 스크롤 없음, ⓘ는 아래 시트', sw1 <= 400 && sw2 <= 400 && sheet.sheet && Math.abs(sheet.bottom - sheet.vh) <= 1 && mxerr.length === 0,
      `scrollWidth ${sw1} / ${sw2} · 시트 아래 끝 ${sheet.bottom}/${sheet.vh}${mxerr.length ? ` · 에러 ${mxerr.join(' | ').slice(0, 100)}` : ''}`);
    await mx.close();
  }

  // ── 11-b. 모든 도구의 "이렇게 써요" 패널 (움직이는 예시 · 저장 위치 안내) ──
  {
    const TOOLS = ['edit', 'img2pdf', 'pdf2img', 'decorate', 'compress', 'security'];
    /** 지금 보이는 예시 무대들의 모습(위치 · 클래스 · 글자)을 문자열로 */
    const stageSnap = (pg, key) => pg.evaluate((k) => {
      const figs = k === 'download'
        ? [...document.querySelectorAll('#guide-dl figure.demo')]
        : [...document.querySelectorAll(`#edit-guide .guide-sec[data-guide="${k}"] figure.demo`)];
      return figs.map((f) => f.querySelector('.demo-stage').innerHTML);
    }, key);
    const changed = (a, b) => a.length > 0 && a.every((s, i) => s !== b[i]);
    const gotoTool = async (pg, t) => {
      await pg.click(`#tab-${t}`);
      await until(pg, (x) => !document.getElementById(`panel-${x}`).hidden, t);
    };

    const gctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const g = await gctx.newPage();
    const gerr = [];
    watch(g, gerr);
    await g.goto(`${BASE}/#edit`, { waitUntil: 'networkidle' });
    await until(g, () => !document.getElementById('view-work').hidden);

    const seen = [];
    for (const t of TOOLS) {
      await gotoTool(g, t);
      const box = await g.evaluate((x) => {
        const sec = document.querySelector(`#edit-guide .guide-sec[data-guide="${x}"]`);
        const r = sec.getBoundingClientRect();
        const figs = [...sec.querySelectorAll('figure.demo')].map((f) => f.querySelector('.demo-stage').getBoundingClientRect());
        const steps = sec.querySelectorAll('.guide-steps li').length;
        const faq = sec.querySelectorAll('.faq .faq-item').length;
        const others = [...document.querySelectorAll('#edit-guide .guide-sec')].filter((s) => s !== sec && s.getBoundingClientRect().height > 0).length;
        return { w: Math.round(r.width), h: Math.round(r.height), figs: figs.map((f) => Math.round(f.height)), steps, faq, others };
      }, t);
      const a = await stageSnap(g, t);
      await g.waitForTimeout(1600);
      const b = await stageSnap(g, t);
      const st = await g.evaluate(() => window.__pdfWorkshop.guide());
      const othersStopped = Object.entries(st.playingBy).every(([k, v]) => k === t || k === 'download' || v.every((p) => !p));
      const ok = box.w > 250 && box.h > 200 && box.figs.length >= 2 && box.figs.every((hgt) => hgt >= 100) && box.others === 0 &&
        (t === 'edit' || (box.steps === 3 && box.faq === 2)) && changed(a, b) && st.playing.every(Boolean) && othersStopped;
      seen.push(`${t}${ok ? '' : `✗(${JSON.stringify(box)} 변화 ${changed(a, b)})`}`);
    }
    check('도구 6곳 모두 사용법 패널이 보이고 예시가 실제로 움직임 (다른 도구 예시는 멈춤)', seen.every((s) => !s.includes('✗')), seen.join(' · '));

    // 공통 "저장한 파일은 어디로 가나요?"
    const dlBox = await g.evaluate(() => {
      const d = document.getElementById('guide-dl');
      const r = d.getBoundingClientRect();
      return { open: d.open, h: Math.round(r.height), where: document.getElementById('dl-where').textContent };
    });
    const d1 = await stageSnap(g, 'download');
    await g.waitForTimeout(1600);
    const d2 = await stageSnap(g, 'download');
    check('공통 "저장한 파일은 어디로 가나요?" 보임 · 움직임 · 크롬 안내 문장', dlBox.open && dlBox.h > 150 && changed(d1, d2) && /크롬/.test(dlBox.where),
      `높이 ${dlBox.h}px · "${dlBox.where.slice(0, 40)}…"`);

    // 다른 도구로 옮기면 이전 도구 예시가 멈춘다(모습이 더 안 바뀜)
    await gotoTool(g, 'img2pdf');
    await g.waitForTimeout(300);
    await gotoTool(g, 'compress');
    const p1 = await stageSnap(g, 'img2pdf');
    await g.waitForTimeout(1500);
    const p2 = await stageSnap(g, 'img2pdf');
    const swSt = await g.evaluate(() => window.__pdfWorkshop.guide());
    check('도구를 옮기면 이전 도구 예시는 멈춤', p1.join() === p2.join() && swSt.playingBy.img2pdf.every((p) => !p) && swSt.playing.every(Boolean),
      `사진→PDF 재생 ${swSt.playingBy.img2pdf.join('/')}, 용량 줄이기 재생 ${swSt.playing.join('/')}`);

    // 접기는 도구마다 · 새로고침해도 유지 / 저장 위치 안내 접힘은 모든 도구 공통
    await gotoTool(g, 'pdf2img');
    await g.click('#guide-dl > summary');
    await g.click('#guide-fold');
    await g.reload({ waitUntil: 'networkidle' });
    await until(g, () => !document.getElementById('view-work').hidden);
    await gotoTool(g, 'pdf2img');
    const fold1 = await g.evaluate(() => window.__pdfWorkshop.guide());
    await gotoTool(g, 'security');
    const fold2 = await g.evaluate(() => window.__pdfWorkshop.guide());
    await gotoTool(g, 'pdf2img');
    await g.click('#guide-rail');
    await g.click('#guide-dl > summary');
    const fold3 = await g.evaluate(() => window.__pdfWorkshop.guide());
    check('접기 상태가 도구별로 저장 · "어디로 가나요" 접힘은 모든 도구 공통',
      fold1.collapsed && fold1.playing.every((p) => !p) && !fold1.dlOpen && !fold2.collapsed && !fold2.dlOpen && fold2.playingBy.download.every((p) => !p) &&
      !fold3.collapsed && fold3.dlOpen && fold3.playing.every(Boolean),
      `새로고침 후 PDF→사진 접힘=${fold1.collapsed}, 보안 접힘=${fold2.collapsed}, 안내 열림=${fold2.dlOpen}`);

    // 백그라운드 탭이면 멈춤
    await g.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const bg = await g.evaluate(() => window.__pdfWorkshop.guide());
    await g.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const fg = await g.evaluate(() => window.__pdfWorkshop.guide());
    check('백그라운드 탭에서는 예시가 멈춤', bg.playing.every((p) => !p) && fg.playing.every(Boolean), `숨김 ${bg.playing.join('/')} → 다시 ${fg.playing.join('/')}`);

    // 1600px 이상: 패널 360px, 빈 화면 카드는 가운데 최대 1100px
    await g.setViewportSize({ width: 1920, height: 1000 });
    await gotoTool(g, 'img2pdf');
    const wideBox = await g.evaluate(() => {
      const gd = document.getElementById('edit-guide').getBoundingClientRect();
      const e = document.querySelector('#panel-img2pdf .empty').getBoundingClientRect();
      const col = document.querySelector('#panel-img2pdf .empty').parentElement.getBoundingClientRect();
      return { gw: Math.round(gd.width), ew: Math.round(e.width), center: Math.abs((e.left + e.right) / 2 - (col.left + col.right) / 2) };
    });
    check('1920px: 사용법 패널 360px · 빈 화면 카드 최대 1100px 가운데', wideBox.gw === 360 && wideBox.ew <= 1100 && wideBox.center <= 2,
      `패널 ${wideBox.gw}px · 카드 ${wideBox.ew}px · 가운데 차이 ${Math.round(wideBox.center)}px`);
    check('사용법 패널 흐름 콘솔 에러 0개', gerr.length === 0, gerr.length ? gerr.join(' | ').slice(0, 300) : '0개');

    // 접근성: 예시 무대는 화면 읽기에서 숨김, 설명은 글자로
    const a11y = await g.evaluate(() => {
      const stages = [...document.querySelectorAll('#edit-guide .demo-stage')];
      const caps = [...document.querySelectorAll('#edit-guide figure.demo figcaption')];
      return { n: stages.length, hidden: stages.every((s) => s.getAttribute('aria-hidden') === 'true'), caps: caps.length, capText: caps.every((c) => c.textContent.trim().length > 10) };
    });
    check('예시 무대는 aria-hidden, 설명은 글자로 읽힘', a11y.hidden && a11y.caps === a11y.n && a11y.capText, `무대 ${a11y.n}개 · 설명 ${a11y.caps}개`);
    await gctx.close();

    // 움직임 줄이기: 마지막 장면만 멈춰서
    const rctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const r = await rctx.newPage();
    const rerr = [];
    watch(r, rerr);
    await r.goto(`${BASE}/#edit`, { waitUntil: 'networkidle' });
    await until(r, () => !document.getElementById('view-work').hidden);
    const still = [];
    for (const t of TOOLS) {
      await gotoTool(r, t);
      const a = await stageSnap(r, t);
      await r.waitForTimeout(900);
      const b = await stageSnap(r, t);
      const st = await r.evaluate(() => window.__pdfWorkshop.guide());
      const filled = a.every((s) => s.length > 200);
      still.push(`${t}${a.join() === b.join() && filled && st.playing.every((p) => !p) ? '' : '✗'}`);
    }
    check('움직임 줄이기 설정: 예시가 마지막 장면으로 멈춤', still.every((s) => !s.includes('✗')) && rerr.length === 0, still.join(' · '));
    await rctx.close();

    // 1000px: 모든 도구에서 "사용법" 서랍
    const dctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, colorScheme: 'light' });
    const dp = await dctx.newPage();
    const derr = [];
    watch(dp, derr);
    await dp.goto(`${BASE}/#edit`, { waitUntil: 'networkidle' });
    await until(dp, () => !document.getElementById('view-work').hidden);
    const drawers = [];
    for (const t of TOOLS.slice(1)) {
      await gotoTool(dp, t);
      const before = await dp.evaluate(() => window.__pdfWorkshop.guide());
      await dp.click(`#panel-${t} .guide-open`);
      await dp.waitForTimeout(300);
      const open = await dp.evaluate((x) => {
        const g2 = document.getElementById('edit-guide').getBoundingClientRect();
        const sec = document.querySelector(`#edit-guide .guide-sec[data-guide="${x}"]`).getBoundingClientRect();
        return { w: Math.round(g2.width), right: Math.round(g2.right), sec: Math.round(sec.height), st: window.__pdfWorkshop.guide() };
      }, t);
      await dp.keyboard.press('Escape');
      const after = await dp.evaluate(() => window.__pdfWorkshop.guide());
      const ok = before.playing.every((p) => !p) && open.w >= 300 && open.right === 1000 && open.sec > 200 && open.st.drawer && open.st.playing.every(Boolean) && !after.drawer;
      drawers.push(`${t}${ok ? '' : '✗'}`);
    }
    check('1000px: 모든 도구에서 [사용법] → 서랍으로 열림 · Esc로 닫힘', drawers.every((s) => !s.includes('✗')) && derr.length === 0, drawers.join(' · '));
    await dctx.close();

    // 400px: 도구마다 가로 스크롤 없음 (서랍 열어도)
    const sctx = await browser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true, colorScheme: 'light', deviceScaleFactor: 2 });
    const sp = await sctx.newPage();
    const serr = [];
    watch(sp, serr);
    await sp.goto(`${BASE}/#edit`, { waitUntil: 'networkidle' });
    await until(sp, () => !document.getElementById('view-work').hidden);
    const sws = [];
    for (const t of TOOLS) {
      await gotoTool(sp, t);
      const s1 = await sp.evaluate(() => document.documentElement.scrollWidth);
      await sp.click(`#panel-${t} .guide-open`);
      await sp.waitForTimeout(300);
      const s2 = await sp.evaluate(() => ({ sw: document.documentElement.scrollWidth, gw: Math.round(document.getElementById('edit-guide').getBoundingClientRect().width) }));
      await sp.keyboard.press('Escape');
      sws.push({ t, s1, ...s2 });
    }
    check('400px: 도구 6곳 가로 스크롤 없음 (사용법 서랍 열어도)', sws.every((x) => x.s1 <= 400 && x.sw <= 400 && x.gw <= 400) && serr.length === 0,
      sws.map((x) => `${x.t} ${x.s1}/${x.sw}`).join(' · '));
    await sctx.close();

    // 자동 접근성 검사(axe-core): 심각(critical) 0개
    const axePath = require.resolve('axe-core/axe.min.js');
    const actx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', bypassCSP: true });
    const ap = await actx.newPage();
    await ap.goto(BASE, { waitUntil: 'networkidle' });
    await ap.addScriptTag({ path: axePath });
    const axeRun = () => ap.evaluate(async () => {
      // 예시 무대는 aria-hidden 장식이고 움직이는 중에는 투명도가 바뀌므로 뺀다(설명 글은 검사한다)
      const res = await window.axe.run({ exclude: [['.demo-stage']] }, { resultTypes: ['violations'] });
      return res.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, where: v.nodes[0] && v.nodes[0].target.join(' ') }));
    });
    const axeAll = [];
    axeAll.push({ where: 'home', v: await axeRun() });
    await ap.click('.tool-card[data-open="edit"]');
    for (const t of TOOLS) {
      await gotoTool(ap, t);
      await ap.waitForTimeout(200);
      axeAll.push({ where: t, v: await axeRun() });
    }
    const crit = axeAll.flatMap((x) => x.v.filter((v) => v.impact === 'critical').map((v) => `${x.where}:${v.id}(${v.where})`));
    const serious = [...new Set(axeAll.flatMap((x) => x.v.filter((v) => v.impact === 'serious').map((v) => `${x.where}:${v.id}(${v.where})`)))];
    const ver = JSON.parse(fs.readFileSync(path.join(path.dirname(axePath), 'package.json'), 'utf8')).version;
    check(`자동 접근성 검사(axe-core ${ver}): 처음 화면 + 도구 6곳 심각(critical) · 중대(serious) 0개`, crit.length === 0 && serious.length === 0,
      crit.length ? crit.join(' | ').slice(0, 300) : `critical 0개 · serious ${serious.length ? serious.join(',') : '0개'}`);
    await actx.close();
  }

  // ── 11-c. 전송 차단(CSP) · 오프라인(서비스 워커) · 설치 정보 ──
  {
    const octx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, colorScheme: 'light' });
    const o = await octx.newPage();
    const oerr = [];
    const csp = [];
    watch(o, oerr);
    o.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && csp.push(m.text()));
    await o.goto(BASE, { waitUntil: 'networkidle' });

    const head = await octx.request.get(`${BASE}/`);
    const cspHeader = head.headers()['content-security-policy'] || '';
    const need = ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'self'", "worker-src 'self' blob:", "font-src 'self'"];
    const missing = need.filter((r) => !cspHeader.split(/;\s*/).includes(r));
    check('CSP 헤더: 이 사이트 밖으로 연결 · 스크립트 · 글꼴 차단 (unsafe-inline · eval 없음)', missing.length === 0 && !/unsafe-inline|unsafe-eval/.test(cspHeader),
      missing.length ? `빠짐: ${missing.join(', ')}` : cspHeader.replace(/; /g, ' · ').slice(0, 160));

    const man = await octx.request.get(`${BASE}/manifest.webmanifest`);
    const manJson = man.ok() ? await man.json() : {};
    const sw = await octx.request.get(`${BASE}/sw.js`);
    const swText = sw.ok() ? await sw.text() : '';
    const iconOk = await Promise.all((manJson.icons || []).map(async (ic) => (await octx.request.get(BASE + ic.src)).ok()));
    check('manifest · sw.js 200, 아이콘(192 · 512 · maskable) 받힘', man.status() === 200 && sw.status() === 200 && manJson.name === 'PDF 작업실' && manJson.display === 'standalone' &&
      (manJson.icons || []).some((i) => i.purpose === 'maskable') && iconOk.length >= 4 && iconOk.every(Boolean) && !/__PRECACHE__|'__COMMIT__'/.test(swText),
    `manifest ${man.status()} · sw.js ${sw.status()} · 아이콘 ${iconOk.filter(Boolean).length}/${iconOk.length}`);

    // 서비스 워커가 켜질 때까지(설치 때 앱 화면 · 라이브러리 · 글꼴을 모두 받아 둔다)
    await until(o, () => !!navigator.serviceWorker.controller, undefined, { timeout: 60000 });
    const cached = await o.evaluate(async () => {
      const names = await caches.keys();
      const c = await caches.open(names.find((n) => n.startsWith('pdfws-')));
      const keys = (await c.keys()).map((r) => new URL(r.url).pathname);
      return { names, n: keys.length, has: ['/', '/vendor/pdf.worker.min.js', '/vendor/heic/heic-to.js', '/vendor/pretendard/pretendardvariable.min.css'].every((k) => keys.includes(k)), version: keys.includes('/version') };
    });
    check('서비스 워커 등록 · 앱 셸 미리 캐시 (/version은 캐시 안 함)', cached.names.length === 1 && cached.n > 100 && cached.has && !cached.version,
      `캐시 ${cached.names.join(',')} · ${cached.n}개`);

    // 인터넷을 끊고 새로고침 → 편집 · 합치기 · 저장
    await octx.setOffline(true);
    await o.reload({ waitUntil: 'load' });
    await until(o, () => window.__pdfWorkshop && window.__pdfWorkshop.ready);
    await until(o, () => ![...document.querySelectorAll('.offline-badge')].every((b) => b.hidden), undefined, { timeout: 5000 }).catch(() => {});
    const off = await o.evaluate(() => ({
      badge: [...document.querySelectorAll('.offline-badge')].some((b) => !b.hidden && b.getBoundingClientRect().width > 0),
      text: (document.querySelector('.offline-badge:not([hidden])') || {}).textContent,
      ver: document.getElementById('home-version').textContent,
    }));
    await o.setInputFiles('#home-input', [fileA, fileB]);
    await until(o, () => document.querySelectorAll('#edit-grid .page-card canvas').length === 7, undefined, { timeout: 20000 });
    const [odl] = await Promise.all([o.waitForEvent('download'), o.click('#edit-save')]);
    const odoc = await PDFDocument.load(fs.readFileSync(await odl.path()));
    if (SCREENS) {
      await o.evaluate(() => document.fonts.ready);
      await o.mouse.move(5, 5);
      await o.waitForTimeout(600);
      await o.screenshot({ path: path.join(root, 'docs', 'screens', 'offline.png') });
    }
    await octx.setOffline(false);
    check('인터넷 없이(오프라인) 새로고침 → 편집 · 합치기 · 저장 + "지금 인터넷 없이 작동 중" 배지', off.badge && odoc.getPageCount() === 7 && /^v /.test(off.ver),
      `배지 "${off.text}" · ${odl.suggestedFilename()} ${odoc.getPageCount()}쪽 · 화면 ${off.ver}`);
    check('CSP 위반 · 콘솔 에러 0개 (오프라인 흐름 포함)', csp.length === 0 && oerr.filter((e) => !/net::ERR_INTERNET_DISCONNECTED|Failed to fetch|\/version/.test(e)).length === 0,
      csp.length ? csp.join(' | ').slice(0, 200) : oerr.length ? `오프라인 중 /version 실패만 ${oerr.length}건(정상)` : '0개');
    await octx.close();

    // 새 버전 배포 흉내: 같은 주소에서 커밋만 다른 서버로 바꿔 띄운다
    const UPORT = 4000 + Math.floor(Math.random() * 2000) + 2000;
    const startAs = (commit) => new Promise((resolve, reject) => {
      const s = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(UPORT), RAILWAY_GIT_COMMIT_SHA: commit }, stdio: 'pipe' });
      s.stdout.on('data', (d) => String(d).includes('http://') && resolve(s));
      s.on('error', reject);
      setTimeout(() => reject(new Error('서버가 뜨지 않음')), 10000);
    });
    const stopped = (s) => new Promise((r) => { s.once('exit', r); s.kill(); });
    let s1 = await startAs('aaaaaaa');
    const uctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const u = await uctx.newPage();
    await u.goto(`http://localhost:${UPORT}/`, { waitUntil: 'networkidle' });
    await until(u, () => !!navigator.serviceWorker.controller, undefined, { timeout: 60000 });
    await stopped(s1);
    s1 = await startAs('bbbbbbb');
    await u.setInputFiles('#home-input', [fileA]);
    await until(u, () => document.querySelectorAll('#edit-grid .page-card').length === 3);
    await u.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await until(u, () => !document.getElementById('update-bar').hidden, undefined, { timeout: 60000 });
    const bar1 = await u.textContent('#update-text');
    await u.click('#update-go');
    await u.waitForTimeout(500);
    const bar2 = await u.evaluate(() => ({ text: document.getElementById('update-text').textContent, cards: document.querySelectorAll('#edit-grid .page-card').length, ver: document.querySelector('meta[name="app-version"]').content }));
    await Promise.all([u.waitForEvent('load'), u.click('#update-go')]);
    await until(u, () => window.__pdfWorkshop && window.__pdfWorkshop.ready);
    const after = await u.evaluate(() => ({ ver: document.querySelector('meta[name="app-version"]').content, shown: document.getElementById('home-version').textContent }));
    check('새 버전 배포 → "새 버전이 있어요 [새로고침]" 띠, 작업 중이면 한 번 더 확인 후에만 새로고침',
      /새 버전이 있어요/.test(bar1) && /작업이 사라져요/.test(bar2.text) && bar2.cards === 3 && bar2.ver === 'aaaaaaa' && after.ver === 'bbbbbbb' && after.shown === 'v bbbbbbb',
      `"${bar1}" → 누르면 "${bar2.text.slice(0, 24)}…"(카드 ${bar2.cards}장 유지) → 한 번 더 → v ${after.ver}`);
    await uctx.close();
    await stopped(s1);
  }

  // ── 11-d. 안내 페이지 · 처음 화면 아래쪽 ──
  {
    const pctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const pg = await pctx.newPage();
    const perr = [];
    watch(pg, perr);
    const pages = [];
    for (const u of ['/check', '/privacy', '/licenses']) {
      const r = await pg.goto(BASE + u, { waitUntil: 'networkidle' });
      await pg.waitForTimeout(u === '/check' ? 1200 : 100);
      const info = await pg.evaluate(() => ({
        h1: document.querySelector('h1').textContent,
        ver: (document.querySelector('.site-foot .app-version') || {}).textContent,
        csp: document.querySelectorAll('.csp-list li').length,
        libs: [...document.querySelectorAll('.lib')].map((l) => l.dataset.lib),
        limit: /원본 파일을 바꾸지 않습니다/.test(document.body.textContent),
        updated: /마지막 갱신: \d{4}년/.test(document.body.textContent),
        playing: window.__pdfPages ? window.__pdfPages.playing() : [],
        sw: document.documentElement.scrollWidth,
      }));
      pages.push({ u, status: r.status(), ...info });
      if (SCREENS) {
        await pg.evaluate(() => document.fonts.ready);
        await pg.waitForTimeout(u === '/check' ? 2400 : 100);
        await pg.screenshot({ path: path.join(root, 'docs', 'screens', `${u.slice(1)}.png`), fullPage: true });
      }
    }
    const pk = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = [...Object.keys(pk.dependencies), ...Object.keys(pk.devDependencies || {})];
    const [pc, pp, pl] = pages;
    check('/check: 세 단계 + 움직이는 예시 2개 재생 + CSP 규칙 목록(서버 헤더와 같음)', pc.status === 200 && pc.playing.length === 2 && pc.playing.some(Boolean) && pc.csp === 11 && pc.limit,
      `${pc.h1} · 예시 재생 ${pc.playing.join('/')} · CSP ${pc.csp}줄`);
    check('/privacy: 수집 없음 · 마지막 갱신일 · 책임 한계 한 줄', pp.status === 200 && pp.updated && pp.limit, pp.h1);
    check('/licenses: package.json 의존성 모두(이름@버전)', pl.status === 200 && deps.every((d) => pl.libs.some((l) => l.startsWith(`${d}@`))) && pl.libs.length === deps.length,
      `${pl.libs.length}개: ${pl.libs.join(', ').slice(0, 160)}`);
    check('안내 페이지 3곳 콘솔 에러 0 · 가로 넘침 없음 · 푸터 버전', perr.length === 0 && pages.every((x) => x.sw <= 1280 && /^v /.test(x.ver || '')),
      perr.length ? perr.join(' | ').slice(0, 200) : pages.map((x) => `${x.u} ${x.ver}`).join(' · '));

    // 처음 화면 아래쪽: 요약 카드 · 자주 하는 작업 · 새 소식 · 푸터
    await pg.goto(BASE, { waitUntil: 'networkidle' });
    await until(pg, () => !document.getElementById('home-news').hidden);
    const home = await pg.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), l: Math.round(b.left) }; };
      return {
        trust: document.querySelectorAll('.trust-steps li').length,
        quick: document.querySelectorAll('.quick-card').length,
        news: document.querySelectorAll('#news-list > li').length,
        sec: r('.home-sec'),
        foot: [...document.querySelectorAll('.site-foot a')].map((a) => a.getAttribute('href')),
        limit: /원본 파일을 바꾸지 않습니다/.test(document.querySelector('.site-foot').textContent),
      };
    });
    check('처음 화면 아래: 믿을 이유 3단계 · 자주 하는 작업 3개 · 새 소식 3개 · 푸터(개인정보 · 라이브러리 · 책임 한계)',
      home.trust === 3 && home.quick === 3 && home.news === 3 && home.sec.w <= 1100 && home.foot.includes('/privacy') && home.foot.includes('/licenses') && home.foot.includes('/check') && home.limit,
      `카드 ${home.trust}/${home.quick}/${home.news} · 폭 ${home.sec.w}px · 푸터 ${home.foot.join(' ')}`);
    if (SCREENS) {
      await pg.evaluate(() => document.fonts.ready);
      await pg.screenshot({ path: path.join(root, 'docs', 'screens', 'home-full.png'), fullPage: true });
    }

    // "공문 첨부용 10MB 만들기" → 용량 줄이기 + 목표 10MB
    const heavy2 = await PDFDocument.create();
    for (let i = 0; i < 8; i++) {
      const img = await heavy2.embedJpg(photoJpeg(1200, 1000, i + 11));
      heavy2.addPage([595, 842]).drawImage(img, { x: 40, y: 250, width: 515, height: 430 });
    }
    const heavy2File = await writePdf('공문첨부.pdf', heavy2);
    await pg.click('.quick-card[data-quick="compress10"]');
    const qTab = await pg.evaluate(() => ({ tab: document.querySelector('.tab[aria-selected="true"]').dataset.tab, toast: document.getElementById('toasts').textContent }));
    await pg.setInputFiles('#cmp-input', [heavy2File]);
    await pg.waitForSelector('#cmp-target:not([hidden])', { timeout: 60000 });
    const qTarget = await pg.$eval('#cmp-mb', (e) => e.value);
    const hMB = fs.statSync(heavy2File).size / 1024 / 1024;
    // 로고 → 스캔본 · 사진 바로가기
    await pg.click('#logo');
    await pg.click('.quick-card[data-quick="scan"]');
    const qScan = await pg.evaluate(() => ({ tab: document.querySelector('.tab[aria-selected="true"]').dataset.tab, toast: document.getElementById('toasts').textContent }));
    await pg.click('#logo');
    await pg.click('.quick-card[data-quick="photos"]');
    const qPhoto = await pg.evaluate(() => document.querySelector('.tab[aria-selected="true"]').dataset.tab);
    check('자주 하는 작업: 10MB(용량 줄이기 · 목표 10) · 스캔본(편집 + 안내) · 사진(사진→PDF)',
      qTab.tab === 'compress' && /10MB/.test(qTab.toast) && Number(qTarget) === 10 && qScan.tab === 'edit' && /빈 쪽/.test(qScan.toast) && qPhoto === 'img2pdf' && perr.length === 0,
      `${hMB.toFixed(1)}MB 파일 → 목표 ${qTarget}MB · 스캔본 → ${qScan.tab} · 사진 → ${qPhoto}`);
    await pctx.close();

    // 400px에서도 가로 넘침 없음
    const mctx2 = await browser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true, colorScheme: 'light', deviceScaleFactor: 2 });
    const mp3 = await mctx2.newPage();
    const msw = [];
    for (const u of ['/', '/check', '/privacy', '/licenses']) {
      await mp3.goto(BASE + u, { waitUntil: 'networkidle' });
      msw.push(`${u} ${await mp3.evaluate(() => document.documentElement.scrollWidth)}`);
    }
    check('400px: 처음 화면 전체 · 안내 페이지 3곳 가로 스크롤 없음', msw.every((x) => Number(x.split(' ')[1]) <= 400), msw.join(' · '));
    await mctx2.close();
  }

  // ── 11-e. 새 소식 · 의견 보내기 · 오래된 브라우저 · 탭 제목 · 공유 미리보기 ──
  {
    const nctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
    const q = await nctx3.newPage();
    const qerr = [];
    watch(q, qerr);
    await q.goto(BASE, { waitUntil: 'networkidle' });
    await until(q, () => /^v /.test(document.getElementById('home-version').textContent));
    const first = await q.evaluate(() => window.__pdfWorkshop.news());
    // 예전에 써 본 사람 + 옛 새 소식만 본 상태 → 새로고침하면 점
    await q.evaluate(() => { localStorage.setItem('pdfws.tab', 'edit'); localStorage.setItem('pdfws.newsSeen', '2026-09-25-1'); });
    await q.reload({ waitUntil: 'networkidle' });
    await until(q, () => window.__pdfWorkshop.news().dot, undefined, { timeout: 5000 }).catch(() => {});
    const dotOn = await q.evaluate(() => ({ st: window.__pdfWorkshop.news(), label: document.getElementById('home-version').getAttribute('aria-label') }));
    await q.click('#home-version');
    await until(q, () => document.getElementById('news-dialog').open);
    const dlgInfo = await q.evaluate(() => ({ n: document.querySelectorAll('#news-full > li').length, ver: document.getElementById('news-ver').textContent, dot: window.__pdfWorkshop.news().dot }));
    await q.keyboard.press('Escape');
    await q.reload({ waitUntil: 'networkidle' });
    await q.waitForTimeout(500);
    const dotAfter = await q.evaluate(() => window.__pdfWorkshop.news().dot);
    check('버전 표시를 누르면 새 소식 창 · 새 버전이면 점(처음 온 사람은 없음) → 한 번 보면 꺼짐',
      !first.dot && dotOn.st.dot && /새 소식 있음/.test(dotOn.label) && dlgInfo.n >= 7 && /지금 버전: v /.test(dlgInfo.ver) && !dlgInfo.dot && !dotAfter,
      `처음 점 ${first.dot} · 옛 소식만 본 사람 점 ${dotOn.st.dot} → 창(${dlgInfo.n}개) 연 뒤 ${dotAfter}`);

    // 의견 보내기: 설문 주소가 비었으면 안내 + 오류 내용 복사
    await q.click('.site-foot [data-feedback]');
    await until(q, () => document.getElementById('feedback-dialog').open);
    const fbInfo = await q.evaluate(() => ({ none: !document.getElementById('fb-none').hidden, dis: document.getElementById('fb-open').getAttribute('aria-disabled'), href: document.getElementById('fb-open').getAttribute('href'), text: document.getElementById('feedback-dialog').textContent }));
    await q.click('#fb-open');
    const stillOpen = await q.evaluate(() => document.getElementById('feedback-dialog').open);
    await q.click('#fb-copy');
    await q.waitForTimeout(200);
    const clip = await q.evaluate(() => navigator.clipboard.readText());
    const copyMsg = await q.textContent('#fb-err');
    await q.keyboard.press('Escape');
    // 안내 페이지의 /#feedback
    await q.goto(`${BASE}/#feedback`, { waitUntil: 'networkidle' });
    const hashOpen = await q.evaluate(() => ({ open: document.getElementById('feedback-dialog').open, hash: location.hash }));
    await q.keyboard.press('Escape');
    const sideFb = await q.evaluate(() => !!document.querySelector('.sidebar [data-feedback]'));
    check('의견 보내기: "파일 · 화면 내용은 전송되지 않아요" · 설문 주소 없으면 안내 · [오류 내용 복사] · /#feedback · 사이드바에도',
      fbInfo.none && fbInfo.dis === 'true' && !fbInfo.href && /전송되지 않아요/.test(fbInfo.text) && stillOpen && /\[PDF 작업실 오류 보고\]/.test(clip) && /브라우저/.test(copyMsg) && hashOpen.open && hashOpen.hash === '' && sideFb,
      `설문 없음 안내 ${fbInfo.none} · 복사 ${clip.split('\n')[0]} · "${copyMsg.slice(0, 30)}…"`);

    // 탭 제목: 처음 → 편집 파일 2개 → 줄이는 중 %
    const tHome = await q.title();
    await q.setInputFiles('#home-input', [fileA, fileB]);
    await until(q, () => document.querySelectorAll('#edit-grid .page-card').length === 7);
    const tEdit = await q.title();
    // (진행 표시는 "사진 줄이는 중 3/8" 같은 글에서 %를 계산한다)
    const hv = await PDFDocument.create();
    for (let i = 0; i < 6; i++) hv.addPage([595, 842]).drawImage(await hv.embedJpg(photoJpeg(1400, 1100, i + 21)), { x: 20, y: 200, width: 555, height: 440 });
    const hvFile = await writePdf('제목확인.pdf', hv);
    await q.click('#tab-compress');
    await q.evaluate(() => {
      window.__titles = new Set();
      new MutationObserver(() => window.__titles.add(document.title)).observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true });
    });
    await q.setInputFiles('#cmp-input', [hvFile]);
    await q.waitForSelector('#cmp-target:not([hidden])', { timeout: 60000 });
    await q.fill('#cmp-mb', String(Math.max(1, Math.floor(fs.statSync(hvFile).size / 1024 / 1024 / 2))));
    await q.click('#cmp-go');
    await q.waitForSelector('#cmp-result:not([hidden])', { timeout: 120000 });
    const titles = await q.evaluate(() => [...window.__titles]);
    const tCmp = await q.title();
    check('탭 제목: "PDF 작업실" → "편집 중 · 파일 2개" → 진행 중 "…%"', tHome === 'PDF 작업실' && tEdit === '편집 중 · 파일 2개' && titles.some((t) => /\d+%$/.test(t)) && tCmp === '용량 줄이기 · 파일 1개',
      `${tHome} → ${tEdit} → ${titles.filter((t) => /%$/.test(t)).slice(0, 2).join(' / ')} → ${tCmp}`);

    // 작업 중 탭 닫기 · 새로고침 → 확인
    let asked = '';
    q.on('dialog', (d) => { if (d.type() === 'beforeunload') asked = d.type(); });
    await q.mouse.click(5, 5);
    await q.reload({ waitUntil: 'load' });
    await until(q, () => window.__pdfWorkshop && window.__pdfWorkshop.ready);
    let asked2 = 'none';
    q.removeAllListeners('dialog');
    q.on('dialog', (d) => { asked2 = d.type(); d.accept().catch(() => {}); });
    await q.reload({ waitUntil: 'load' }); // 파일이 없으면 묻지 않는다
    check('작업 중 새로고침 · 탭 닫기 → "작업 중인 내용이 사라져요" 확인 (파일 없으면 안 물음)', asked === 'beforeunload' && asked2 === 'none', `파일 있을 때 ${asked || '안 물음'} · 없을 때 ${asked2}`);
    check('새 소식 · 의견 · 제목 흐름 콘솔 에러 0개', qerr.length === 0, qerr.length ? qerr.join(' | ').slice(0, 200) : '0개');

    // 공유 미리보기 · 파비콘
    const html = await (await nctx3.request.get(BASE)).text();
    const og = (p) => ((html.match(new RegExp(`<meta property="${p}" content="([^"]+)"`)) || [])[1] || '');
    const ogImg = await nctx3.request.get(`${BASE}/icons/og-image.png`);
    const buf = await ogImg.body();
    const pngW = buf.readUInt32BE(16);
    const pngH = buf.readUInt32BE(20);
    const icons = await Promise.all(['/icons/logo.svg', '/icons/favicon-32.png', '/icons/apple-touch-icon.png'].map(async (u) => (await nctx3.request.get(BASE + u)).status()));
    check('공유 미리보기(Open Graph) 제목 · 설명 · 1200×630 그림(절대 주소) · 파비콘 SVG · PNG · apple-touch-icon',
      og('og:title') === 'PDF 작업실' && /파일은 컴퓨터 밖으로 안 나가요/.test(og('og:description')) && /^https:\/\/.+\/icons\/og-image\.png$/.test(og('og:image')) && pngW === 1200 && pngH === 630 && icons.every((c) => c === 200) && /summary_large_image/.test(html),
      `${og('og:image')} ${pngW}×${pngH} · 파비콘 ${icons.join('/')}`);
    await nctx3.close();

    // 오래된 브라우저(ES2020 없음) · 자바스크립트 꺼짐
    const octx2 = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    await octx2.addInitScript(() => { delete Promise.allSettled; });
    const ob = await octx2.newPage();
    await ob.goto(BASE, { waitUntil: 'load' });
    const old = await ob.evaluate(() => ({ note: document.getElementById('old-browser').getBoundingClientRect().height, text: document.getElementById('old-browser').textContent, home: document.getElementById('view-home').getBoundingClientRect().height }));
    await octx2.close();
    const jctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, javaScriptEnabled: false });
    const jp = await jctx.newPage();
    await jp.goto(BASE, { waitUntil: 'load' });
    const nojs = await jp.evaluate(() => document.body.innerText);
    await jctx.close();
    check('오래된 브라우저 · 자바스크립트 꺼짐: "이 브라우저에서는 열 수 없어요. 엣지, 크롬, 웨일로…" 안내만 보임',
      old.note > 50 && old.home === 0 && /엣지, 크롬, 웨일/.test(old.text) && /이 브라우저에서는 열 수 없어요/.test(nojs),
      `ES2020 없음 → 안내 ${Math.round(old.note)}px · 앱 ${old.home}px · JS 꺼짐 → 안내 글 ${/열 수 없어요/.test(nojs) ? '보임' : '없음'}`);
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

    // 도구별 사용법 패널 · 저장 위치 안내 · 1920px 빈 화면
    const gd = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', deviceScaleFactor: 1 });
    const gp = await gd.newPage();
    await gp.goto(`${BASE}/#edit`, { waitUntil: 'networkidle' });
    await gp.evaluate(() => document.fonts.ready);
    for (const [t, name] of [['img2pdf', 'guide-img2pdf'], ['pdf2img', 'guide-pdf2img'], ['decorate', 'guide-decorate'], ['compress', 'guide-compress'], ['security', 'guide-security']]) {
      await gp.click(`#tab-${t}`);
      await gp.mouse.move(5, 5);
      await gp.waitForTimeout(3400); // 예시가 결과 장면쯤 오도록
      await gp.screenshot({ path: path.join(out, `${name}.png`) });
    }
    await gp.evaluate(() => { const b = document.querySelector('#edit-guide .guide-body') || document.getElementById('edit-guide'); document.getElementById('guide-dl').scrollIntoView({ block: 'start' }); b.scrollTop = Math.max(0, b.scrollTop - 8); });
    await gp.waitForTimeout(3000);
    const gb = await gp.locator('#edit-guide').boundingBox();
    await gp.screenshot({ path: path.join(out, 'guide-download.png'), clip: { x: gb.x - 8, y: 0, width: gb.width + 16, height: 1000 } });
    await gp.setViewportSize({ width: 1920, height: 1080 });
    await gp.click('#tab-edit');
    await gp.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('#edit-guide, #edit-guide *').forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }); });
    await gp.mouse.move(5, 5);
    await gp.waitForTimeout(3000);
    await gp.screenshot({ path: path.join(out, 'wide-empty.png') });
    await gd.close();
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
for (const r of rows) console.log(`| ${padR(r.name, c1)} | ${r.skip ? '건너뜀' : r.ok ? '통과' : '실패'} | ${r.detail}`);
const failed = rows.filter((r) => !r.ok).length;
if (uiMeasures.length) console.log(`\n용량 줄이기 실측(브라우저)\n- ${uiMeasures.join('\n- ')}`);
const skipped = rows.filter((r) => r.skip).length;
console.log(`\n${rows.length}개 중 ${rows.length - failed - skipped}개 통과${skipped ? `, ${skipped}개 건너뜀` : ""}${failed ? `, ${failed}개 실패` : ""}`);
process.exit(failed ? 1 : 0);
