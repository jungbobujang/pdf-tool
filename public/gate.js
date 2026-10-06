/* 안내 화면: 주소 뒤 #t=입장권 이 있으면 서버에 보내 통행증을 받고, #을 지운 주소로 다시 연다
   (&tool=이름 이 있었으면 그 도구로 — EDIT 입구(/)로 온 예전 길은 edit/route.js가 도구 주소를 정한다).
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
  // Xschool 도구함이 하위 도구를 고르면 #t=입장권&tool=compress. 이름 모양만 여기서 거르고, 열 수 있는 도구인지는 앱이 본다
  var toolMatch = hash.match(/&tool=([a-z0-9-]{1,20})(?:&|$)/);
  var tool = toolMatch ? toolMatch[1] : '';
  // Xschool에서 "내 교실 PC"로 정하지 않은 PC면 &pc=shared: 통행증을 창을 닫으면 사라지게, 서명 · 도장은 이 창에만
  var pc = /&pc=shared(?:&|$)/.test(hash) ? 'shared' : 'mine';
  // 입장권은 주소창 · 방문 기록에 남기지 않는다
  history.replaceState(null, '', location.pathname + location.search);
  $('gate-plain').hidden = true;
  $('gate-checking').hidden = false;

  fetch('/api/enter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ t: ticket, pc: pc }),
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; });
  }).then(function (r) {
    if (r.ok) {
      // #이름 만 붙여서 location.replace 하면 같은 문서 안에서 조각만 바뀌어 안내 화면이 그대로 남는다.
      // 같은 주소면 주소를 먼저 맞춰 둔 뒤 새로 불러온다(통행증이 생겼으니 서버가 도구 화면을 준다).
      var route = self.EditRoute ? self.EditRoute.destFor(location.pathname, tool, true) : null;
      var dest = route || (location.pathname + location.search + (tool ? '#' + tool : ''));
      var samePage = dest.split('#')[0] === location.pathname;
      if (!samePage) { location.replace(dest); return; }
      try { history.replaceState(null, '', dest); location.reload(); } catch (e) { location.replace(dest); }
      return;
    }
    showError((r.body && r.body.message) || '열지 못했어요. 아래 [Xschool에서 열기]를 다시 눌러 주세요.');
  }).catch(function () {
    showError('서버에 연결하지 못했어요. 인터넷 연결을 확인하고 아래 [Xschool에서 열기]를 다시 눌러 주세요.');
  });
})();
