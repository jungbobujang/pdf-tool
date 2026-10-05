// 도장 만들기 글꼴을 Fontsource(npm, SIL OFL 1.1)에서 받아 저장소에 넣는다.
//   node scripts/vendor-stamp-fonts.mjs           받아서 public/vendor/stamp-fonts/ + public/stamp/fonts.json 만들기
//   node scripts/vendor-stamp-fonts.mjs --check   들어 있는 파일이 목록과 맞는지만 확인 (verify에서)
//
// 글꼴은 쓰는 굵기 하나만, woff2만 넣는다. 글꼴마다 글자 조각(약 90~120개)으로 나뉘어 있어
// 브라우저는 실제로 쓰는 글자가 든 조각만 받는다. 바깥 CDN(구글 글꼴)은 쓰지 않는다.
// 글꼴 패키지는 package.json에 넣지 않는다(배포 · 검사 때마다 270MB를 받지 않게): 이 스크립트가 임시 폴더에 받는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(root, 'public', 'vendor', 'stamp-fonts');
const OUT_JSON = path.join(root, 'public', 'stamp', 'fonts.json');

// id는 public/stamp/stamp-core.js의 FONTS와 같다
export const FONT_PACKAGES = [
  { id: 'serif', pkg: 'noto-serif-kr', version: '5.3.0', weight: 900, family: 'Noto Serif KR' },
  { id: 'nanum', pkg: 'nanum-myeongjo', version: '5.3.0', weight: 800, family: 'Nanum Myeongjo' },
  { id: 'gothic', pkg: 'noto-sans-kr', version: '5.3.0', weight: 900, family: 'Noto Sans KR' },
  { id: 'gowun', pkg: 'gowun-batang', version: '5.3.0', weight: 700, family: 'Gowun Batang' },
  { id: 'hahm', pkg: 'hahmlet', version: '5.3.0', weight: 900, family: 'Hahmlet' },
  { id: 'song', pkg: 'song-myung', version: '5.3.1', weight: 400, family: 'Song Myung' },
  { id: 'yeon', pkg: 'yeon-sung', version: '5.3.0', weight: 400, family: 'Yeon Sung' },
  { id: 'brush', pkg: 'nanum-brush-script', version: '5.3.0', weight: 400, family: 'Nanum Brush Script' },
  { id: 'kai', pkg: 'lxgw-wenkai-tc', version: '5.3.0', weight: 700, family: 'LXGW WenKai TC' },
  { id: 'black', pkg: 'black-han-sans', version: '5.3.0', weight: 400, family: 'Black Han Sans' },
  { id: 'gasoek', pkg: 'gasoek-one', version: '5.3.0', weight: 400, family: 'Gasoek One' },
  { id: 'dohyeon', pkg: 'do-hyeon', version: '5.3.0', weight: 400, family: 'Do Hyeon' },
  { id: 'gugi', pkg: 'gugi', version: '5.3.0', weight: 400, family: 'Gugi' },
  { id: 'dokdo', pkg: 'east-sea-dokdo', version: '5.3.0', weight: 400, family: 'East Sea Dokdo' },
  { id: 'bagel', pkg: 'bagel-fat-one', version: '5.3.0', weight: 400, family: 'Bagel Fat One' },
  { id: 'diph', pkg: 'diphylleia', version: '5.3.0', weight: 400, family: 'Diphylleia' },
  { id: 'grand', pkg: 'grandiflora-one', version: '5.3.0', weight: 400, family: 'Grandiflora One' },
  { id: 'moirai', pkg: 'moirai-one', version: '5.3.0', weight: 400, family: 'Moirai One' },
];

/** 조각 이름 → 파일 이름 (stamp-core.js의 fontFiles와 같은 규칙) */
export const fileName = (f, slice) => `${f.pkg}-${slice}-${f.weight}-normal.woff2`;

/** Fontsource의 <굵기>.css에서 [woff2 파일, unicode-range] 목록 */
export function facesOf(css) {
  const out = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const file = /url\(\.\/files\/([\w.-]+\.woff2)\)/.exec(body);
    if (!file) continue;
    const range = /unicode-range:\s*([^;]+);/.exec(body);
    out.push({ file: file[1], range: range ? range[1].trim() : '' });
  }
  return out;
}

function check() {
  const problems = [];
  let data = null;
  try { data = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')); } catch { problems.push('public/stamp/fonts.json이 없어요'); }
  if (data) {
    for (const f of FONT_PACKAGES) {
      const d = data.fonts && data.fonts[f.id];
      if (!d || d.pkg !== `@fontsource/${f.pkg}` || d.version !== f.version || d.weight !== f.weight) { problems.push(`${f.id}: 목록과 다름`); continue; }
      const missing = d.files.filter(([slice]) => !fs.existsSync(path.join(OUT_DIR, f.pkg, fileName(f, slice))));
      if (missing.length) problems.push(`${f.id}: 파일 ${missing.length}개 없음`);
      if (!fs.existsSync(path.join(OUT_DIR, f.pkg, 'LICENSE.txt'))) problems.push(`${f.id}: 라이선스 없음`);
      if (d.files.some(([, r]) => !(r >= -1 && r < data.ranges.length))) problems.push(`${f.id}: 글자 범위 번호가 틀림`);
    }
  }
  if (problems.length) {
    console.error(`도장 글꼴이 목록과 달라요: ${problems.join(' · ')} → node scripts/vendor-stamp-fonts.mjs`);
    process.exit(1);
  }
  console.log(`도장 글꼴 OK (${FONT_PACKAGES.length}개)`);
}

function vendor() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-fonts-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"stamp-fonts-tmp","private":true}');
  const specs = FONT_PACKAGES.map((f) => `@fontsource/${f.pkg}@${f.version}`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', ...specs], { cwd: tmp, stdio: 'inherit', shell: false });
  if (r.status !== 0) { console.error('글꼴 패키지를 받지 못했어요.'); process.exit(1); }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const ranges = [];
  const rangeIdx = new Map();
  const fonts = {};
  let bytes = 0;
  let count = 0;
  for (const f of FONT_PACKAGES) {
    const dir = path.join(tmp, 'node_modules', '@fontsource', f.pkg);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (meta.version !== f.version) throw new Error(`${f.pkg} 버전이 ${meta.version}`);
    const faces = facesOf(fs.readFileSync(path.join(dir, `${f.weight}.css`), 'utf8'));
    const out = path.join(OUT_DIR, f.pkg);
    fs.mkdirSync(out, { recursive: true });
    const files = [];
    for (const face of faces) {
      fs.copyFileSync(path.join(dir, 'files', face.file), path.join(out, face.file));
      bytes += fs.statSync(path.join(out, face.file)).size;
      count++;
      // 저장 크기를 줄이려고 범위는 "U+" 없이, 파일은 조각 이름만 적는다(stamp-core.js가 되돌림)
      const range = face.range.replace(/U\+/gi, '').toLowerCase();
      let k = -1;
      if (range) {
        if (!rangeIdx.has(range)) { rangeIdx.set(range, ranges.length); ranges.push(range); }
        k = rangeIdx.get(range);
      }
      const slice = new RegExp(`^${f.pkg}-([\\w-]+?)-${f.weight}-normal\\.woff2$`).exec(face.file);
      if (!slice) throw new Error(`${face.file}: 이름 규칙이 달라요`);
      files.push([slice[1], k]);
    }
    fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(out, 'LICENSE.txt'));
    fonts[f.id] = { pkg: `@fontsource/${f.pkg}`, version: f.version, weight: f.weight, family: f.family, license: meta.license || 'OFL-1.1', dir: f.pkg, files };
  }
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify({ note: 'scripts/vendor-stamp-fonts.mjs가 만듭니다. 직접 고치지 마세요.', ranges, fonts })}\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`도장 글꼴 ${FONT_PACKAGES.length}개 · 조각 ${count}개 · ${(bytes / 1e6).toFixed(1)}MB → public/vendor/stamp-fonts/`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) check();
  else vendor();
}
