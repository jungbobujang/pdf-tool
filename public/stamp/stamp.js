/* 도장 만들기 화면. app.js가 도구를 처음 열 때 이 파일(과 stamp-core.js)을 불러와 StampTool.mount(api)를 부른다.
 * 이름은 이 화면 안에서만 그린다 — 서버로 보내는 코드가 없다. 글꼴 조각만 이 사이트(/vendor/stamp-fonts)에서 받는다.
 * 화면에 넣는 글은 모두 textContent로(innerHTML 없음), 모양은 CSS 파일과 CSSOM(el.style)으로만(style 속성 없음). */
(function () {
  'use strict';
  const C = self.StampCore;
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids) if (c != null && c !== false) n.append(c);
    return n;
  }

  // 이름 · 부서를 비워 두면 이 예시로 보여 주기만 한다(저장 · 복사 · 찍기는 막는다)
  const SAMPLE = { name: '김하늘', dTop: '교무부', dBottom: '김하늘' };
  const MAX_MINE = 30;

  let api = null;
  let st = null;
  let view = 'pick';
  const open = {};
  let fontData = null;
  let has = () => true;
  let fontsOk = false;
  let mcache = {};
  const mctx = document.createElement('canvas').getContext('2d');
  let toastTimer = 0;
  // [한자 더 보기]: 자료(public/stamp/hanja.json, 약 110KB)는 한자로 바꿀 때만 받는다
  let hanjaData = null;
  let hanjaLoad = null;
  const moreOpen = {};
  const moreQuery = {};
  const moreAll = {};
  const MORE_FIRST = 24;
  function loadHanja() {
    if (hanjaLoad) return hanjaLoad;
    hanjaLoad = fetch(`stamp/hanja.json?v=${encodeURIComponent(api.ver)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { hanjaData = json; if (st.mode === 'hanja') renderHanja(); })
      .catch(() => { hanjaLoad = null; });
    return hanjaLoad;
  }

  const say = (title, fix = '', kind = 'info') => api.toast(title, fix, kind);
  const dpr = () => Math.min(2, window.devicePixelRatio || 1);

  // 지금 그릴 상태: 비어 있으면 예시로
  function eff() {
    if (st.kind === 'name' && !C.syllables(st).length) return { s: { ...st, name: SAMPLE.name, picks: {} }, sample: true };
    if (st.kind === 'date' && !st.dTop && !st.dBottom) return { s: { ...st, dTop: SAMPLE.dTop, dBottom: SAMPLE.dBottom }, sample: true };
    return { s: st, sample: false };
  }
  const cur = (extra = {}) => {
    const o = { shape: st.shape, style: st.style, font: st.font, border: st.border, ...extra };
    o.key = o.key || [o.shape, o.style, o.font, o.border].join('|');
    return o;
  };
  const textOf = (s) => (s.kind === 'date' ? `${s.dTop}${s.dDate}${s.dBottom}` : C.glyphs(s).join('') + (s.mode === 'hanja' ? '印' : '인'));
  const fontsHaving = (s) => {
    const t = textOf(s);
    const all = C.fontsFor(s);
    const ok = all.filter((f) => has(f.id, t));
    return ok.length ? ok : all;
  };

  function measure(f, s) {
    const k = `${f.id}|${s}`;
    if (mcache[k]) return mcache[k];
    mctx.font = C.fontCss(f);
    const m = mctx.measureText(s);
    const L = m.actualBoundingBoxLeft || 0;
    const R = m.actualBoundingBoxRight || m.width || 100;
    const A = m.actualBoundingBoxAscent || 80;
    const D = m.actualBoundingBoxDescent || 20;
    const r = { w: Math.max(1, L + R), h: Math.max(1, A + D), cx: (R - L) / 2, cy: (D - A) / 2 };
    mcache[k] = r;
    return r;
  }
  /** 캔버스 하나에 도장을 그린다(cssH: 화면 높이 px, 또는 mm 문자열) */
  function paint(canvas, s, o, cssH, unit = 'px') {
    const d = C.design(s, o, measure);
    const hPx = unit === 'mm' ? (cssH / 25.4) * 96 : cssH;
    const k = (hPx * dpr()) / 200;
    canvas.width = Math.max(1, Math.round(d.W * k));
    canvas.height = Math.max(1, Math.round(200 * k));
    canvas.style.width = `${(d.W / 200) * cssH}${unit}`;
    canvas.style.height = `${cssH}${unit}`;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    C.render(ctx, d, k);
    return d;
  }

  // ── 글꼴 ──────────────────────────────────────────────────────
  async function loadFontData() {
    const r = await fetch(`stamp/fonts.json?v=${encodeURIComponent(api.ver)}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`글꼴 목록 ${r.status}`);
    fontData = await r.json();
    has = C.coverage(fontData);
    if (!(self.FontFace && document.fonts && document.fonts.add)) return;
    for (const f of C.fontFaces(fontData, '/vendor/stamp-fonts')) {
      try {
        const desc = { weight: f.weight, display: 'swap' };
        if (f.range) desc.unicodeRange = f.range;
        document.fonts.add(new FontFace(f.family, `url(${f.url})`, desc));
      } catch { /* 이 조각만 빼고 계속 */ }
    }
    fontsOk = true;
  }
  let loadTimer = 0;
  let loadSeq = 0;
  /** 화면에 쓰는 글자가 든 조각만 받고, 받으면 다시 그린다 */
  function fetchFonts() {
    clearTimeout(loadTimer);
    if (!fontsOk) return;
    const my = ++loadSeq;
    loadTimer = setTimeout(() => {
      const { s } = eff();
      const text = `${textOf(s)}${C.glyphs(s).join('')}인印`;
      Promise.all(C.fontsFor(s).map((f) => document.fonts.load(C.fontCss(f), text).catch(() => null)))
        .then(() => { if (my === loadSeq) { mcache = {}; renderAll(); renderShelf(); } });
    }, 120);
  }
  /** 저장 · 복사 직전: 고른 글꼴이 다 왔는지 */
  function fontReady(s) {
    if (!fontsOk) return Promise.resolve();
    const f = C.fontById(st.font);
    return Promise.all([document.fonts.load(C.fontCss(f), textOf(s) || '가'), document.fonts.load(C.fontCss(C.fontById('serif')), textOf(s) || '가')])
      .catch(() => null).then(() => { mcache = {}; });
  }

  // ── 고르는 판(오른쪽) ─────────────────────────────────────────
  function designs(s) {
    const fonts = fontsHaving(s).map((f) => f.id);
    const shapes = s.kind === 'date' ? ['circle', 'round'] : ['circle', 'oval', 'square', 'round'];
    if (view === 'fonts') return C.fontsFor(s).map((f) => cur({ font: f.id, g: f.g }));
    if (view === 'shapes') {
      const a = [];
      for (const sh of shapes) for (const b of ['single', 'double']) for (const y of ['yang', 'eum']) a.push(cur({ shape: sh, border: b, style: y }));
      return a;
    }
    const seen = new Set();
    const out = [];
    C.PICKS.forEach((p, n) => {
      const font = fonts.includes(p[2]) ? p[2] : fonts[n % fonts.length];
      const shape = shapes.includes(p[0]) ? p[0] : shapes[n % shapes.length];
      const o = { shape, style: p[1], font, border: p[3] };
      o.key = [o.shape, o.style, o.font, o.border].join('|');
      if (!seen.has(o.key)) { seen.add(o.key); out.push(o); }
    });
    return out;
  }
  function renderGrid() {
    const { s, sample } = eff();
    const grid = $('st-grid');
    for (const v of ['pick', 'fonts', 'shapes']) $(`st-v-${v}`).setAttribute('aria-pressed', String(view === v));
    $('st-v-fonts').textContent = `글꼴 모아 보기 (${C.fontsFor(s).length})`;
    $('st-tray-note').textContent = {
      pick: '자주 고르는 조합이에요. 누르면 왼쪽 작업대로 가요.',
      fonts: '지금 모양 · 테두리 · 새김 그대로 글꼴만 바꿔 보여요.',
      shapes: '지금 글꼴 그대로 모양 · 테두리 · 새김을 모두 보여요.',
    }[view];
    grid.classList.toggle('sample', sample);
    const list = designs(s);
    const curKey = cur().key;
    const text = textOf(s);
    const frag = document.createDocumentFragment();
    let lastG = '';
    for (const o of list) {
      const f = C.fontById(o.font);
      if (view === 'fonts' && o.g !== lastG) { frag.append(el('p', { class: 'st-ghead', text: o.g })); lastG = o.g; }
      const missing = !has(o.font, text);
      const lb = view === 'fonts'
        ? `${f.name}${missing ? ' · 없는 글자 있음' : f.hanja && s.mode === 'hangul' && s.kind === 'name' ? ' · 한자도 됨' : ''}`
        : view === 'shapes' ? `${C.nameOf(C.SHAPES, o.shape)} · ${C.nameOf(C.BORDERS, o.border)} · ${C.nameOf(C.STYLES, o.style).replace(/\(.*\)/, '')}` : C.describe(o);
      const cv = el('canvas', { 'aria-hidden': 'true' });
      const b = el('button', { type: 'button', class: `st-card${missing ? ' missing' : ''}`, 'aria-pressed': String(o.key === curKey), 'aria-label': `${C.describe(o)}${missing ? ' (없는 글자는 굵은 명조로)' : ''} 고르기` },
        cv, el('span', { class: 'st-lb', text: lb }));
      b.addEventListener('click', () => { st.shape = o.shape; st.style = o.style; st.font = o.font; st.border = o.border; renderTools(); renderAll(); });
      paint(cv, s, o, 96);
      frag.append(b);
    }
    grid.replaceChildren(frag);
    $('st-count').textContent = `${list.length}개`;
  }

  // ── 작업대(왼쪽) ──────────────────────────────────────────────
  function fixFontForMode() {
    const f = C.fontById(st.font);
    if ((st.mode === 'hanja' && st.kind === 'name' && !f.hanja) || ((st.mode === 'hangul' || st.kind === 'date') && f.hanjaOnly)) st.font = 'serif';
    if (st.kind === 'date' && (st.shape === 'oval' || st.shape === 'square')) st.shape = 'circle';
  }
  function renderBig() {
    fixFontForMode();
    const { s, sample } = eff();
    const d = paint($('st-big'), s, cur({ key: 'big' }), 140);
    $('st-big').setAttribute('aria-label', `고른 도장 크게 보기: ${d.label}${sample ? '(예시)' : ''}`);
    paint($('st-slip-stamp'), s, cur({ key: 'big' }), st.size, 'mm');
    $('st-sample').hidden = !sample;
    if (st.kind === 'date') {
      $('st-slip-head').textContent = '공문 접수';
      $('st-slip-body').textContent = '2026학년도 과학의 달 행사 운영 계획(안)';
      $('st-slip-date').textContent = `처리: ${s.dTop || ''}`;
      $('st-slip-who').textContent = '접수';
      $('st-slip-name').textContent = '';
    } else {
      $('st-slip-head').textContent = '가정통신문 회신';
      $('st-slip-body').textContent = '위 내용을 확인하였으며 참여에 동의합니다.';
      const t = new Date();
      $('st-slip-date').textContent = `${t.getFullYear()}년 ${t.getMonth() + 1}월 ${t.getDate()}일`;
      $('st-slip-who').textContent = '보호자';
      $('st-slip-name').textContent = C.syllables(s).join('');
    }
    const mm = Math.round(st.size * 10) / 10;
    $('st-slip-size').textContent = `실제 크기 미리 보기: ${st.shape === 'oval' ? '세로' : '지름'} ${mm}mm (화면에 따라 조금 다를 수 있어요)`;
    const px = C.pixelSize(st, d.W);
    $('st-png-small').textContent = `투명 배경 · ${mm}mm · ${st.dpi}dpi = ${px.w}×${px.h}px`;
    $('st-copy-small').textContent = `한글 · 워드에서 Ctrl+V · ${mm}mm · 투명`;
    $('st-big-label').textContent = `${C.describe(cur())} · ${st.ink === 'custom' ? `직접 고른 색 ${st.inkHex}` : C.nameOf(C.INKS, st.ink)}${st.style === 'eum' ? ' — 흰 글씨(음각)는 낙관 느낌이에요. 이름 도장은 보통 양각.' : ''}`;
    // 이 글꼴에 없는 글자
    const t = textOf(s).replace(/[인印]$/, '');
    const miss = Array.from(new Set(Array.from(t).filter((ch) => ch.trim() && !has(st.font, ch))));
    const gw = $('st-glyph-warn');
    gw.hidden = !miss.length;
    gw.textContent = miss.length ? `${C.fontById(st.font).name}에는 '${miss.join("' '")}' 글자가 없어 굵은 명조로 그려요. [글꼴 모아 보기]에서 다른 글꼴을 골라 보세요.` : '';
  }
  // 고르기 단추 + [직접] 숫자
  function segFill(host, items, key, after, custom) {
    const box = $(host);
    const isPreset = items.some((it) => it.id === st[key]);
    const kids = [];
    for (const it of items) {
      if (st.kind === 'date' && key === 'shape' && (it.id === 'oval' || it.id === 'square')) continue;
      const b = el('button', { type: 'button', 'aria-pressed': String(st[key] === it.id), text: it.name });
      b.addEventListener('click', () => { st[key] = it.id; open[key] = false; if (after) after(); renderTools(); renderAll(); });
      kids.push(b);
    }
    if (custom) {
      const on = open[key] || !isPreset;
      const d = el('button', { type: 'button', class: on ? 'st-direct on' : 'st-direct', 'aria-expanded': String(on), text: '직접' });
      d.addEventListener('click', () => {
        open[key] = !on;
        renderTools();
        if (open[key]) { const x = $(host).querySelector('input'); if (x) { x.focus(); x.select(); } }
      });
      kids.push(d);
      if (on) {
        const now = typeof st[key] === 'number' ? st[key] : custom.def;
        const inp = el('input', { type: 'number', inputmode: 'decimal', min: custom.min, max: custom.max, step: custom.step, value: now, 'aria-label': `${custom.label} 직접 입력(${custom.min}~${custom.max}${custom.unit})` });
        const apply = (final) => {
          const v = parseFloat(inp.value);
          if (Number.isNaN(v)) { if (final) inp.value = now; return; }
          const c = Math.min(custom.max, Math.max(custom.min, v));
          if (final && c !== v) { inp.value = c; say(`${custom.label}: ${custom.min}~${custom.max}${custom.unit} 사이로 맞췄어요.`); }
          st[key] = c;
          if (after) after();
          renderAll();
          box.querySelectorAll('button[aria-pressed]').forEach((bb) => bb.setAttribute('aria-pressed', 'false'));
        };
        inp.addEventListener('input', () => apply(false));
        inp.addEventListener('change', () => apply(true));
        kids.push(el('label', { class: 'st-custom' }, inp, el('span', { text: custom.unit })));
      }
    }
    box.replaceChildren(...kids);
  }
  function syncFinish() {
    $('st-stamp-opts').hidden = st.finish !== 'stamp';
    $('st-restamp').hidden = st.finish !== 'stamp';
  }
  function renderTools() {
    segFill('st-t-shape', C.SHAPES, 'shape');
    segFill('st-t-border', C.BORDERS, 'border');
    segFill('st-t-style', C.STYLES, 'style');
    segFill('st-t-bw', C.BWS, 'bwPct', null, { min: 1, max: 8, step: 0.1, def: 3.5, unit: '%', label: '선 굵기' });
    segFill('st-t-weight', C.WEIGHTS, 'weight', null, { min: 0, max: 5, step: 0.25, def: 0.5, unit: '단계', label: '글씨 굵기' });
    segFill('st-t-space', C.SPACES, 'space', null, { min: -3, max: 5, step: 0.25, def: 0.5, unit: '단계', label: '간격' });
    segFill('st-t-size', C.SIZES, 'size', null, { min: 5, max: 60, step: 0.5, def: 13.5, unit: 'mm', label: '크기' });
    segFill('st-t-dpi', C.DPIS, 'dpi', null, { min: 150, max: 1200, step: 50, def: 450, unit: 'dpi', label: '저장 선명도' });
    segFill('st-t-finish', C.FINISH, 'finish', syncFinish);
    syncFinish();
    const kids = C.INKS.map((it) => {
      const dot = el('i');
      dot.style.background = it.c;
      const b = el('button', { type: 'button', class: 'st-ink', title: it.name, 'aria-label': it.name, 'aria-pressed': String(st.ink === it.id) }, dot);
      b.addEventListener('click', () => { st.ink = it.id; renderTools(); renderAll(); });
      return b;
    });
    const ci = el('input', { type: 'color', value: st.inkHex, 'aria-label': '색 직접 고르기' });
    ci.addEventListener('input', () => {
      st.inkHex = ci.value;
      st.ink = 'custom';
      renderAll();
      $('st-t-ink').querySelectorAll('.st-ink').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      ci.parentElement.classList.add('on');
    });
    kids.push(el('label', { class: `st-custom st-color${st.ink === 'custom' ? ' on' : ''}` }, ci, el('span', { text: '직접' })));
    $('st-t-ink').replaceChildren(...kids);
    const dateKind = st.kind === 'date';
    $('st-t-space').hidden = dateKind;
    $('st-l-space').hidden = dateKind;
    $('st-rough').value = Math.round(st.rough * 100);
    $('st-rough-out').textContent = String(Math.round(st.rough * 100));
    $('st-tilt').value = st.tilt;
    $('st-tilt-out').textContent = `${st.tilt}°`;
  }
  function renderHanja() {
    const box = $('st-hanja');
    box.hidden = st.mode !== 'hanja' || st.kind !== 'name';
    if (box.hidden) return;
    const rows = [el('p', { class: 'st-note', text: '글자마다 한자를 골라요. 목록에 없으면 오른쪽 칸에 한글을 쓰고 [한자] 키로 바꿔 넣거나, 한자를 붙여 넣어요.' })];
    C.syllables(st).forEach((c, i) => {
      const cand = C.HJ[c] || [];
      let pick = st.picks[i + c];
      if (pick === undefined) pick = cand.length ? cand[0][0] : null;
      const chips = cand.map(([hj, mean]) => {
        const b = el('button', { type: 'button', class: 'st-chip', 'aria-pressed': String(pick === hj), 'aria-label': `${hj} (${mean})` }, el('b', { text: hj }), el('small', { text: mean }));
        b.addEventListener('click', () => { st.picks[i + c] = hj; update(); });
        return b;
      });
      const keep = el('button', { type: 'button', class: 'st-chip st-chip-hangul', 'aria-pressed': String(pick === null) }, el('b', { text: c }), el('small', { text: cand.length ? '한글 그대로' : '목록에 없어요' }));
      keep.addEventListener('click', () => { st.picks[i + c] = null; update(); });
      const allMore = C.moreHanja(hanjaData, c, cand.map((h) => h[0]));
      const own = pick && !cand.some((h) => h[0] === pick) && !allMore.some((h) => h[0] === pick) ? pick : '';
      const di = el('input', { type: 'text', maxlength: '2', class: own ? 'on' : null, value: own, 'aria-label': `${c} 한자 직접 넣기`, autocomplete: 'off' });
      di.addEventListener('change', () => {
        const v = Array.from(di.value.trim())[0] || '';
        if (!v) { delete st.picks[i + c]; update(); return; }
        if (!/\p{Script=Han}/u.test(v)) { say('한자만 넣을 수 있어요.', '한글을 쓰고 [한자] 키를 눌러 바꿔 넣어 보세요.'); di.value = own; return; }
        st.picks[i + c] = v;
        update();
      });
      const key = i + c;
      // 고른 한자가 [더 보기] 안에 있으면 처음부터 펼쳐 둔다
      if (pick && allMore.some((h) => h[0] === pick) && moreOpen[key] === undefined) moreOpen[key] = true;
      const q = el('input', { type: 'text', id: `st-more-q-${i}`, value: moreQuery[key] || '', autocomplete: 'off', spellcheck: 'false' });
      const moreList = el('div', { class: 'st-more-list' });
      const moreArea = el('div', { class: 'st-more', id: `st-more-${i}` },
        el('label', { class: 'st-field st-more-find' }, el('span', { text: `'${c}' 한자를 뜻으로 찾기 (예: 물, 빛날, 클)` }), q), moreList);
      const moreBtn = allMore.length ? el('button', { type: 'button', class: 'st-more-btn', 'aria-expanded': String(!!moreOpen[key]), 'aria-controls': `st-more-${i}` },
        el('span', { text: moreOpen[key] ? '한자 접기' : `한자 더 보기 (${allMore.length})` })) : null;
      if (moreBtn) {
        moreBtn.addEventListener('click', () => { moreOpen[key] = !moreOpen[key]; renderHanja(); if (moreOpen[key]) { const box2 = $(`st-more-q-${i}`); if (box2) box2.focus(); } });
      }
      const paintMore = () => {
        moreArea.hidden = !moreOpen[key];
        if (moreArea.hidden) return;
        const found = C.moreHanja(hanjaData, c, cand.map((h) => h[0]), moreQuery[key] || '');
        const shown = moreAll[key] ? found : found.slice(0, MORE_FIRST);
        const list = shown.map(([hj, mean]) => {
          const b = el('button', { type: 'button', class: 'st-chip', 'aria-pressed': String(pick === hj), 'aria-label': `${hj} (${mean || '뜻 없음'})` }, el('b', { text: hj }), el('small', { text: mean || ' ' }));
          b.addEventListener('click', () => { st.picks[key] = hj; update(); });
          return b;
        });
        const rest = found.length - shown.length;
        const restBtn = rest > 0 ? el('button', { type: 'button', class: 'st-more-btn', text: `${rest}개 더` }) : null;
        if (restBtn) restBtn.addEventListener('click', () => { moreAll[key] = true; paintMore(); });
        moreList.replaceChildren(found.length ? el('div', { class: 'st-chips' }, ...list, restBtn)
          : el('p', { class: 'st-note', text: '찾는 뜻의 한자가 없어요. 다른 말로 찾거나 위 [직접] 칸에 넣어요.' }));
      };
      q.addEventListener('input', () => { moreQuery[key] = q.value; moreAll[key] = false; paintMore(); });
      paintMore();
      rows.push(el('div', { class: 'st-syl' }, el('span', { class: 'st-s', text: c }),
        el('div', { class: 'st-syl-body' },
          el('div', { class: 'st-chips' }, ...chips, keep, el('label', { class: 'st-own' }, di, el('span', { text: '직접' })), moreBtn),
          moreArea)));
    });
    if (!hanjaData) loadHanja();
    box.replaceChildren(...rows);
  }
  function renderAll() { renderBig(); renderGrid(); }

  function update() {
    const raw = ($('st-name').value || '').replace(/\s/g, '');
    st.name = raw;
    const warn = $('st-name-warn');
    const extra = raw.replace(/[가-힣]/g, '');
    const n = Array.from(raw.replace(/[^가-힣]/g, '')).length;
    if (extra) { warn.hidden = false; warn.textContent = `한글만 새겨요. "${extra}"는 빼고 보여 드려요.`; }
    else if (n > 4) { warn.hidden = false; warn.textContent = '도장은 4글자까지예요. 앞 4글자로 보여 드려요.'; }
    else warn.hidden = true;
    renderHanja();
    $('st-sq3').hidden = !(C.syllables(st).length === 3 && !st.seal);
    renderAll();
    fetchFonts();
  }
  function renderKind() {
    $('st-k-name').setAttribute('aria-pressed', String(st.kind === 'name'));
    $('st-k-date').setAttribute('aria-pressed', String(st.kind === 'date'));
    $('st-name-fields').hidden = st.kind !== 'name';
    $('st-date-fields').hidden = st.kind !== 'date';
    $('st-kind-note').textContent = st.kind === 'name' ? '회신서 · 동의서 · 확인서 서명란에 찍는 도장' : '공문 접수 · 제출물 확인에 찍는 3단 도장(부서 · 날짜 · 이름)';
  }
  function setMode(m) {
    st.mode = m;
    $('st-mode-hangul').setAttribute('aria-pressed', String(m === 'hangul'));
    $('st-mode-hanja').setAttribute('aria-pressed', String(m === 'hanja'));
    $('st-seal').textContent = m === 'hanja' ? "끝에 '印' 붙이기" : "끝에 '인' 붙이기";
    update();
  }
  /** 보관한 도장의 설정을 화면에 되살린다 */
  function load(config) {
    st = C.restoreState(config);
    $('st-name').value = st.name;
    $('st-seal').setAttribute('aria-pressed', String(st.seal));
    $('st-sq3-in').setAttribute('aria-pressed', String(st.sq3 === 'in'));
    $('st-sq3-long').setAttribute('aria-pressed', String(st.sq3 === 'long'));
    $('st-d-top').value = st.dTop;
    $('st-d-bottom').value = st.dBottom;
    $('st-d-date').value = st.dDate;
    for (const k of Object.keys(open)) delete open[k];
    renderKind();
    renderTools();
    setMode(st.mode);
  }

  // ── 만들기: PNG · 복사 · 보관 · PDF에 찍기 ─────────────────────
  function needReal() {
    if (!eff().sample) return true;
    say(st.kind === 'date' ? '위 줄 · 아래 줄을 먼저 써 주세요.' : '이름을 먼저 써 주세요.', '지금 보이는 것은 예시예요.');
    (st.kind === 'date' ? $('st-d-top') : $('st-name')).focus();
    return false;
  }
  async function makeImage() {
    const s = st;
    await fontReady(s);
    const d = C.design(s, cur({ key: 'big' }), measure);
    const px = C.pixelSize(s, d.W);
    const c = document.createElement('canvas');
    c.width = px.w;
    c.height = px.h;
    C.render(c.getContext('2d'), d, px.h / 200);
    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('그림을 만들지 못했어요'))), 'image/png'));
    const bytes = C.pngWithDpi(new Uint8Array(await blob.arrayBuffer()), s.dpi);
    return { bytes, w: px.w, h: px.h, wMm: px.wMm, hMm: px.hMm, label: d.label };
  }
  const mmText = () => `${Math.round(st.size * 10) / 10}mm`;
  async function savePng() {
    if (!needReal()) return;
    try {
      const img = await makeImage();
      api.download(img.bytes, `도장_${C.fileSafe(img.label)}_${mmText()}.png`, 'image/png');
    } catch (e) { say('PNG를 만들지 못했어요.', '저장 선명도를 낮춰 다시 해 보세요.', 'error'); console.warn(e); }
  }
  function copyStamp(plain) {
    if (!needReal()) return;
    if (!(navigator.clipboard && navigator.clipboard.write && self.ClipboardItem)) {
      say('이 브라우저에서는 그림 복사가 안 돼요.', '[PNG 저장]으로 저장한 뒤 문서에 넣어 주세요. 크롬 · 엣지 · 웨일에서는 복사가 돼요.');
      return;
    }
    // 클립보드 쓰기는 누른 그 순간에 시작해야 해서, 그림은 약속(Promise)으로 넘긴다
    const made = makeImage();
    const png = made.then((o) => new Blob([o.bytes], { type: 'image/png' }));
    const item = { 'image/png': png };
    if (!plain) {
      item['text/html'] = made.then((o) => new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => {
          const w = Math.round((o.wMm / 25.4) * 96);
          const h = Math.round((o.hMm / 25.4) * 96);
          // 크기는 width · height(96dpi 기준 px = 고른 mm)로만 적는다. style 속성은 브라우저가 이 화면의 보안 규칙(CSP)으로 막는다
          res(new Blob([`<img src="${fr.result}" width="${w}" height="${h}" alt="도장">`], { type: 'text/html' }));
        };
        fr.readAsDataURL(new Blob([o.bytes], { type: 'image/png' }));
      }));
    }
    navigator.clipboard.write([new ClipboardItem(item)]).then(() => {
      say(plain ? '그림만 복사했어요.' : `복사했어요 · ${mmText()} · 투명 배경`,
        plain ? `붙인 뒤 크기가 크면 그림 속성에서 높이를 ${mmText()}로 맞춰 주세요.` : '한글 · 워드 서명란에서 Ctrl+V 하세요.', 'ok');
      $('st-copy-alt').hidden = false;
    }, () => {
      say('복사가 막혔어요.', '다시 눌러 보거나 [그림만 복사] · [PNG 저장]을 써 보세요.');
      $('st-copy-alt').hidden = false;
    });
  }
  const configKey = (s) => JSON.stringify(C.pickState(s));
  /** 같은 설정이 보관돼 있으면 그것을, 없으면 새로 보관 */
  async function keep({ quiet = false } = {}) {
    const key = configKey(st);
    const mine = (await api.Stamps.list()).filter((x) => x.kind === 'made');
    const same = mine.find((x) => x.configKey === key);
    if (same) { if (!quiet) say('이미 내 도장에 있어요.', `"${same.name}"`); return same; }
    if (mine.length >= MAX_MINE) { say(`내 도장은 ${MAX_MINE}개까지 보관해요.`, '아래 내 도장에서 안 쓰는 것을 지운 뒤 다시 해 주세요.'); return null; }
    const img = await makeImage();
    const it = await api.Stamps.add({ kind: 'made', bytes: img.bytes, w: img.w, h: img.h, mm: img.wMm, name: `${img.label} ${mmText()}`, config: C.pickState(st), configKey: key, clearWhite: false });
    if (!quiet) {
      say('내 도장에 보관했어요.', api.Stamps.shared && api.Stamps.shared()
        ? '빌려 쓰는 PC라 이 창에만 둬요. 창을 닫으면 지워져요. 꾸미기의 서명 · 도장에서는 바로 골라요.'
        : '이 브라우저에만 남아요. 꾸미기의 서명 · 도장에서도 바로 골라요.', 'ok');
    }
    return it;
  }
  async function toPdf() {
    if (!needReal()) return;
    try {
      const it = await keep({ quiet: true });
      if (!it) return;
      api.useInDecor(it.id);
    } catch (e) { say('도장을 넘기지 못했어요.', '다시 눌러 주세요.', 'error'); console.warn(e); }
  }
  async function renderShelf() {
    if (!api) return;
    const mine = (await api.Stamps.list()).filter((x) => x.kind === 'made');
    const items = await Promise.all(mine.map(async (it) => {
      const img = el('img', { alt: '', src: await api.Stamps.urlOf(it) });
      const b = el('button', { type: 'button', class: 'st-mine', 'aria-label': `${it.name} 불러오기`, title: it.name }, img);
      b.addEventListener('click', () => { load(it.config); say('내 도장을 불러왔어요.', it.name, 'ok'); });
      const x = el('button', { type: 'button', class: 'st-mine-x', 'aria-label': `${it.name} 지우기`, title: '이 브라우저에서 지우기', text: '×' });
      x.addEventListener('click', async () => { await api.Stamps.remove(it.id); say(`"${it.name}"을(를) 지웠어요.`); });
      return el('li', null, b, x);
    }));
    $('st-shelf').replaceChildren(...items);
    $('st-shelf-empty').hidden = mine.length > 0;
  }

  // ── 연결 ──────────────────────────────────────────────────────
  function wire() {
    $('st-k-name').addEventListener('click', () => { st.kind = 'name'; renderKind(); renderTools(); update(); });
    $('st-k-date').addEventListener('click', () => {
      st.kind = 'date';
      if (st.shape === 'oval' || st.shape === 'square') st.shape = 'circle';
      if (st.font === 'brush' || st.font === 'kai') st.font = 'gothic';
      renderKind(); renderTools(); update();
    });
    $('st-mode-hangul').addEventListener('click', () => setMode('hangul'));
    $('st-mode-hanja').addEventListener('click', () => setMode('hanja'));
    $('st-name').addEventListener('input', () => { st.picks = {}; update(); });
    $('st-seal').addEventListener('click', () => { st.seal = !st.seal; $('st-seal').setAttribute('aria-pressed', String(st.seal)); update(); });
    $('st-sq3-in').addEventListener('click', () => { st.sq3 = 'in'; $('st-sq3-in').setAttribute('aria-pressed', 'true'); $('st-sq3-long').setAttribute('aria-pressed', 'false'); renderAll(); });
    $('st-sq3-long').addEventListener('click', () => { st.sq3 = 'long'; $('st-sq3-long').setAttribute('aria-pressed', 'true'); $('st-sq3-in').setAttribute('aria-pressed', 'false'); renderAll(); });
    for (const [id, key] of [['st-d-top', 'dTop'], ['st-d-bottom', 'dBottom'], ['st-d-date', 'dDate']]) {
      $(id).addEventListener('input', () => { st[key] = $(id).value.trim(); update(); });
    }
    $('st-d-today').addEventListener('click', () => { st.dDate = C.dotDate(new Date()); $('st-d-date').value = st.dDate; update(); });
    for (const v of ['pick', 'fonts', 'shapes']) $(`st-v-${v}`).addEventListener('click', () => { view = v; renderGrid(); });
    $('st-restamp').addEventListener('click', () => { st.restamp++; renderAll(); });
    $('st-rough').addEventListener('input', () => { st.rough = $('st-rough').value / 100; $('st-rough-out').textContent = $('st-rough').value; renderAll(); });
    $('st-tilt').addEventListener('input', () => { st.tilt = Number($('st-tilt').value); $('st-tilt-out').textContent = `${$('st-tilt').value}°`; renderAll(); });
    $('st-copy-plain').addEventListener('click', () => copyStamp(true));
    $('st-keys-btn').addEventListener('click', () => {
      const box = $('st-keys');
      box.hidden = !box.hidden;
      $('st-keys-btn').setAttribute('aria-expanded', String(!box.hidden));
    });
    document.querySelectorAll('[data-st-act]').forEach((b) => b.addEventListener('click', () => {
      const a = b.getAttribute('data-st-act');
      if (a === 'copy') copyStamp(false);
      else if (a === 'png') savePng();
      else if (a === 'keep') { if (needReal()) keep().catch((e) => { say('보관하지 못했어요.', '', 'error'); console.warn(e); }); }
      else if (a === 'pdf') toPdf();
    }));
    api.Stamps.onChange(() => renderShelf());
    // 단축키: 이 도구가 열려 있고, 글을 쓰는 칸 · 대화상자가 아닐 때만
    document.addEventListener('keydown', (e) => {
      if (!api.isActive() || document.querySelector('dialog[open]')) return;
      const tg = e.target && e.target.tagName;
      const typing = tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT' || (e.target && e.target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'c' && !typing && (!window.getSelection || window.getSelection().isCollapsed)) {
        e.preventDefault();
        copyStamp(false);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      let handled = true;
      const shapes = st.kind === 'date' ? ['circle', 'round'] : ['circle', 'oval', 'square', 'round'];
      if (k >= '1' && k <= '4' && shapes[Number(k) - 1]) st.shape = shapes[Number(k) - 1];
      else if (k === 'b' || k === 'B') st.border = st.border === 'single' ? 'double' : 'single';
      else if (k === 'e' || k === 'E') st.style = st.style === 'yang' ? 'eum' : 'yang';
      else if (k === '[' || k === ']') {
        const fs = C.fontsFor(eff().s);
        let n = fs.findIndex((f) => f.id === st.font);
        n = (n + (k === ']' ? 1 : -1) + fs.length) % fs.length;
        st.font = fs[n].id;
      } else if (k === '-' || k === '+' || k === '=') st.size = Math.min(60, Math.max(5, (Number(st.size) || 15) + (k === '-' ? -0.5 : 0.5)));
      else if ((k === 'r' || k === 'R') && st.finish === 'stamp') st.restamp++;
      else if (k === 'k' || k === 'K') { if (needReal()) keep().catch(() => {}); e.preventDefault(); return; }
      else handled = false;
      if (handled) {
        e.preventDefault();
        renderTools();
        renderAll();
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => say(`${C.describe(cur())} · ${mmText()}`), 250);
      }
    });
  }

  let mounted = null;
  /** api: {toast, download, Stamps, useInDecor(id), isActive(), ver} */
  function mount(a) {
    if (mounted) return mounted;
    api = a;
    st = C.defaultState(new Date());
    $('st-d-date').value = st.dDate;
    wire();
    renderKind();
    renderTools();
    update();
    renderShelf();
    $('st-loading').hidden = true;
    $('st-app').hidden = false;
    mounted = loadFontData().then(() => fetchFonts()).catch((e) => {
      console.warn(e);
      say('도장 글꼴을 받지 못했어요.', '인터넷 연결을 확인하고 새로 고침해 주세요. 그동안은 기본 글꼴로 보여요.', 'error');
    });
    return mounted;
  }
  self.StampTool = {
    mount,
    save: () => savePng(),
    /** 검사용: 상태 엿보기(이름 같은 값은 돌려주지 않는다) */
    state: () => ({ ready: !!fontsOk, view, kind: st && st.kind, font: st && st.font, shape: st && st.shape, size: st && st.size, sample: st ? eff().sample : null, cards: document.querySelectorAll('#st-grid .st-card').length }),
  };
})();
