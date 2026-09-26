// package.json의 실제 의존성(node_modules에 설치된 것)에서 이름 · 버전 · 라이선스 · 원문을 읽어
// "사용한 라이브러리" 페이지(public/pages/licenses.html)를 만든다.
//   node scripts/gen-licenses.mjs          만들기 (npm run build 에서 자동)
//   node scripts/gen-licenses.mjs --check  만든 페이지가 package.json과 맞는지만 확인 (verify에서)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'public', 'pages', 'licenses.html');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// 어디에 쓰는지 (사용자 말로)
const USE = {
  '@cantoo/pdf-lib': 'PDF 합치기 · 자르기 · 돌리기 · 암호 걸기와 풀기',
  '@cantoo/fontkit': '한글 워터마크 · 쪽번호 글꼴 넣기',
  'pdfjs-dist': '쪽 미리보기(썸네일) · PDF를 사진으로',
  jszip: '여러 파일을 zip 하나로 묶기',
  pako: 'PDF 안의 압축 풀기 · 다시 압축',
  'jpeg-js': '특수한 JPEG(CMYK 등)을 줄일 때 풀어 읽기',
  'heic-to': '아이폰 사진(HEIC)을 JPEG로 바꾸기 (필요할 때만 불러옴)',
  pretendard: '화면 글꼴 · 한글 워터마크 글꼴',
  express: '이 사이트의 파일을 보내 주는 서버 (브라우저에는 포함되지 않음)',
  'axe-core': '자동 접근성 검사 (개발용, 사이트에 포함되지 않음)',
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function repoUrl(p) {
  let r = p.repository;
  if (r && typeof r === 'object') r = r.url;
  if (!r) return p.homepage || '';
  r = String(r).replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) r = `https://github.com/${r}`;
  return r;
}
function licenseFile(dir) {
  const pick = (d) => {
    try {
      return fs.readdirSync(d).find((f) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f));
    } catch { return null; }
  };
  for (const d of [dir, path.join(dir, 'dist')]) {
    const f = pick(d);
    if (f) return path.join(d, f);
  }
  return null;
}
function read(name, dev) {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const lf = licenseFile(dir);
  return {
    name,
    version: p.version,
    license: typeof p.license === 'string' ? p.license : (p.license && p.license.type) || '표기 없음',
    url: repoUrl(p),
    text: lf ? fs.readFileSync(lf, 'utf8').trim() : '',
    use: USE[name] || '',
    dev,
  };
}

let list;
try {
  list = [
    ...Object.keys(pkg.dependencies || {}).map((n) => read(n, false)),
    ...Object.keys(pkg.devDependencies || {}).map((n) => read(n, true)),
  ];
} catch (e) {
  // 배포 서버처럼 개발용 패키지가 설치되지 않은 곳에서는 저장소에 있는 페이지를 그대로 쓴다(빌드를 막지 않는다)
  console.warn(`사용한 라이브러리 페이지를 새로 만들지 않고 그대로 둡니다: ${e.message}`);
  process.exit(0);
}

if (process.argv.includes('--check')) {
  const html = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const missing = list.filter((l) => !html.includes(`data-lib="${esc(l.name)}@${esc(l.version)}"`)).map((l) => `${l.name}@${l.version}`);
  if (missing.length) {
    console.error(`사용한 라이브러리 페이지가 package.json과 달라요: ${missing.join(', ')} → node scripts/gen-licenses.mjs`);
    process.exit(1);
  }
  console.log(`사용한 라이브러리 페이지 OK (${list.length}개)`);
  process.exit(0);
}

const item = (l) => `      <li class="lib" data-lib="${esc(l.name)}@${esc(l.version)}">
        <div class="lib-head">
          <strong>${esc(l.name)}</strong> <span class="lib-ver">${esc(l.version)}</span>
          <span class="lib-license">${esc(l.license)}</span>
        </div>
        ${l.use ? `<p class="lib-use">${esc(l.use)}</p>` : ''}
        <p class="lib-links">${l.url ? `<a href="${esc(l.url)}" rel="noopener noreferrer" target="_blank">저장소</a>` : ''}${l.url && /github\.com/.test(l.url) ? ` · <a href="${esc(l.url)}/blob/HEAD/${esc(path.basename(licenseFile(path.join(root, 'node_modules', ...l.name.split('/'))) || 'LICENSE'))}" rel="noopener noreferrer" target="_blank">라이선스 원문(저장소)</a>` : ''}</p>
        ${l.text ? `<details><summary>라이선스 전문 보기</summary><pre>${esc(l.text)}</pre></details>` : ''}
      </li>`;

const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>사용한 라이브러리 · PDF 작업실</title>
  <meta name="description" content="PDF 작업실이 사용하는 오픈소스 라이브러리와 라이선스.">
  <meta name="app-version" content="">
  <meta name="theme-color" content="#141B2E">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icons/logo.svg" type="image/svg+xml">
  <link rel="icon" href="/icons/favicon-32.png" sizes="32x32" type="image/png">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <link rel="stylesheet" href="/vendor/pretendard/pretendardvariable.min.css">
  <link rel="stylesheet" href="style.css">
</head>
<body class="doc-body">
  <!-- 이 파일은 scripts/gen-licenses.mjs가 package.json과 node_modules에서 자동으로 만듭니다. 직접 고치지 마세요. -->
  <header class="doc-head">
    <div class="doc-bar">
      <a href="/" class="logo"><span class="logo-mark" aria-hidden="true"></span>PDF 작업실</a>
      <a class="btn dark sm" href="/">← 작업실로 돌아가기</a>
    </div>
    <div class="doc-hero">
      <h1>사용한 라이브러리</h1>
      <p>PDF 작업실은 아래 오픈소스 덕분에 만들 수 있었어요. 버전은 모두 고정해서 씁니다.</p>
    </div>
  </header>

  <main class="doc">
    <section class="doc-card" aria-labelledby="l1">
      <h2 id="l1">사이트에 쓰는 것 (${list.filter((l) => !l.dev).length}개)</h2>
      <ul class="lib-list">
${list.filter((l) => !l.dev).map(item).join('\n')}
      </ul>
    </section>
    <section class="doc-card" aria-labelledby="l2">
      <h2 id="l2">개발할 때만 쓰는 것 (${list.filter((l) => l.dev).length}개)</h2>
      <ul class="lib-list">
${list.filter((l) => l.dev).map(item).join('\n')}
      </ul>
    </section>
    <p class="doc-note">heic-to(LGPL-3.0)는 수정하지 않은 원본을 그대로 제공하며, 원본과 라이선스는 <a href="/vendor/heic/LICENSE">/vendor/heic/LICENSE</a>와 저장소에서 받을 수 있어요. pdf.js는 Apache-2.0, Pretendard 글꼴은 SIL Open Font License 1.1을 따릅니다.</p>
  </main>

  <footer class="site-foot">
    <div class="site-foot-in">
      <p class="site-foot-links">
        <span class="app-version" aria-label="배포 버전"></span>
        <a href="/check">직접 확인하는 법</a>
        <a href="/privacy">개인정보 안내</a>
        <a href="/licenses" aria-current="page">사용한 라이브러리</a>
        <a href="/#feedback">의견 보내기</a>
      </p>
      <p class="site-foot-limit">이 도구는 원본 파일을 바꾸지 않습니다. 결과물은 저장 후 열어서 확인해 주세요.</p>
    </div>
  </footer>
  <script src="pages.js"></script>
</body>
</html>
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`사용한 라이브러리 페이지: ${path.relative(root, OUT)} (${list.length}개)`);
