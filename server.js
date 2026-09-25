'use strict';

// 정적 파일만 제공하는 서버. 업로드를 받는 경로는 없다.
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const nm = (...p) => path.join(__dirname, 'node_modules', ...p);

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

app.get('/vendor/:file', (req, res) => {
  const file = VENDOR[req.params.file];
  if (!file) return res.status(404).send('Not found');
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/javascript');
  res.sendFile(file);
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`PDF 작업실: http://localhost:${PORT}`);
});
