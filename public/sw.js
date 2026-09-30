/* 끄기 워커 (2026-09-30). 오프라인 · 바탕화면 설치는 끝났다.
   예전 오프라인 워커가 깔린 브라우저가 이 파일을 새 버전으로 받으면:
   바로 켜지고 → pdfws- 캐시를 모두 지우고 → 자기 등록을 풀고 → 열려 있는 창을 한 번 다시 연다.
   다시 열린 창은 서버를 거치므로 스쿨 입장권이 없으면 안내 화면이 나온다.
   fetch 처리는 없다(아무 요청도 가로채지 않는다). 옛 설치가 정리될 수 있게 이 주소는 몇 달 남겨 둔다. */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('pdfws-')).map((n) => caches.delete(n)));
    } catch (e) { /* 캐시를 못 쓰는 환경 */ }
    try { await self.clients.claim(); } catch (e) { /* 없음 */ }
    try { await self.registration.unregister(); } catch (e) { /* 이미 풀림 */ }
    const wins = await self.clients.matchAll({ type: 'window' });
    await Promise.all(wins.map((c) => (c.navigate ? c.navigate(c.url).catch(() => {}) : null)));
  })());
});
