'use strict';

/**
 * EDIT: 파일을 브라우저 안에서만 다루는 도구 모음. 도구마다 주소가 따로 있고, 통행증 · 규칙(CSP)은 하나다.
 *   /       EDIT 입구(도구 고르기)
 *   /pdf    PDF 작업실
 *   /photo  사진 작업실
 *   /stamp  도장 만들기
 * 스쿨 도구함의 [열기]는 도구 주소로 바로 온다(…/pdf#t=입장권). 예전 길(/#t=입장권&tool=이름)도 그 도구로 보낸다.
 * 화면 쪽 같은 규칙은 public/edit/route.js에 있다(이 목록과 같아야 한다 — test/verify.mjs가 맞춰 본다).
 */
const EDIT_NAME = 'EDIT';

const TOOLS = [
  { id: 'pdf', name: 'PDF 작업실', path: '/pdf', go: 'pdf' },
  { id: 'photo', name: '사진 작업실', path: '/photo', go: 'photo' },
  { id: 'stamp', name: '도장 만들기', path: '/stamp', go: 'stamp' },
];

/** 주소 → 관문 화면에 쓸 이름과 스쿨의 /go/ 이름(EDIT 입구와 안내 페이지는 PDF 작업실로 연다) */
function gateFor(pathname) {
  const p = String(pathname || '/').replace(/\/+$/, '') || '/';
  const tool = TOOLS.find((t) => p === t.path || p.startsWith(`${t.path}/`));
  return tool ? { name: tool.name, go: tool.go } : { name: EDIT_NAME, go: 'pdf' };
}

module.exports = { EDIT_NAME, TOOLS, gateFor };
