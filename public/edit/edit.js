/* EDIT 입구. 스쿨 입장권(#t=…)으로 왔으면 통행증을 지금 사람 것으로 새로 받고 그 도구 주소로 보낸다.
   예전 주소(/#compress · /#stamp · /#feedback …)도 도구 주소로 보낸다(edit/route.js). 입장권은 주소에서 바로 지운다. */
(function () {
  'use strict';
  var hash = String(location.hash || '');
  var ticket = hash.match(/^#t=([^&]+)/);
  var opening = document.getElementById('ed-opening');
  if (ticket) {
    var toolMatch = hash.match(/&tool=([a-z0-9-]{1,20})(?:&|$)/);
    var tool = toolMatch ? toolMatch[1] : '';
    var pc = /&pc=shared(?:&|$)/.test(hash) ? 'shared' : 'mine';
    var value = ticket[1];
    try { value = decodeURIComponent(value); } catch (e) { /* 그대로 */ }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 못 바꿔도 계속 */ }
    if (opening) opening.hidden = false;
    var go = function () { location.replace(EditRoute.destFor(location.pathname, tool, true)); };
    var sent = fetch('/api/enter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ t: value, pc: pc }),
    }).then(function () {}, function () {});
    // 서버가 늦어도 6초 뒤에는 지금 통행증으로 계속
    Promise.race([sent, new Promise(function (r) { setTimeout(r, 6000); })]).then(go, go);
    return;
  }
  var name = '';
  try { name = decodeURIComponent(hash.slice(1)); } catch (e) { name = ''; }
  if (name) {
    var dest = EditRoute.destFor(location.pathname, name, false);
    if (dest) { location.replace(dest); }
  }
})();
