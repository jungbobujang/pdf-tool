/*
 * "이렇게 써요" 패널의 움직이는 예시. 그림이나 영상 없이 DOM + CSS transition + 단계 타임라인으로 만든다.
 * 공용 부품(커서 · 클릭 파동 · 미니 쪽 · 키 배지 · 상태 배지 · 알약 버튼)과 도구별 예시를 모아 둔다.
 *   GuideAnim.create(stage, name) → {play, pause, showLast, playing}
 */
(function (root) {
  'use strict';

  const W = 240; // 무대 안쪽 폭(px)
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const normAngle = (a) => (((Math.round(a / 90) * 90) % 360) + 360) % 360;
  const CURSOR = '<svg viewBox="0 0 16 22" aria-hidden="true"><path d="M1.5 1.5v16.2l4.3-4.1 2.9 6.6 2.8-1.2-2.9-6.5h5.9z"/></svg>';

  /** 무대 부품: 안쪽 판 · 커서 · 클릭 파동 · 위치 옮기기 */
  function stageParts(stage) {
    const inner = el('div', 'demo-inner');
    const cursor = el('div', 'demo-cursor');
    cursor.innerHTML = CURSOR;
    const ripple = el('div', 'demo-ripple');
    stage.replaceChildren(inner);
    inner.append(ripple, cursor);
    const at = (e, x, y) => { e.style.transform = `translate(${x}px, ${y}px)`; };
    const put = (e, x, y, w, h) => {
      at(e, x, y);
      if (w != null) e.style.width = `${w}px`;
      if (h != null) e.style.height = `${h}px`;
      inner.append(e);
      return e;
    };
    return {
      inner,
      at,
      put,
      moveCursor(x, y) { cursor.dataset.x = x; cursor.dataset.y = y; at(cursor, x, y); },
      click() {
        at(ripple, Number(cursor.dataset.x) - 14, Number(cursor.dataset.y) - 14);
        ripple.classList.remove('go');
        void ripple.offsetWidth; // 애니메이션을 처음부터 다시
        ripple.classList.add('go');
      },
      /** 누르는 느낌(버튼 · 스위치 · 칩) */
      press(e) {
        e.classList.remove('press');
        void e.offsetWidth;
        e.classList.add('press');
      },
      /** 위쪽 상태 배지 */
      badge(text, extra = '') {
        const b = el('span', `demo-status ${extra}`.trim());
        inner.append(b);
        const api = {
          el: b,
          show(t = text) { b.textContent = t; b.classList.add('show'); },
          hide() { b.classList.remove('show'); },
        };
        return api;
      },
      /** 오른쪽 위 키 배지(Ctrl · Shift · Ctrl+V …) */
      key(text) {
        const k = el('span', 'demo-key', text);
        inner.append(k);
        return k;
      },
      /** 화면 버튼 모양 */
      pill(text, x, y, cls = '') {
        return put(el('span', `demo-pill ${cls}`.trim(), text), x, y);
      },
    };
  }

  /** 단계 타임라인: [기다릴 ms, 할 일]을 차례로, 끝나면 처음부터 */
  function timeline(stage, build) {
    const d = build(stage);
    let i = 0;
    let timer = 0;
    let playing = false;
    const instant = (fn) => {
      stage.classList.add('no-anim');
      fn();
      void stage.offsetWidth;
      stage.classList.remove('no-anim');
    };
    function next() {
      if (!playing) return;
      if (i >= d.steps.length) { i = 0; instant(d.reset); }
      const [delay, fn] = d.steps[i];
      timer = setTimeout(() => { i++; fn(); next(); }, delay);
    }
    instant(d.reset);
    return {
      play() {
        if (playing) return;
        playing = true;
        next();
      },
      pause() {
        playing = false;
        clearTimeout(timer);
      },
      /** 움직임 줄이기: 마지막 장면만 */
      showLast() {
        this.pause();
        i = 0;
        instant(() => { d.reset(); d.steps.forEach(([, fn]) => fn()); });
      },
      get playing() { return playing; },
    };
  }

  const SLOT = (s) => 12 + s * 46;
  const PAGE_Y = 60;
  function minis(inner, n, label = (k) => String(k + 1)) {
    return Array.from({ length: n }, (_, k) => {
      const m = el('div', 'mini');
      m.append(el('b', null, label(k)));
      inner.append(m);
      return m;
    });
  }
  const center = (slot) => [SLOT(slot) + 15, PAGE_Y + 22];
  const today = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  };
  const noop = () => {};

  const DEMOS = {
    // ══ 편집 ══
    // ① 여러 쪽을 한꺼번에 옮기기
    'edit-move'(stage) {
      const s = stageParts(stage);
      const ps = minis(s.inner, 5);
      const key = s.key('Ctrl');
      const status = s.badge('2쪽 선택됨');
      const place = (order, lift = []) => order.forEach((no, slot) => {
        const m = ps[no - 1];
        m.classList.toggle('lift', lift.includes(no));
        s.at(m, SLOT(slot), PAGE_Y - (lift.includes(no) ? 8 : 0));
      });
      return {
        reset() {
          ps.forEach((m) => m.classList.remove('sel', 'lift'));
          place([1, 2, 3, 4, 5]);
          key.classList.remove('pressed');
          status.hide();
          s.moveCursor(200, 118);
        },
        steps: [
          [500, () => s.moveCursor(...center(1))],
          [650, () => { s.click(); ps[1].classList.add('sel'); }],
          [450, () => key.classList.add('pressed')],
          [400, () => s.moveCursor(...center(3))],
          [650, () => { s.click(); ps[3].classList.add('sel'); status.show('2쪽 선택됨'); }],
          [550, () => { key.classList.remove('pressed'); place([1, 2, 3, 4, 5], [2, 4]); }],
          [350, () => {
            // 두 장이 살짝 들린 채 커서를 따라 맨 앞으로
            s.moveCursor(SLOT(0) + 22, PAGE_Y + 10);
            s.at(ps[1], SLOT(0) - 4, PAGE_Y - 12);
            s.at(ps[3], SLOT(0) + 4, PAGE_Y - 6);
          }],
          [800, () => { s.click(); place([2, 4, 1, 3, 5]); status.show('순서 2, 4, 1, 3, 5'); }],
          [2400, noop],
        ],
      };
    },
    // ② 이어진 쪽을 범위로 고르기
    'edit-range'(stage) {
      const s = stageParts(stage);
      const ps = minis(s.inner, 5);
      const key = s.key('Shift');
      const status = s.badge('');
      const count = el('span', null, '4쪽 선택됨 → ');
      const del = el('b', 'demo-del', '삭제');
      return {
        reset() {
          ps.forEach((m, k) => { m.classList.remove('sel', 'gone'); s.at(m, SLOT(k), PAGE_Y); });
          key.classList.remove('pressed');
          status.hide();
          status.el.replaceChildren(count, del);
          del.classList.remove('hit');
          s.moveCursor(200, 118);
        },
        steps: [
          [500, () => s.moveCursor(...center(1))],
          [650, () => { s.click(); ps[1].classList.add('sel'); }],
          [450, () => key.classList.add('pressed')],
          [400, () => s.moveCursor(...center(4))],
          [650, () => s.click()],
          [120, () => ps[2].classList.add('sel')],
          [120, () => ps[3].classList.add('sel')],
          [120, () => { ps[4].classList.add('sel'); status.el.classList.add('show'); }],
          [500, () => { key.classList.remove('pressed'); s.moveCursor(del.offsetLeft + status.el.offsetLeft + 14, status.el.offsetTop + 12); }],
          [650, () => { s.click(); del.classList.add('hit'); }],
          [250, () => ps.slice(1).forEach((m) => m.classList.add('gone'))],
          [2400, noop],
        ],
      };
    },
    // ③ 돌리기는 90°씩
    'edit-rotate'(stage) {
      const s = stageParts(stage);
      const page = el('div', 'mini big');
      page.append(el('b', null, 'A'));
      s.inner.append(page);
      const left = s.put(el('span', 'demo-btn', '↺'), 138, 38);
      const right = s.put(el('span', 'demo-btn', '↻'), 186, 38);
      const deg = s.put(el('span', 'demo-deg', '0°'), 138, 82);
      let turn = 0; // 누적 각도(부드럽게 돌도록), 보여 주는 숫자는 0/90/180/270
      const show = () => {
        page.style.transform = `translate(42px, 28px) rotate(${turn}deg)`;
        deg.textContent = `${normAngle(turn)}°`;
      };
      const press = (btn, dir) => { s.click(); s.press(btn); turn += dir * 90; show(); };
      return {
        reset() { turn = 0; show(); s.moveCursor(120, 120); },
        steps: [
          [500, () => s.moveCursor(204, 54)],
          [650, () => press(right, 1)],
          [900, () => press(right, 1)],
          [900, () => s.moveCursor(156, 54)],
          [650, () => press(left, -1)],
          [900, () => press(left, -1)],
          [2200, noop],
        ],
      };
    },

    // ══ 사진 → PDF ══
    // ① 사진을 한꺼번에 끌어다 놓기
    'img-drop'(stage) {
      const s = stageParts(stage);
      const zone = s.put(el('div', 'demo-zone'), 16, 58, 208, 62);
      zone.append(el('span', 'demo-zone-text', '점선 칸'));
      const colors = ['g1', 'g2', 'g3'];
      const photos = colors.map((c) => s.put(el('div', `demo-photo ${c}`), 0, 0));
      const status = s.badge('');
      const stack = (x, y) => photos.forEach((p, k) => s.at(p, x + k * 5, y + k * 4));
      return {
        reset() {
          zone.classList.remove('over', 'filled');
          photos.forEach((p) => p.classList.remove('card'));
          stack(176, 14);
          status.hide();
          s.moveCursor(196, 26);
        },
        steps: [
          [500, () => { s.click(); photos.forEach((p) => p.classList.add('lift')); }],
          [400, () => { s.moveCursor(122, 90); stack(104, 76); }],
          [650, () => zone.classList.add('over')],
          [450, () => {
            s.click();
            zone.classList.remove('over');
            zone.classList.add('filled');
            photos.forEach((p, k) => { p.classList.remove('lift'); p.classList.add('card'); s.at(p, 34 + k * 62, 68); });
          }],
          [600, () => { s.moveCursor(210, 124); status.show('사진 3장 · 아이폰 사진은 자동 변환'); }],
          [2600, noop],
        ],
      };
    },
    // ② 순서 바꾸고 용지 고르기
    'img-order'(stage) {
      const s = stageParts(stage);
      const cards = ['g1', 'g2', 'g3'].map((c, k) => {
        const p = s.put(el('div', `demo-photo card ${c}`), 0, 0);
        p.append(el('b', null, String(k + 1)));
        return p;
      });
      const a4 = s.pill('A4 세로', 16, 98);
      const status = s.badge('');
      const slot = (i) => [24 + i * 66, 34];
      const place = (order) => order.forEach((no, i) => s.at(cards[no - 1], ...slot(i)));
      return {
        reset() {
          cards.forEach((c) => c.classList.remove('lift', 'portrait'));
          a4.classList.remove('on');
          place([1, 2, 3]);
          status.hide();
          s.moveCursor(210, 120);
        },
        steps: [
          [500, () => s.moveCursor(slot(2)[0] + 24, 56)],
          [600, () => { s.click(); cards[2].classList.add('lift'); }],
          [350, () => { s.moveCursor(slot(0)[0] + 20, 52); s.at(cards[2], slot(0)[0] - 4, 28); s.at(cards[0], ...slot(1)); s.at(cards[1], ...slot(2)); }],
          [750, () => { cards[2].classList.remove('lift'); place([3, 1, 2]); }],
          [450, () => s.moveCursor(46, 110)],
          [600, () => { s.click(); s.press(a4); a4.classList.add('on'); cards.forEach((c) => c.classList.add('portrait')); }],
          [600, () => status.show('A4 세로 · 여백 보통')],
          [2600, noop],
        ],
      };
    },

    // ══ PDF → 사진 ══
    // ① 원하는 쪽만 골라 저장
    'p2i-pick'(stage) {
      const s = stageParts(stage);
      const ps = minis(s.inner, 4);
      const checks = ps.map((m) => { const c = el('i', 'demo-check'); m.append(c); return c; });
      const save = s.pill('바로 저장', 148, 100, 'primary');
      const zip = s.put(el('span', 'demo-zip', 'ZIP'), 40, 96);
      const status = s.badge('');
      const pos = (k) => [22 + k * 52, 26];
      return {
        reset() {
          ps.forEach((m, k) => { m.classList.remove('sel'); s.at(m, ...pos(k)); });
          zip.classList.remove('show');
          status.hide();
          s.moveCursor(210, 124);
        },
        steps: [
          [500, () => s.moveCursor(pos(1)[0] + 16, 50)],
          [600, () => { s.click(); ps[1].classList.add('sel'); }],
          [450, () => s.moveCursor(pos(2)[0] + 16, 50)],
          [600, () => { s.click(); ps[2].classList.add('sel'); }],
          [450, () => s.moveCursor(186, 110)],
          [600, () => { s.click(); s.press(save); }],
          [350, () => { zip.classList.add('show'); status.show('2쪽 선택 → zip 하나'); }],
          [2600, noop],
        ],
      };
    },
    // ② 한 쪽을 PPT에 바로 붙이기
    'p2i-copy'(stage) {
      const s = stageParts(stage);
      const ps = minis(s.inner, 3);
      ps.forEach((m) => m.append(el('i', 'demo-check')));
      const copy = s.pill('📋 복사', 14, 100);
      const slide = s.put(el('div', 'demo-slide'), 128, 30, 100, 66);
      slide.append(el('span', 'demo-slide-title', 'PPT'));
      const pasted = el('div', 'demo-pasted');
      slide.append(pasted);
      const key = s.key('Ctrl+V');
      const status = s.badge('');
      const pos = (k) => [12 + k * 36, 34];
      return {
        reset() {
          ps.forEach((m, k) => { m.classList.remove('sel'); s.at(m, ...pos(k)); m.classList.add('small'); });
          pasted.classList.remove('show');
          key.classList.remove('pressed');
          status.hide();
          s.moveCursor(200, 124);
        },
        steps: [
          [500, () => s.moveCursor(pos(2)[0] + 12, 50)],
          [600, () => { s.click(); ps[2].classList.add('sel'); }],
          [450, () => s.moveCursor(44, 110)],
          [600, () => { s.click(); s.press(copy); status.show('복사했어요'); }],
          [700, () => s.moveCursor(176, 70)],
          [500, () => { s.click(); key.classList.add('pressed'); }],
          [250, () => { pasted.classList.add('show'); }],
          [500, () => key.classList.remove('pressed')],
          [2400, noop],
        ],
      };
    },

    // ══ 꾸미기 ══
    // ① 스위치를 켜면 바로 미리보기
    'dec-switch'(stage) {
      const s = stageParts(stage);
      const row1 = s.put(el('div', 'demo-row'), 10, 34);
      row1.append(el('span', null, '쪽번호'));
      const sw1 = el('i', 'demo-switch');
      row1.append(sw1);
      const row2 = s.put(el('div', 'demo-row'), 10, 72);
      row2.append(el('span', null, '워터마크'));
      const sw2 = el('i', 'demo-switch');
      row2.append(sw2);
      const paper = s.put(el('div', 'demo-paper'), 152, 18, 74, 100);
      for (let k = 0; k < 6; k++) paper.append(el('i', 'demo-line'));
      const num = el('span', 'demo-num', '1 / 6');
      const wm = el('span', 'demo-wm', '내부 자료');
      paper.append(num, wm);
      const status = s.badge('');
      return {
        reset() {
          [sw1, sw2].forEach((w) => w.classList.remove('on'));
          num.classList.remove('show');
          wm.classList.remove('show');
          status.hide();
          s.moveCursor(120, 124);
        },
        steps: [
          [500, () => s.moveCursor(124, 44)],
          [600, () => { s.click(); sw1.classList.add('on'); }],
          [300, () => num.classList.add('show')],
          [600, () => s.moveCursor(124, 82)],
          [600, () => { s.click(); sw2.classList.add('on'); }],
          [300, () => wm.classList.add('show')],
          [500, () => status.show('쪽번호 · 워터마크 켜짐')],
          [2600, noop],
        ],
      };
    },
    // ② 도장·서명은 끌어서 놓기
    'dec-stamp'(stage) {
      const s = stageParts(stage);
      const chip = s.put(el('span', 'demo-chip', '직인.png'), 10, 50);
      const paper = s.put(el('div', 'demo-paper'), 142, 16, 84, 106);
      for (let k = 0; k < 6; k++) paper.append(el('i', 'demo-line'));
      const stamp = s.put(el('span', 'demo-stamp', '印'), 0, 0);
      const status = s.badge('');
      return {
        reset() {
          chip.classList.remove('on');
          stamp.classList.remove('show', 'lift');
          s.at(stamp, 30, 78);
          status.hide();
          s.moveCursor(120, 124);
        },
        steps: [
          [500, () => s.moveCursor(40, 60)],
          [600, () => { s.click(); chip.classList.add('on'); }],
          [300, () => stamp.classList.add('show')],
          [450, () => { s.moveCursor(46, 92); }],
          [450, () => { s.click(); stamp.classList.add('lift'); }],
          [300, () => { s.moveCursor(204, 104); s.at(stamp, 188, 90); }],
          [800, () => { s.click(); stamp.classList.remove('lift'); }],
          [400, () => status.show('도장을 끌어서 위치 맞춤')],
          [2600, noop],
        ],
      };
    },

    // ══ 용량 줄이기 ══
    // ① "얼마 이하로"만 정하면 끝
    'cmp-target'(stage) {
      const s = stageParts(stage);
      const X0 = 16;
      const TW = 208;
      const track = s.put(el('div', 'demo-track'), X0, 58, TW);
      const fill = el('i', 'demo-fill');
      track.append(fill);
      const thumb = s.put(el('span', 'demo-thumb'), 0, 0);
      const bubble = el('span', 'demo-bubble');
      thumb.append(bubble);
      const f10 = (10 - 1.5) / (30.2 - 1.5);
      const chip = s.put(el('span', 'demo-chip small', '공문 10MB'), X0 + f10 * TW - 30, 76);
      const go = s.pill('줄이기', 176, 100, 'primary');
      const result = s.badge('', 'wide');
      const setP = (p) => { s.at(thumb, X0 + p * TW - 9, 50); fill.style.width = `${p * 100}%`; };
      return {
        reset() {
          fill.classList.remove('ok');
          setP(1);
          bubble.textContent = '30.2MB';
          result.hide();
          s.moveCursor(120, 124);
        },
        steps: [
          [500, () => s.moveCursor(X0 + f10 * TW, 86)],
          [600, () => { s.click(); setP(f10); bubble.textContent = '10.0MB'; }],
          [700, () => s.moveCursor(200, 110)],
          [550, () => { s.click(); s.press(go); }],
          [500, () => fill.classList.add('ok')],
          [300, () => result.show('30.2MB → 9.6MB ✓ 글자는 그대로')],
          [2800, noop],
        ],
      };
    },
    // ② 안 줄어드는 파일도 있어요
    'cmp-locked'(stage) {
      const s = stageParts(stage);
      const label = s.put(el('span', 'demo-label', '글자만 있는 문서 5.0MB'), 12, 28);
      const track = s.put(el('div', 'demo-track locked'), 16, 70, 208);
      const fill = el('i', 'demo-fill');
      fill.style.width = '100%';
      track.append(fill);
      const thumb = s.put(el('span', 'demo-thumb locked'), 215, 62);
      const status = s.badge('', 'wide');
      return {
        reset() {
          s.at(thumb, 215, 62);
          label.classList.remove('dim');
          status.hide();
          s.moveCursor(150, 122);
        },
        steps: [
          [500, () => s.moveCursor(224, 72)],
          [500, () => s.click()],
          [300, () => { s.moveCursor(170, 74); s.at(thumb, 211, 62); }],
          [260, () => s.at(thumb, 215, 62)],
          [300, () => s.moveCursor(120, 76)],
          [400, () => { label.classList.add('dim'); status.show('이 파일은 약 4.9MB까지만 줄일 수 있어요'); }],
          [2800, noop],
        ],
      };
    },

    // ══ 보안 ══
    // ① 암호 풀기
    'sec-unlock'(stage) {
      const s = stageParts(stage);
      const file = s.put(el('div', 'demo-file', '🔒'), 14, 30, 44, 56);
      const input = s.put(el('div', 'demo-input'), 72, 36, 150, 26);
      const go = s.pill('풀어서 저장', 120, 78, 'primary');
      const status = s.badge('', 'wide');
      return {
        reset() {
          file.textContent = '🔒';
          file.classList.remove('ok');
          input.textContent = '';
          input.classList.remove('focus');
          status.hide();
          s.moveCursor(120, 124);
        },
        steps: [
          [500, () => s.moveCursor(120, 50)],
          [450, () => { s.click(); input.classList.add('focus'); }],
          ...Array.from({ length: 6 }, () => [160, () => { input.textContent += '•'; }]),
          [400, () => s.moveCursor(170, 88)],
          [500, () => { s.click(); s.press(go); input.classList.remove('focus'); }],
          [400, () => { file.textContent = '🔓'; file.classList.add('ok'); }],
          [300, () => status.show('풀렸어요 · 비밀번호 없이 열려요')],
          [2600, noop],
        ],
      };
    },
    // ② 암호 걸기
    'sec-lock'(stage) {
      const s = stageParts(stage);
      const file = s.put(el('div', 'demo-file', '🔓'), 14, 34, 44, 56);
      const in1 = s.put(el('div', 'demo-input'), 72, 30, 150, 22);
      const in2 = s.put(el('div', 'demo-input'), 72, 58, 150, 22);
      const box = s.put(el('span', 'demo-checkbox'), 72, 90);
      box.append(el('i'), el('span', null, '인쇄'));
      const status = s.badge('', 'wide');
      return {
        reset() {
          file.textContent = '🔓';
          file.classList.remove('locked');
          [in1, in2].forEach((x) => { x.textContent = ''; x.classList.remove('focus'); });
          box.classList.remove('on');
          status.hide();
          s.moveCursor(120, 124);
        },
        steps: [
          [500, () => s.moveCursor(120, 42)],
          [400, () => { s.click(); in1.classList.add('focus'); }],
          ...Array.from({ length: 5 }, () => [140, () => { in1.textContent += '•'; }]),
          [300, () => { in1.classList.remove('focus'); s.moveCursor(120, 70); }],
          [400, () => { s.click(); in2.classList.add('focus'); }],
          ...Array.from({ length: 5 }, () => [140, () => { in2.textContent += '•'; }]),
          [300, () => { in2.classList.remove('focus'); s.moveCursor(82, 100); }],
          [450, () => { s.click(); box.classList.add('on'); }],
          [500, () => { file.textContent = '🔒'; file.classList.add('locked'); status.show('AES-256 · 인쇄만 허용'); }],
          [2600, noop],
        ],
      };
    },

    // ══ 공통: 저장한 파일은 어디로? ══
    'download'(stage) {
      const s = stageParts(stage);
      const save = s.pill('바로 저장', 14, 30, 'primary');
      const toast = s.put(el('div', 'demo-toast'), 38, 132, 190);
      const name = el('span', 'demo-toast-name', '');
      const open = el('b', 'demo-toast-link', '폴더 열기');
      toast.append(el('i', null, '✓'), name, open);
      const folder = s.put(el('span', 'demo-folder', '📁 다운로드 폴더'), 120, 22);
      return {
        reset() {
          name.textContent = `합본_${today()}.pdf`;
          s.at(toast, 38, 136);
          toast.classList.remove('show');
          open.classList.remove('hit');
          folder.classList.remove('show');
          s.moveCursor(150, 124);
        },
        steps: [
          [500, () => s.moveCursor(50, 40)],
          [550, () => { s.click(); s.press(save); }],
          [350, () => { toast.classList.add('show'); s.at(toast, 38, 76); }],
          [900, () => s.moveCursor(190, 100)],
          [550, () => { s.click(); open.classList.add('hit'); }],
          [350, () => folder.classList.add('show')],
          [2600, noop],
        ],
      };
    },
  };

  root.GuideAnim = {
    W,
    stageParts,
    timeline,
    names: Object.keys(DEMOS),
    /** 무대에 예시를 만든다 */
    create(stage, name) {
      const build = DEMOS[name];
      if (!build) throw new Error(`알 수 없는 예시: ${name}`);
      return timeline(stage, build);
    },
  };
})(typeof self !== 'undefined' ? self : this);
