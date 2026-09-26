'use strict';

// 정적 파일만 제공하는 서버. 업로드를 받는 경로는 없다.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const nm = (...p) => path.join(__dirname, 'node_modules', ...p);
const PUBLIC = path.join(__dirname, 'public');

// 지금 돌고 있는 코드의 커밋을 찾는다.
// 1) GitHub 연동 배포: Railway가 넣어 주는 RAILWAY_GIT_COMMIT_SHA
// 2) `npm run deploy`(railway up) 배포: 배포 직전에 만든 build-info.json
// 3) 로컬 실행: git rev-parse
function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
  } catch {
    return null;
  }
}
function currentVersion() {
  const startedAt = new Date().toISOString();
  const env = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (env) return { commit: env.slice(0, 7), builtAt: startedAt, source: 'railway-git' };
  const info = readBuildInfo();
  if (info && info.commit) return { commit: String(info.commit).slice(0, 7), builtAt: info.builtAt || startedAt, source: 'build-info' };
  try {
    const commit = execSync('git rev-parse --short=7 HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return { commit, builtAt: startedAt, source: 'git' };
  } catch {
    return { commit: 'dev', builtAt: startedAt, source: 'none' };
  }
}
const VERSION = currentVersion();
const COMMIT = VERSION.commit;

// index.html의 app.js · style.css · pdf-core.js 주소에 ?v=커밋 을 붙인다.
// 커밋이 바뀌면 주소가 바뀌므로 브라우저나 중간 캐시에 옛 파일이 남지 않는다.
const ASSETS = ['style.css', 'pdf-core.js', 'compress.js', 'guide-anim.js', 'app.js'];
// 안내 페이지(/check · /privacy · /licenses)가 쓰는 파일
const PAGE_ASSETS = [];
function renderHtml(file) {
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace('<meta name="app-version" content="">', `<meta name="app-version" content="${COMMIT}">`);
  for (const a of ASSETS) {
    html = html.replace(new RegExp(`(href|src)="${a.replace('.', '\.')}"`, 'g'), `$1="${a}?v=${COMMIT}"`);
  }
  return html;
}
const renderIndex = () => renderHtml(path.join(PUBLIC, 'index.html'));
const INDEX_HTML = renderIndex();

// 브라우저에 거는 규칙(CSP). /check 페이지에서도 이 내용을 그대로 보여 준다.
const CSP_RULES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'self'",
];
const CSP = CSP_RULES.join('; ');

// 오프라인용 서비스 워커가 설치 때 미리 받아 둘 파일 (커밋이 바뀌면 캐시 이름도 바뀐다)
const listDir = (dir, prefix) => {
  try { return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => `${prefix}/${encodeURIComponent(f)}`); } catch { return []; }
};
const PAGES = ['/check', '/privacy', '/licenses'].filter((p) => fs.existsSync(path.join(PUBLIC, 'pages', `${p.slice(1)}.html`)));
function precacheList() {
  return [
    '/',
    ...ASSETS.map((a) => `/${a}?v=${COMMIT}`),
    `/compress-worker.js?v=${COMMIT}`,
    '/manifest.webmanifest',
    ...listDir(path.join(PUBLIC, 'icons'), '/icons'),
    ...PAGES,
    ...PAGE_ASSETS.map((a) => `/${a}?v=${COMMIT}`),
    '/vendor/pdf-lib.min.js', '/vendor/pdf.min.js', '/vendor/pdf.worker.min.js', '/vendor/jszip.min.js', '/vendor/pako.min.js', '/vendor/fontkit.min.js',
    '/vendor/jpeg-decoder.js', '/vendor/heic/heic-to.js',
    '/vendor/pretendard/pretendardvariable.min.css',
    ...listDir(nm('pretendard', 'dist', 'web', 'variable', 'woff2'), '/vendor/pretendard/woff2'),
    '/vendor/fonts/Pretendard-Bold.otf',
    ...listDir(nm('pdfjs-dist', 'cmaps'), '/vendor/cmaps'),
    ...listDir(nm('pdfjs-dist', 'standard_fonts'), '/vendor/standard_fonts'),
  ];
}

// 라이브러리는 CDN 없이 node_modules에서 직접 제공한다.
const VENDOR = {
  'pdf-lib.min.js': nm('@cantoo', 'pdf-lib', 'dist', 'pdf-lib.min.js'),
  'pdf.min.js': nm('pdfjs-dist', 'build', 'pdf.min.js'),
  'pdf.worker.min.js': nm('pdfjs-dist', 'build', 'pdf.worker.min.js'),
  'jszip.min.js': nm('jszip', 'dist', 'jszip.min.js'),
  'pako.min.js': nm('pako', 'dist', 'pako.min.js'),
  'fontkit.min.js': nm('@cantoo', 'fontkit', 'dist', 'fontkit.umd.min.js'),
};

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  // 외부로 나가는 연결을 막아 파일이 브라우저 밖으로 새지 않게 한다.
  // (connect-src 'self': 이 사이트 말고는 어디로도 데이터를 보낼 수 없다. 스크립트 · 글꼴 · 스타일도 이 사이트 것만)
  res.set('Content-Security-Policy', CSP);
  next();
});

// pdf.js가 글꼴이 내장되지 않은 PDF(한글 포함)를 그릴 때 쓰는 자료
app.use('/vendor/cmaps', express.static(nm('pdfjs-dist', 'cmaps'), { maxAge: '1d' }));
app.use('/vendor/standard_fonts', express.static(nm('pdfjs-dist', 'standard_fonts'), { maxAge: '1d' }));

// 글꼴 Pretendard (1.3.9에는 variable용 .min.css가 없어 같은 내용의 .css를 그 이름으로 제공)
app.get('/vendor/pretendard/pretendardvariable.min.css', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('text/css');
  res.sendFile(nm('pretendard', 'dist', 'web', 'variable', 'pretendardvariable.css'));
});
// 한글 워터마크용 글꼴 (워터마크를 쓸 때만 불러온다)
app.get('/vendor/fonts/Pretendard-Bold.otf', (req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.type('font/otf');
  res.sendFile(nm('pretendard', 'dist', 'public', 'static', 'Pretendard-Bold.otf'));
});
app.use('/vendor/pretendard/woff2', express.static(nm('pretendard', 'dist', 'web', 'variable', 'woff2'), { maxAge: '7d' }));

// 아이폰 HEIC → JPEG 변환기 (heic-to, libheif 1.22.2 · LGPL-3.0). HEIC 사진이 들어올 때만 불러온다.
// CSP 빌드(eval · new Function 없음)를 ES 모듈로 제공한다.
app.get('/vendor/heic/heic-to.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.type('application/javascript');
  res.sendFile(nm('heic-to', 'dist', 'csp', 'heic-to.js'));
});
app.get('/vendor/heic/LICENSE', (req, res) => {
  res.type('text/plain; charset=utf-8');
  res.sendFile(nm('heic-to', 'LICENSE'));
});

// CMYK JPEG 등을 성분 값으로 풀 JS 디코더 (용량 줄이기에서 필요할 때만 불러온다)
const jpegDecoder = require('./lib/jpeg-decoder');
app.get('/vendor/jpeg-decoder.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/javascript');
  res.send(jpegDecoder.browserScript());
});

app.get('/vendor/:file', (req, res) => {
  const file = VENDOR[req.params.file];
  if (!file) return res.status(404).send('Not found');
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/javascript');
  res.sendFile(file);
});

// 배포된 버전 확인용
app.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(VERSION);
});

// 서비스 워커: 커밋과 미리 받을 목록을 넣어서 준다. 늘 새로 확인해야 새 버전을 알아챈다.
const SW_JS = () => fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8')
  .replace("'__COMMIT__'", JSON.stringify(COMMIT))
  .replace('[/* __PRECACHE__ */]', JSON.stringify(precacheList(), null, 1));
const SW_CACHED = SW_JS();
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.send(process.env.NODE_ENV === 'development' ? SW_JS() : SW_CACHED);
});
app.get('/manifest.webmanifest', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/manifest+json');
  res.sendFile(path.join(PUBLIC, 'manifest.webmanifest'));
});

// HTML은 항상 서버에 새로 확인한다.
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(process.env.NODE_ENV === 'development' ? renderIndex() : INDEX_HTML);
});

app.use(express.static(PUBLIC, {
  index: false,
  setHeaders(res) {
    // ?v=커밋 으로 부른 파일은 내용이 바뀌지 않으므로 오래 캐시하고, 나머지는 매번 확인한다.
    const versioned = res.req && res.req.query && res.req.query.v;
    res.set('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
}));

app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`PDF 작업실 (v ${COMMIT}): http://localhost:${PORT}`);
});
