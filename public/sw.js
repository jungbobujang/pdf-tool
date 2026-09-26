/* 오프라인용 서비스 워커. 서버가 커밋과 미리 받을 파일 목록을 채워서 /sw.js 로 준다.
   - 설치 때 앱 화면 · 라이브러리 · 글꼴을 모두 받아 둔다(파일 자체는 절대 캐시하지 않는다. PDF는 브라우저 밖으로 안 나간다).
   - 새 버전이 오면 "대기"로 두고, 화면의 [새로고침]을 누를 때만 바꾼다(작업 중 강제 새로고침 없음).
   - /version 은 캐시하지 않는다(오프라인 판별에 쓴다). */
const VERSION = '__COMMIT__';
const CACHE = `pdfws-${VERSION}`;
const PRECACHE = [/* __PRECACHE__ */];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 하나라도 못 받으면 설치를 실패시켜 반쪽짜리 캐시가 남지 않게 한다
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
    // 처음 설치면 바로 켠다(바꿀 옛 버전이 없으니 기다릴 이유가 없다)
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('pdfws-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/version' || url.pathname === '/sw.js') return; // 늘 네트워크

  if (req.mode === 'navigate') {
    // 화면은 이 버전 캐시에서(같은 버전의 app.js · style.css와 짝이 맞는다), 없으면 네트워크
    const key = url.pathname === '/index.html' ? '/' : url.pathname;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch (e) {
        return (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    return fetch(req);
  })());
});
