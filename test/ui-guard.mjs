// 관문이 조용히 비지 않게 하는 작은 판정들. ui-check.mjs와 verify.mjs가 함께 쓴다.
//   uiPreflight  화면 검사를 돌릴 수 있는지(playwright · 브라우저), SKIP_UI=1일 때만 건너뜀
//   uiVerdict    실제로 돌린 검사가 0개면 실패
//   manifestLinks  내보내는 HTML에 <link rel="manifest" 줄이 다시 생겼는지
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

export const NO_PW_MSG = 'test:ui 실패: playwright가 없어요 → npm ci 후 npx playwright install chromium';
export const NO_BROWSER_MSG = 'test:ui 실패: playwright용 Chromium이 없어요 → npx playwright install chromium';
export const ZERO_MSG = 'test:ui 실패: 실행한 화면 검사가 0개예요(관문이 비었어요)';
export const SKIP_BANNER = [
  '',
  '############################################################',
  '##   test:ui 건너뜀(SKIP_UI) — 화면 검사를 하나도 안 했어요   ##',
  '##   SKIP_UI=1 이 켜져 있어요. 관문 보고에 꼭 적어 주세요.     ##',
  '############################################################',
  '',
].join('\n');

/** 저장소에 설치된 playwright만 쓴다(밖에 따로 깐 것은 판이 달라질 수 있어 쓰지 않는다) */
export function loadPlaywright(root) {
  const req = createRequire(path.join(root, 'noop.js'));
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    try { return req(name); } catch { /* 다음 후보 */ }
  }
  return null;
}

/**
 * 돌릴 수 있는지 판정. { action: 'run' | 'skip' | 'fail', message, pw }
 * load · exists는 단위 검사에서 바꿔 끼우려고 받는다.
 */
export function uiPreflight({ env = process.env, root, load = loadPlaywright, exists = fs.existsSync } = {}) {
  if (env.SKIP_UI === '1') return { action: 'skip', message: SKIP_BANNER };
  const pw = load(root);
  if (!pw || !pw.chromium) return { action: 'fail', message: NO_PW_MSG };
  let exe = '';
  try { exe = pw.chromium.executablePath(); } catch { /* 아래에서 없음으로 */ }
  if (!exe || !exists(exe)) return { action: 'fail', message: NO_BROWSER_MSG };
  return { action: 'run', message: '', pw };
}

/** 검사 결과 → 종료 코드. 건너뛴 것만 있거나 0개면 실패 */
export function uiVerdict(rows) {
  const failed = rows.filter((r) => !r.ok).length;
  const ran = rows.filter((r) => !r.skip).length;
  if (ran === 0) return { code: 1, ran, failed, message: ZERO_MSG };
  return { code: failed ? 1 : 0, ran, failed, message: '' };
}

const MANIFEST_LINK = /<link\b[^>]*\brel\s*=\s*["']?manifest\b/i;
export const hasManifestLink = (html) => MANIFEST_LINK.test(html);

/** 폴더들 아래 .html 중 manifest 줄이 있는 파일 목록 */
export function manifestLinks(dirs) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(f); } else if (/\.html?$/i.test(e.name) && hasManifestLink(fs.readFileSync(f, 'utf8'))) hits.push(f);
    }
  };
  for (const d of dirs) if (fs.existsSync(d)) walk(d);
  return hits;
}
