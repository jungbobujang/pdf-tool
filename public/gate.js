/* 안내 화면: 주소 뒤 #t=입장권 이 있으면 서버에 보내 통행증을 받고, #을 지운 주소로 다시 연다.
   입장권은 화면에 보이거나 어디에 남지 않는다(주소에서도 바로 지운다). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  // 바탕화면 아이콘으로 연 창이면 아이콘 안내를 보여 준다
  var standalone = false;
  try {
    standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  } catch (e) { standalone = false; }

  // 예전에 깔린 오프라인 워커가 남아 있으면 치운다(끄기 워커가 먼저 치우지만 한 번 더)
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(function (regs) { regs.forEach(function (r) { r.unregister(); }); }).catch(function () {});
    }
    if (window.caches && caches.keys) {
      caches.keys().then(function (names) { names.filter(function (n) { return n.indexOf('pdfws-') === 0; }).forEach(function (n) { caches.delete(n); }); }).catch(function () {});
    }
  } catch (e) { /* 없는 환경 */ }

  function showError(text) {
    $('gate-checking').hidden = true;
    $('gate-plain').hidden = false;
    $('gate-title').textContent = '열지 못했어요';
    $('gate-text').hidden = true;
    $('gate-icon').hidden = true;
    var box = $('gate-error');
    box.textContent = text;
    box.hidden = false;
  }

  var hash = String(location.hash || '');
  var match = hash.match(/^#t=([^&]+)/);
  if (!match) {
    if (standalone) {
      $('gate-text').hidden = true;
      $('gate-icon').hidden = false;
    }
    return;
  }
  var ticket = '';
  try { ticket = decodeURIComponent(match[1]); } catch (e) { ticket = match[1]; }
  // 입장권은 주소창 · 방문 기록에 남기지 않는다
  history.replaceState(null, '', location.pathname + location.search);
  $('gate-plain').hidden = true;
  $('gate-checking').hidden = false;

  fetch('/api/enter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ t: ticket }),
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; });
  }).then(function (r) {
    if (r.ok) { location.replace(location.pathname + location.search); return; }
    showError((r.body && r.body.message) || '열지 못했어요. 아래 [스쿨에서 열기]를 다시 눌러 주세요.');
  }).catch(function () {
    showError('PDF 작업실 서버에 연결하지 못했어요. 인터넷 연결을 확인하고 아래 [스쿨에서 열기]를 다시 눌러 주세요.');
  });
})();
