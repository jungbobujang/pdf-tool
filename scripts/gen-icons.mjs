// 로고 마크(SVG)로 앱 아이콘 PNG와 공유 미리보기 그림을 만든다. 만든 파일은 저장소에 넣어 두므로
// 로고를 바꿀 때만 다시 돌리면 된다: PLAYWRIGHT_DIR=<playwright 폴더> node scripts/gen-icons.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'icons');
fs.mkdirSync(out, { recursive: true });

const bases = [process.env.PLAYWRIGHT_DIR, root].filter(Boolean);
let pw = null;
for (const b of bases) {
  try { pw = createRequire(path.join(path.resolve(b), 'noop.js'))('playwright'); break; } catch { /* 다음 후보 */ }
}
if (!pw) {
  console.log('playwright가 없어 아이콘을 만들지 못했어요.');
  process.exit(1);
}

/** 로고 마크: 파란 네모 위에 겹친 종이 두 장 (style.css의 .logo-mark와 같은 모양) */
const mark = (bg = true) => `
  ${bg ? '<rect width="34" height="34" rx="9" fill="#3355FF"/>' : ''}
  <rect x="12" y="6" width="13" height="17" rx="2.5" fill="#fff" fill-opacity=".5"/>
  <rect x="8" y="10" width="13" height="17" rx="2.5" fill="#fff"/>`;
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34">${mark()}</svg>\n`;
fs.writeFileSync(path.join(out, 'logo.svg'), logoSvg);
// maskable: 가장자리가 잘려도 되도록 꽉 찬 배경 + 가운데 60% 안에 마크
const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><rect width="34" height="34" fill="#3355FF"/><g transform="translate(6.8 6.8) scale(.6)">${mark(false)}</g></svg>`;
// 아이폰 홈 화면: 둥근 모서리는 기기가 깎으므로 꽉 찬 네모
const appleSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><rect width="34" height="34" fill="#3355FF"/><g transform="translate(3.4 3.4) scale(.8)">${mark(false)}</g></svg>`;

const og = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="file:///${path.join(root, 'node_modules', 'pretendard', 'dist', 'web', 'variable', 'pretendardvariable.css').replace(/\\/g, '/')}">
<style>
  html, body { margin: 0; }
  body { width: 1200px; height: 630px; background: #141B2E; color: #fff; font-family: "Pretendard Variable", sans-serif; display: flex; flex-direction: column; justify-content: center; padding: 0 96px; box-sizing: border-box; position: relative; overflow: hidden; }
  .brand { display: flex; align-items: center; gap: 28px; }
  .brand svg { width: 120px; height: 120px; }
  h1 { font-size: 96px; font-weight: 800; margin: 0; letter-spacing: -2px; }
  p { font-size: 40px; font-weight: 600; margin: 44px 0 0; color: #D6DDF0; line-height: 1.4; }
  .safe { margin-top: 36px; display: inline-flex; align-items: center; gap: 14px; font-size: 32px; font-weight: 700; color: #7FE0B8; }
  .safe i { width: 18px; height: 18px; border-radius: 50%; background: #18A36F; box-shadow: 0 0 0 8px rgba(24, 163, 111, .25); }
  .deco { position: absolute; right: -60px; bottom: -80px; width: 460px; opacity: .12; }
</style>
<div class="brand">${logoSvg}<h1>PDF 작업실</h1></div>
<p>PDF 합치기 · 나누기 · 암호 · 용량 줄이기</p>
<div class="safe"><i></i>파일은 컴퓨터 밖으로 안 나가요</div>
<svg class="deco" viewBox="0 0 34 34">${mark(false)}</svg>`;

const browser = await pw.chromium.launch();
const page = await browser.newPage();
async function png(svg, size, name) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: path.join(out, name), omitBackground: true });
}
await png(logoSvg, 192, 'icon-192.png');
await png(logoSvg, 512, 'icon-512.png');
await png(maskSvg, 512, 'maskable-512.png');
await png(maskSvg, 192, 'maskable-192.png');
await png(appleSvg, 180, 'apple-touch-icon.png');
await png(logoSvg, 32, 'favicon-32.png');
await page.setViewportSize({ width: 1200, height: 630 });
await page.goto('about:blank');
// 공유 그림용 임시 HTML은 저장소 밖(임시 폴더)에 둔다
const ogHtml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdftool-og-')), 'og.html');
fs.writeFileSync(ogHtml, og);
await page.goto('file:///' + ogHtml.replace(/\\/g, '/'));
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(out, 'og-image.png') });
await browser.close();
console.log(`아이콘: ${out}`);
