'use strict';

// 정적 파일만 제공하는 서버. 업로드를 받는 경로는 없다(PDF는 브라우저 밖으로 나가지 않는다).
// 스쿨 입장권(도구 연결 규칙 v1): 스쿨 도구함의 [열기]로 온 선생님만 화면을 받는다(lib/gate.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const express = require('express');
const gate = require('./lib/gate');

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
// 공유 미리보기(Open Graph)에 쓰는 사이트 주소. 다른 주소로 배포하면 PUBLIC_URL 환경 변수로 바꾼다.
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://pdf-tool-production-a037.up.railway.app').replace(/\/$/, '');
const ASSETS = ['style.css', 'compat.js', 'config.js', 'pdf-core.js', 'compress.js', 'guide-anim.js', 'app.js'];
// 안내 페이지(/check · /privacy · /licenses)가 쓰는 파일
const PAGE_ASSETS = ['pages.js'];
function renderHtml(file) {
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace('<meta name="app-version" content="">', `<meta name="app-version" content="${COMMIT}">`);
  html = html.replace('<!-- CSP_LIST -->', () => CSP_LIST_HTML);
  // 공유 미리보기 그림은 절대 주소여야 메신저가 가져간다
  html = html.replace(/__ORIGIN__/g, PUBLIC_URL);
  for (const a of [...ASSETS, ...PAGE_ASSETS]) {
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
// /check 페이지에 보여 줄 규칙 설명
const CSP_WHY = {
  'default-src': '따로 정하지 않은 것은 모두 이 사이트에서만 받아요.',
  'script-src': '실행되는 코드는 이 사이트 것뿐이에요. 다른 곳 스크립트 · 페이지 안에 끼워 넣은 코드 · eval은 막혀요.',
  'style-src': '화면 모양(CSS)도 이 사이트 것만 써요.',
  'img-src': '그림은 이 사이트와 브라우저 안에서 만든 것(blob · data)만 보여요.',
  'font-src': '글꼴도 이 사이트에서만 받아요.',
  'worker-src': '뒤에서 도는 작업(PDF 그리기 · 용량 줄이기)도 이 사이트 코드로만 돌아요.',
  'connect-src': '가장 중요한 규칙: 이 사이트 말고는 어디로도 데이터를 보낼 수 없어요. 코드가 파일을 보내려 해도 브라우저가 막아요.',
  'object-src': '플러그인(옛 플래시 같은 것)은 쓰지 않아요.',
  'frame-ancestors': '다른 사이트가 이 화면을 몰래 틀 안에 넣어 보여 줄 수 없어요.',
  'form-action': '양식을 다른 곳으로 제출할 수 없어요.',
  'base-uri': '페이지의 기준 주소를 바꿔 다른 곳을 가리키게 할 수 없어요.',
};
const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CSP_LIST_HTML = CSP_RULES.map((r) => `<li><code>${escHtml(r)}</code><span>${escHtml(CSP_WHY[r.split(' ')[0]] || '')}</span></li>`).join('\n        ');

const PAGES = ['/check', '/privacy', '/licenses'].filter((p) => fs.existsSync(path.join(PUBLIC, 'pages', `${p.slice(1)}.html`)));

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

// ─────────────────────────────────────────────────────────────
// 스쿨 입장권 · 통행증
// ─────────────────────────────────────────────────────────────
// 스쿨 주소(공개 키를 받는 곳 · 안내 화면의 [스쿨에서 열기] = 스쿨 주소 + /go/pdf)
const SCHOOL_URL = (process.env.SCHOOL_URL || 'https://school-production-082b.up.railway.app').replace(/\/+$/, '');
// 통행증 서명 비밀: 서버가 시작할 때마다 새로 만든다(그래서 재배포하면 다시 [열기]가 필요하다).
// PASS_SECRET(64자리 16진수)은 여러 서버를 띄우는 점검에서만 쓴다.
const PASS_SECRET = /^[0-9a-f]{64}$/i.test(process.env.PASS_SECRET || '') ? Buffer.from(process.env.PASS_SECRET, 'hex') : crypto.randomBytes(32);
const pubkey = gate.createPubkeyCache(SCHOOL_URL);
const jtis = gate.createJtiStore();
const enterLimit = gate.createRateLimit(20, 60 * 1000);
const hasPass = (req) => !!gate.readPass(PASS_SECRET, gate.cookieOf(req));

// 안내 화면: 통행증이 없을 때 모든 페이지 대신 준다
const GATE_HTML = () => renderHtml(path.join(PUBLIC, 'gate.html')).replace(/__SCHOOL_URL__/g, SCHOOL_URL);
const GATE_CACHED = GATE_HTML();
function sendGate(res) {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(process.env.NODE_ENV === 'development' ? GATE_HTML() : GATE_CACHED);
}

const ENTER_TEXT = {
  school_unreachable: '스쿨에 잠깐 연결이 안 돼요. 잠시 뒤 아래 [스쿨에서 열기]를 다시 눌러 주세요.',
  too_many: '너무 자주 시도했어요. 1분 뒤에 아래 [스쿨에서 열기]를 다시 눌러 주세요.',
};
app.post('/api/enter', express.json({ limit: '4kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const fail = (status, reason, message) => {
    // 로그에는 결과와 까닭의 종류만. 입장권 · 가명 번호 · 쿠키 값은 남기지 않는다
    console.log(`enter fail reason=${reason}`);
    res.status(status).json({ error: reason, message: `${message} 아래 [스쿨에서 열기]를 다시 눌러 주세요.` });
  };
  if (!enterLimit(gate.clientIp(req))) {
    console.log('enter fail reason=too_many');
    return res.status(429).json({ error: 'too_many', message: ENTER_TEXT.too_many });
  }
  const key = await pubkey.get();
  if (!key) {
    console.log('enter fail reason=school_unreachable');
    return res.status(503).json({ error: 'school_unreachable', message: ENTER_TEXT.school_unreachable });
  }
  const result = gate.checkTicket(req.body && req.body.t, key, { jtis });
  if (!result.ok) return fail(result.reason === 'format' ? 400 : 403, result.reason, gate.REASONS[result.reason] || gate.REASONS.format);
  res.set('Set-Cookie', gate.passCookie(gate.makePass(PASS_SECRET, result.body)));
  console.log('enter ok');
  res.json({ ok: true });
});

// 옛 설치를 치우는 "끄기 워커". 통행증 없이 받을 수 있어야 옛 워커가 이것으로 바뀌어 스스로 지워진다.
// 옛 바탕화면 아이콘 · 한 번 열었던 브라우저가 정리될 수 있게 이 주소는 몇 달 남겨 둔다.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC, 'sw.js'));
});
// 바탕화면 설치는 끝났다(2026-09-30)
app.get('/manifest.webmanifest', (req, res) => res.status(404).send('Not found'));

// 안내 페이지: 직접 확인하는 법 · 개인정보 안내 · 사용한 라이브러리
const PAGE_HTML = Object.fromEntries(PAGES.map((p) => [p, renderHtml(path.join(PUBLIC, 'pages', `${p.slice(1)}.html`))]));
app.get(PAGES, (req, res) => {
  if (!hasPass(req)) return sendGate(res);
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(process.env.NODE_ENV === 'development' ? renderHtml(path.join(PUBLIC, 'pages', `${req.path.slice(1)}.html`)) : PAGE_HTML[req.path]);
});
app.get('/changelog.json', (req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); });

// HTML은 항상 서버에 새로 확인한다.
app.get(['/', '/index.html'], (req, res) => {
  if (!hasPass(req)) return sendGate(res);
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(process.env.NODE_ENV === 'development' ? renderIndex() : INDEX_HTML);
});

// 안내 화면의 원본은 채워서만 준다
app.get('/gate.html', (req, res) => sendGate(res));

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
