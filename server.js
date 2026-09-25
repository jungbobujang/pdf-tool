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

// 지금 돌고 있는 코드의 커밋. Railway는 RAILWAY_GIT_COMMIT_SHA를 넣어 준다.
function currentCommit() {
  const env = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || process.env.GIT_COMMIT;
  if (env) return env.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}
const COMMIT = currentCommit();
const BUILT_AT = new Date().toISOString();

// index.html의 app.js · style.css · pdf-core.js 주소에 ?v=커밋 을 붙인다.
// 커밋이 바뀌면 주소가 바뀌므로 브라우저나 중간 캐시에 옛 파일이 남지 않는다.
const ASSETS = ['style.css', 'pdf-core.js', 'app.js'];
function renderIndex() {
  let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  for (const a of ASSETS) {
    html = html.replace(new RegExp(`(href|src)="${a.replace('.', '\.')}"`, 'g'), `$1="${a}?v=${COMMIT}"`);
  }
  return html;
}
const INDEX_HTML = renderIndex();

// 라이브러리는 CDN 없이 node_modules에서 직접 제공한다.
const VENDOR = {
  'pdf-lib.min.js': nm('@cantoo', 'pdf-lib', 'dist', 'pdf-lib.min.js'),
  'pdf.min.js': nm('pdfjs-dist', 'build', 'pdf.min.js'),
  'pdf.worker.min.js': nm('pdfjs-dist', 'build', 'pdf.worker.min.js'),
  'jszip.min.js': nm('jszip', 'dist', 'jszip.min.js'),
};

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  // 외부로 나가는 연결을 막아 파일이 브라우저 밖으로 새지 않게 한다.
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "worker-src 'self' blob:",
      "connect-src 'self' blob: data:",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
    ].join('; ')
  );
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
app.use('/vendor/pretendard/woff2', express.static(nm('pretendard', 'dist', 'web', 'variable', 'woff2'), { maxAge: '7d' }));

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
  res.json({ commit: COMMIT, builtAt: BUILT_AT });
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
