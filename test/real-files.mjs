// 실제 PDF로 용량 줄이기를 재 본다(node + 브라우저). 파일은 저장소에 넣지 않고 경로로만 읽는다.
// 실행: node test/real-files.mjs "C:\경로\파일1.pdf" "C:\경로\파일2.pdf"
//       (또는 PDF_TEST_FILES="경로1;경로2")  · 브라우저 점검은 playwright가 있을 때만(PLAYWRIGHT_DIR)
// 결과에는 파일 이름 대신 "파일 1", "파일 2"만 적는다.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDFLib = require('@cantoo/pdf-lib');
const Compress = require('../public/compress.js')(PDFLib, require('pako'));
const { nodeCodec } = await import('./node-codec.mjs');

const files = (process.argv.slice(2).length ? process.argv.slice(2) : String(process.env.PDF_TEST_FILES || '').split(';')).filter(Boolean);
if (!files.length) {
  console.log('실제 파일 경로가 없어 건너뜀 (인자나 PDF_TEST_FILES로 알려 주세요)');
  process.exit(0);
}
const MB = 1024 * 1024;
const mb = (n) => `${(n / MB).toFixed(2)}MB`;
const lines = [];
let failed = 0;

// 목표: 원래와 최소 사이 가운데(10MB 넘는 파일은 10MB)
const pickTarget = (orig, min) => (orig > 10 * MB && min < 10 * MB ? 10 * MB : Math.round(min + (orig - min) * 0.5));

// ── node ──
const targets = [];
for (let i = 0; i < files.length; i++) {
  const bytes = new Uint8Array(fs.readFileSync(files[i]));
  const label = `파일 ${i + 1}`;
  let peak = 0;
  const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 100);
  const t0 = Date.now();
  try {
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const pages = doc.getPageCount();
    const a = await Compress.analyzePdf(bytes, nodeCodec);
    const target = pickTarget(bytes.length, a.min);
    targets.push(target);
    const r = await Compress.compressPdf(bytes, target, nodeCodec);
    const back = await PDFLib.PDFDocument.load(r.bytes);
    clearInterval(iv);
    peak = Math.max(peak, process.memoryUsage().rss);
    const ok = back.getPageCount() === pages && (r.status === 'done' || r.status === 'raster');
    if (!ok) failed++;
    lines.push(`[node] ${label} ${pages}쪽 ${mb(bytes.length)} → 목표 ${mb(target)} → ${mb(r.size)} (${r.status}, ${r.stage}단계, 화질 ${r.quality}) · ${((Date.now() - t0) / 1000).toFixed(1)}초 · 최대 메모리 ${(peak / MB).toFixed(0)}MB · 줄일 수 있는 최소 ${mb(a.min)} · 건너뛴 사진 ${r.skipped}장 ${JSON.stringify(r.reasons)}`);
  } catch (e) {
    clearInterval(iv);
    failed++;
    targets.push(0);
    lines.push(`[node] ${label} 실패: ${e && e.name}: ${e && e.message}\n${String(e && e.stack).split('\n').slice(0, 5).join('\n')}`);
  }
}

// ── 브라우저 ──
function loadPlaywright() {
  for (const base of [process.env.PLAYWRIGHT_DIR, root].filter(Boolean)) {
    const req = createRequire(path.join(path.resolve(base), 'noop.js'));
    for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
      try { return req(name); } catch { /* 다음 */ }
    }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) {
  lines.push('[브라우저] playwright가 없어 건너뜀');
} else {
  const PORT = 4700 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  await new Promise((resolve) => server.stdout.on('data', (d) => String(d).includes('http://') && resolve()));
  const browser = await pw.chromium.launch();
  try {
    for (const mode of ['worker', 'main']) {
      for (let i = 0; i < files.length; i++) {
        if (!targets[i]) continue;
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const p = await ctx.newPage();
        const errs = [];
        p.on('pageerror', (e) => errs.push(String(e)));
        p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
        const cdp = await ctx.newCDPSession(p);
        await cdp.send('Performance.enable');
        let peak = 0;
        const iv = setInterval(async () => {
          try {
            const m = await cdp.send('Performance.getMetrics');
            peak = Math.max(peak, m.metrics.find((x) => x.name === 'JSHeapUsedSize').value);
          } catch { /* 닫힘 */ }
        }, 200);
        const until = async (fn, ms) => {
          const end = Date.now() + ms;
          for (;;) {
            if (await p.evaluate(fn).catch(() => false)) return true;
            if (Date.now() > end) return false;
            await new Promise((r) => setTimeout(r, 150));
          }
        };
        await p.goto(`http://localhost:${PORT}/${mode === 'main' ? '?worker=0' : ''}#compress`);
        const t0 = Date.now();
        await p.setInputFiles('#cmp-input', [files[i]]);
        const ready = await until(() => !document.getElementById('cmp-target').hidden || document.querySelector('.toast.error'), 300000);
        const tA = Date.now() - t0;
        await p.fill('#cmp-mb', (targets[i] / MB).toFixed(2));
        const t1 = Date.now();
        await p.click('#cmp-go');
        await until(() => !document.getElementById('busy').hidden, 3000);
        const done = await until(() => document.getElementById('busy').hidden, 600000);
        const st = await p.evaluate(() => ({
          summary: document.getElementById('cmp-summary').innerText.replace(/\s+/g, ' '),
          toasts: [...document.querySelectorAll('.toast.error')].map((t) => t.innerText.replace(/\s+/g, ' ')),
          res: window.__pdfWorkshop.compress(),
        }));
        clearInterval(iv);
        const f = st.res.files[0] || {};
        const ok = ready && done && f.result && !st.toasts.length && !errs.length;
        if (!ok) failed++;
        lines.push(`[브라우저 ${mode === 'main' ? '메인 스레드' : 'Worker'}] 파일 ${i + 1} → ${f.result ? mb(f.result) : '결과 없음'} · 분석 ${(tA / 1000).toFixed(1)}초 + 줄이기 ${((Date.now() - t1) / 1000).toFixed(1)}초 · 최대 JS 힙(화면 쪽) ${(peak / MB).toFixed(0)}MB · ${st.summary}${st.toasts.length ? ` · 오류 ${st.toasts.join(' | ')}` : ''}${errs.length ? ` · 콘솔 ${errs.join(' | ').slice(0, 200)}` : ''}`);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

console.log(lines.join('\n'));
console.log(failed ? `\n${failed}건 실패` : '\n모두 끝까지 처리됨');
process.exit(failed ? 1 : 0);
