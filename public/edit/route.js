/* EDIT: Xschool 입장권(#t=…&tool=이름) · 예전 주소(/#도구)를 어느 도구 주소로 보낼지. 서버 lib/edit-tools.js와 같은 목록.
   PDF 작업실 안의 도구(편집 · 사진→PDF …)는 /pdf#이름, 사진 작업실 · 도장 만들기는 자기 주소로. */
(function (root) {
  'use strict';
  var TOOL_PATH = { pdf: '/pdf', photo: '/photo', stamp: '/stamp' };
  // PDF 작업실 안의 도구 이름(예전 이름 포함)과 의견 창
  var PDF_PARTS = ['edit', 'img2pdf', 'pdf2img', 'decorate', 'compress', 'security', 'feedback', 'lock', 'password', 'number', 'numbers', 'shrink'];

  /**
   * path: 지금 주소, tool: #이름(없으면 ''), fromTicket: Xschool에서 막 온 길인지.
   * 돌려주는 값: 옮겨 갈 주소(경로 + #), 지금 자리에 있으면 null.
   */
  function destFor(path, tool, fromTicket) {
    var p = String(path || '/').replace(/\/+$/, '') || '/';
    var t = String(tool || '').toLowerCase();
    if (p === '/' || p === '/index.html') {
      if (TOOL_PATH[t]) return TOOL_PATH[t];
      if (PDF_PARTS.indexOf(t) >= 0) return '/pdf#' + t;
      // Xschool의 예전 PDF 작업실 [열기](이름 없이 /#t=…)는 PDF 작업실로, 모르는 이름도 PDF 작업실로
      if (t || fromTicket) return '/pdf';
      return null;
    }
    if (p === '/pdf') return t ? '/pdf#' + t : '/pdf';
    return p;
  }

  root.EditRoute = { destFor: destFor, TOOL_PATH: TOOL_PATH, PDF_PARTS: PDF_PARTS };
})(self);
