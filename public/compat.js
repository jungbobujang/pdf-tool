/* 오래된 브라우저 확인 (ES5로만 쓴다: 인터넷 익스플로러에서도 이 파일은 읽혀야 한다)
   필수 기능이 없으면 앱 대신 "이 브라우저에서는 열 수 없어요" 안내를 보여 준다. */
(function () {
  var ok = true;
  try {
    ok = typeof Promise === 'function' &&
      typeof Blob === 'function' &&
      typeof Symbol === 'function' &&
      typeof globalThis === 'object' && // ES2020
      typeof Promise.allSettled === 'function' && // ES2020
      typeof String.prototype.matchAll === 'function' && // ES2020
      typeof BigInt === 'function' && // ES2020
      typeof URL === 'function' &&
      typeof fetch === 'function' &&
      !!window.CSS && typeof CSS.supports === 'function' && CSS.supports('display', 'grid') &&
      (typeof OffscreenCanvas === 'function' || !!document.createElement('canvas').getContext);
  } catch (e) {
    ok = false;
  }
  window.PDFWS_COMPAT = ok;
  if (ok) return;
  function show() {
    var note = document.getElementById('old-browser');
    if (!note) return;
    document.body.className += ' old-browser';
    note.removeAttribute('hidden');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();
