// 도장 만들기 [한자 더 보기] 자료를 libhangul(BSD-3) 한자 사전에서 만든다.
//   node scripts/build-stamp-hanja.mjs            libhangul을 임시 폴더에 받아(git, 판 고정) public/stamp/hanja.json 만들기
//   node scripts/build-stamp-hanja.mjs --from=폴더  이미 받아 둔 libhangul/data/hanja 폴더로 만들기
//   node scripts/build-stamp-hanja.mjs --check    들어 있는 자료 모양만 확인 (verify에서)
//
// 담는 것: 한글 한 음절 → [한자, 짧은 뜻] 목록. KS X 1001 한자(학교 컴퓨터 · 글꼴이 대개 가진 4,888자)만,
// 음절마다 많이 쓰는 순(libhangul freq-hanja.txt). 뜻은 첫 번째 뜻만. 이 화면 안에서만 쓰고 서버로 보내지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'public', 'stamp', 'hanja.json');
const LICENSE_OUT = path.join(root, 'public', 'stamp', 'hanja-LICENSE.txt');
export const LIBHANGUL = { url: 'https://github.com/libhangul/libhangul', commit: '5094421d9586294b2aad09924b9a54e2e6060f06' };

/** KS X 1001 한자인지: EUC-KR로 쓸 수 있는 한자 */
const ksDecoder = new TextDecoder('euc-kr');
const KS = (() => {
  const set = new Set();
  // KS X 1001 한자 영역: 첫 바이트 0xCA~0xFD, 둘째 0xA1~0xFE
  for (let a = 0xca; a <= 0xfd; a++) {
    for (let b = 0xa1; b <= 0xfe; b++) set.add(ksDecoder.decode(new Uint8Array([a, b])));
  }
  return set;
})();

export function build(dir) {
  const rows = fs.readFileSync(path.join(dir, 'hanja.txt'), 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(':'))
    .filter((r) => r.length >= 2 && [...r[0]].length === 1 && [...r[1]].length === 1 && /[가-힣]/.test(r[0]));
  const freq = new Map();
  for (const l of fs.readFileSync(path.join(dir, 'freq-hanja.txt'), 'utf8').split('\n')) {
    if (!l || l.startsWith('#')) continue;
    const [c, n] = l.split(':');
    if (c && Number.isFinite(Number(n))) freq.set(c, Number(n));
  }
  const by = {};
  for (const [s, c, m = ''] of rows) {
    if (!KS.has(c)) continue;
    const list = (by[s] = by[s] || []);
    if (list.some((x) => x[0] === c)) continue;
    list.push([c, m.split(',')[0].trim(), freq.get(c) || 0]);
  }
  const out = {};
  for (const s of Object.keys(by).sort()) out[s] = by[s].sort((a, b) => b[2] - a[2]).map(([c, m]) => [c, m]);
  return out;
}

function license(dir) {
  const head = fs.readFileSync(path.join(dir, 'hanja.txt'), 'utf8').split('\n').filter((l) => l.startsWith('#')).map((l) => l.replace(/^# ?/, ''));
  return `도장 만들기 [한자 더 보기] 자료는 libhangul의 한자 사전(data/hanja/hanja.txt · freq-hanja.txt)에서 만들었습니다.\n${LIBHANGUL.url} (${LIBHANGUL.commit.slice(0, 7)})\n\n${head.join('\n').trim()}\n`;
}

function check() {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 아래에서 */ }
  const ok = data && data.syllables && Array.isArray(data.syllables['하']) && data.syllables['하'].some(([c]) => c === '河') &&
    Object.values(data.syllables).every((list) => list.every((x) => Array.isArray(x) && [...x[0]].length === 1 && typeof x[1] === 'string')) &&
    fs.existsSync(LICENSE_OUT) && /Choe Hwanjin/.test(fs.readFileSync(LICENSE_OUT, 'utf8'));
  if (!ok) { console.error('도장 한자 자료가 없거나 모양이 달라요 → node scripts/build-stamp-hanja.mjs'); process.exit(1); }
  console.log(`도장 한자 자료 OK (음절 ${Object.keys(data.syllables).length}개 · 한자 ${Object.values(data.syllables).reduce((n, l) => n + l.length, 0)}개)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) check();
  else {
    const from = (process.argv.find((a) => a.startsWith('--from=')) || '').slice(7);
    let dir = from;
    let tmp = null;
    if (!dir) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libhangul-'));
      const clone = spawnSync('git', ['clone', '-q', LIBHANGUL.url, tmp], { stdio: 'inherit', shell: false });
      const pin = clone.status === 0 ? spawnSync('git', ['-C', tmp, 'checkout', '-q', LIBHANGUL.commit], { stdio: 'inherit', shell: false }) : clone;
      if (pin.status !== 0) { console.error('libhangul을 받지 못했어요.'); process.exit(1); }
      dir = path.join(tmp, 'data', 'hanja');
    }
    const syllables = build(dir);
    fs.writeFileSync(OUT, `${JSON.stringify({ note: 'scripts/build-stamp-hanja.mjs가 libhangul(BSD-3)에서 만듭니다. 직접 고치지 마세요.', source: `${LIBHANGUL.url}@${LIBHANGUL.commit.slice(0, 7)}`, syllables })}\n`);
    fs.writeFileSync(LICENSE_OUT, license(dir));
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`도장 한자 자료: 음절 ${Object.keys(syllables).length}개 · 한자 ${Object.values(syllables).reduce((n, l) => n + l.length, 0)}개 → public/stamp/hanja.json`);
  }
}
