/* 도장 만들기(/stamp) 한 장: stamp.js(도장 화면)를 이 페이지에 띄운다.
 *   알림 · 저장 · 서명과 도장 보관(EDIT 공통) · [PDF에 찍기] → PDF 작업실 꾸미기로 넘기기
 * 이름 · 도장 그림은 이 브라우저 밖으로 나가지 않는다(서버로 보내는 것 없음).
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const E = self.EditCommon;
  const ver = (document.querySelector('meta[name="app-version"]') || {}).content || 'dev';

  /** 작은 요소 만들기(글은 textContent로만) */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // ── 알림 ──
  const box = $('toasts');
  function toast(title, fix = '', kind = 'info') {
    const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('div', { class: 'toast-body' }, h('div', { class: 'toast-title' }, title), fix ? h('div', { class: 'toast-fix' }, fix) : null),
      h('button', { class: 'toast-x', type: 'button', 'aria-label': '알림 닫기', onclick: () => el.remove() }, '×'));
    box.prepend(el);
    while (box.children.length > 4) box.lastChild.remove();
    if (box.showPopover) {
      try {
        if (box.matches(':popover-open')) box.hidePopover();
        box.showPopover();
      } catch { /* popover를 모르는 브라우저는 z-index로 */ }
    }
    let timer = setTimeout(() => el.remove(), kind === 'error' ? 15000 : 3500);
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => { timer = setTimeout(() => el.remove(), 4000); });
    return el;
  }

  // ── 저장 ──
  function download(data, name, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`"${name}" 저장을 시작했어요.`, '브라우저의 다운로드 폴더를 확인해 주세요.', 'ok');
  }

  // ── 묻기(예전 보관 지우기) ──
  function ask(title, body, yes) {
    const dlg = $('sp-confirm');
    $('sp-confirm-h').textContent = title;
    $('sp-confirm-body').textContent = body;
    $('sp-confirm-yes').textContent = yes;
    return new Promise((resolve) => {
      const done = () => { dlg.removeEventListener('close', done); resolve(dlg.returnValue === 'yes'); };
      dlg.returnValue = '';
      dlg.addEventListener('close', done);
      dlg.showModal();
      $('sp-confirm-no').focus();
    });
  }

  // ── 보관 안내: 빌려 쓰는 PC면 "창을 닫으면 지워져요", 숨겨 둔 예전 보관이 있으면 [내 것으로] · [지우기] ──
  const WHERE = {
    mine: { keep: '이 브라우저에만 · PDF 작업실 꾸미기에서도 바로 골라요' },
    shared: { keep: '이 창에만 · 창을 닫으면 지워져요' },
  };
  async function paintNotes() {
    const S = E.Stamps;
    await S.list();
    const shared = S.shared();
    const n = S.legacyCount();
    document.querySelectorAll('[data-keep-where]').forEach((el) => {
      el.textContent = WHERE[shared ? 'shared' : 'mine'][el.dataset.keepWhere] || el.textContent;
    });
    document.querySelectorAll('[data-stamp-notes]').forEach((note) => {
      const parts = [];
      if (shared) {
        parts.push(h('p', { class: 'hint-box warn stamp-shared' }, '빌려 쓰는 PC예요. 여기서 만든 도장은 이 창에만 두고, 창을 닫으면 지워져요. ',
          h('small', null, '내 PC라면 스쿨 → 내 정보에서 "이 PC는 내 교실 PC예요"를 체크하고 도구함에서 다시 열어 주세요.')));
      }
      if (n) {
        parts.push(h('div', { class: 'hint-box stamp-legacy' },
          h('p', null, `이 브라우저에 누구 것인지 모르는 예전 서명 · 도장 ${n}개가 있어 숨겨 뒀어요.`),
          shared
            ? h('small', null, '이 PC 주인 선생님이 열면 정리할 수 있어요.')
            : h('div', { class: 'btn-row' },
              h('button', { type: 'button', class: 'btn sm', 'data-legacy': 'claim' }, '내 것으로'),
              h('button', { type: 'button', class: 'btn sm', 'data-legacy': 'drop' }, '지우기'))));
      }
      note.replaceChildren(...parts);
      note.hidden = !parts.length;
    });
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('[data-legacy]');
    if (!b) return;
    const n = E.Stamps.legacyCount();
    if (b.dataset.legacy === 'claim') {
      await E.Stamps.claimLegacy();
      toast(`예전 서명 · 도장 ${n}개를 내 것으로 옮겼어요.`, '', 'ok');
      return;
    }
    if (!(await ask(`숨겨 둔 예전 서명 · 도장 ${n}개를 지울까요?`, '이 브라우저에서만 지워요. 되돌릴 수 없어요.', '지우기'))) return;
    await E.Stamps.dropLegacy();
    toast(`예전 서명 · 도장 ${n}개를 지웠어요.`, '', 'info');
  });

  // ── 띄우기 ──
  function start() {
    if (!self.StampTool || !E) {
      $('st-loading').textContent = '도장 도구를 열지 못했어요. 새로 고침해 주세요.';
      return;
    }
    E.Stamps.onChange(() => { paintNotes().catch(() => {}); });
    paintNotes().catch(() => {});
    self.StampTool.mount({
      ver,
      toast,
      download,
      Stamps: E.Stamps,
      isActive: () => true,
      // [PDF에 찍기]: 보관한 도장을 이 탭에 적어 두고 PDF 작업실 꾸미기로 간다(같은 탭이라 빌려 쓰는 PC의 도장도 그대로)
      useInDecor: (id) => {
        E.setPendingStamp(id);
        location.assign('/pdf#decorate');
      },
    });
    // Ctrl+S = PNG 저장(브라우저의 "페이지 저장" 대신)
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 's') {
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        self.StampTool.save();
      }
    });
    // 검사용 엿보기(이름 같은 값은 돌려주지 않는다)
    self.__stampPage = { version: 1, stamp: () => self.StampTool.state(), stamps: () => E.Stamps.state() };
  }
  start();
})();
