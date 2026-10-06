/* 사진 작업실 — 화면. 사진은 이 브라우저 안에서만 읽고 · 줄이고 · 저장한다(서버로 보내는 코드가 없다).
   처음 쓰는 분은 "무엇을 할까요?"에서 고르고 단추 하나로 끝, 잘 쓰는 분은 [자세히]에서 다 바꾼다. */
(function () {
  'use strict';
  const C = self.PhotoCore;

  // Xschool 도구함에서 통행증이 이미 있는 채로 열리면(#t=입장권) 입장권을 주소에서 지우고 지금 사람 것으로 새로 받는다.
  // (PDF 작업실 app.js와 같은 방법 · 실패해도 지금 통행증으로 계속)
  const ENTERING = (() => {
    const hash = String(location.hash || '');
    const m = hash.match(/^#t=([^&]+)/);
    if (!m) return Promise.resolve();
    const pc = /&pc=shared(?:&|$)/.test(hash) ? 'shared' : 'mine';
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* 계속 */ }
    let ticket = m[1];
    try { ticket = decodeURIComponent(ticket); } catch { /* 그대로 */ }
    try {
      const sent = fetch('/api/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ t: ticket, pc }) }).then(() => {}, () => {});
      return Promise.race([sent, new Promise((r) => setTimeout(r, 6000))]);
    } catch { return Promise.resolve(); }
  })();

  const $ = (id) => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'hidden' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids) if (c != null && c !== false) el.append(c);
    return el;
  }
  const SVG = 'http://www.w3.org/2000/svg';
  function tickIcon() {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', 'M5 12l5 5 9-10');
    s.append(p);
    return s;
  }

  // 빌려 쓰는 PC(Xschool에서 "내 교실 PC"로 정하지 않은 PC)면 설정을 기억하지 않는다
  function cookie(name) {
    try {
      const hit = String(document.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name}=`));
      return hit ? hit.slice(name.length + 1) : '';
    } catch { return ''; }
  }
  const shared = () => cookie('pdf_pc') === 'shared';
  const LAST_KEY = 'pdfws.photo.last';
  function loadLast() {
    if (shared()) return null;
    try { const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); return v && typeof v === 'object' && v.mode ? v : null; } catch { return null; }
  }
  function saveLast(s) {
    if (shared()) return false;
    try { localStorage.setItem(LAST_KEY, JSON.stringify(s)); return true; } catch { return false; }
  }

  let toastTimer = 0;
  function toast(text, kind = '') {
    const t = $('ph-toast');
    t.textContent = text;
    t.className = `ph-toast${kind ? ` ${kind}` : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }

  // ── 상태 ─────────────────────────────────────────────────────
  const state = {
    view: 'home',
    photos: [],
    settings: C.defaultSettings('kakao'),
    more: false,
    fix: 1, // 실제 / 예상 (한 장 만들어 보면 바로잡음)
    busy: false,
    lastRun: null,
    pendingGoal: null,
  };
  let nextId = 1;

  // ── 사진 넣기 ─────────────────────────────────────────────────
  let heicMod = null;
  function heicConverter() {
    if (!heicMod) heicMod = import('/vendor/heic/heic-to.js').catch((e) => { heicMod = null; throw e; });
    return heicMod;
  }
  async function decodeSize(blob) {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const out = { w: bmp.width, h: bmp.height };
    bmp.close && bmp.close();
    return out;
  }
  async function makeThumb(blob) {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: 360, resizeQuality: 'medium' });
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    return out ? URL.createObjectURL(out) : '';
  }
  /** 투명한 곳이 있는 사진인지(작게 그려 본다) */
  async function hasAlpha(blob) {
    try {
      const bmp = await createImageBitmap(blob, { resizeWidth: 64, resizeHeight: 64 });
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      const d = ctx.getImageData(0, 0, 64, 64).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    } catch { /* 모르면 아니라고 */ }
    return false;
  }

  async function addFiles(list) {
    const files = Array.from(list || []).filter((f) => f && f.size > 0);
    if (!files.length) return;
    setBusy(true, `사진 ${files.length}장을 읽는 중…`);
    let added = 0;
    let refused = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setStatus(`사진 읽는 중 (${i + 1}/${files.length})`);
        let head = new Uint8Array(0);
        try { head = new Uint8Array(await f.slice(0, 512 * 1024).arrayBuffer()); } catch { /* 이름으로만 */ }
        let kind = C.detectKind(head, f.name);
        let blob = f;
        let heic = false;
        if (kind === 'heic') {
          try {
            const mod = await heicConverter();
            blob = await mod.heicTo({ blob: f, type: 'image/jpeg', quality: 0.92 });
            kind = 'jpeg';
            heic = true;
            head = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer());
          } catch (e) {
            console.warn(e);
            toast(`"${f.name}": 아이폰 사진을 바꾸지 못했어요. 인터넷 연결을 확인하고 다시 넣어 주세요.`, 'warn');
            refused++;
            continue;
          }
        }
        if (!['jpeg', 'png', 'webp', 'gif', 'bmp'].includes(kind)) { refused++; continue; }
        const exif = kind === 'jpeg' && !heic ? C.readExif(head) : { date: null, gps: false, device: false, orientation: 1 };
        let size = C.imageSize(head, kind);
        try { if (!size || !size.w || !size.h) size = await decodeSize(blob); } catch { refused++; continue; }
        const photo = {
          id: nextId++, name: f.name, blob, kind, heic, srcBytes: f.size, w: size.w, h: size.h, exif,
          thumb: '', on: true, out: null, alpha: null,
        };
        state.photos.push(photo);
        added++;
        makeThumb(blob).then((url) => { photo.thumb = url; paintCard(photo); }).catch(() => {});
      }
    } finally {
      setBusy(false, '');
    }
    if (refused) toast(`사진 ${refused}장은 넣지 못했어요. JPG · PNG · WEBP · HEIC(아이폰) · GIF · BMP를 넣어 주세요.`, 'warn');
    if (added) {
      if (state.pendingGoal) { useGoal(state.pendingGoal); state.pendingGoal = null; } else if (state.view === 'home') show('resize');
      toast(`사진 ${added}장을 넣었어요.`);
      calibrateSoon();
    }
    paint();
  }

  // ── 계산(예상 크기) ───────────────────────────────────────────
  const selected = () => state.photos.filter((p) => p.on);
  function outFmt(p, s = state.settings) {
    if (s.fmt === 'keep') return ['jpeg', 'png', 'webp'].includes(p.kind) ? p.kind : 'jpeg';
    if (s.keepPng && p.alpha === true && s.fmt === 'jpeg') return 'png';
    return s.fmt;
  }
  function plan(s = state.settings) {
    const list = selected();
    const fits = list.map((p) => C.fitSize(p.w, p.h, s));
    let budgets = null;
    if (s.mode === 'all') budgets = C.splitBudget(Number(s.value) * 1024 * 1024, fits.map((f) => f.w * f.h));
    else if (s.mode === 'each') budgets = list.map(() => Number(s.value) * 1024 * 1024);
    const items = list.map((p, i) => {
      const fmt = outFmt(p, s);
      let est = C.estimateBytes(fits[i].w, fits[i].h, s.q, fmt, state.fix);
      if (budgets) est = Math.min(est, budgets[i]);
      return { p, fit: fits[i], fmt, est, budget: budgets ? budgets[i] : 0 };
    });
    const src = list.reduce((a, p) => a + p.srcBytes, 0);
    const est = items.reduce((a, x) => a + (x.p.out ? x.p.out.size : x.est), 0);
    return { items, src, est };
  }

  // ── 그리기 ─────────────────────────────────────────────────────
  function show(view) {
    state.view = view === 'home' ? 'home' : 'resize';
    document.body.dataset.view = state.view;
    $('ph-home').hidden = state.view !== 'home';
    $('ph-work').hidden = state.view === 'home';
    document.querySelectorAll('.ph-rail-item').forEach((b) => {
      if (b.dataset.go === state.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    paint();
  }

  function paintGoals() {
    const ul = $('ph-goal-list');
    ul.replaceChildren(...C.GOALS.map((g) => h('li', null,
      h('button', { type: 'button', class: 'ph-goal', 'data-goal': g.id, disabled: g.soon, onclick: () => pickGoal(g) },
        h('span', { class: 'ph-goal-mark', 'aria-hidden': 'true', text: g.mark }),
        h('span', { class: 'ph-goal-text' },
          h('strong', null, g.title, g.soon ? h('span', { class: 'ph-soon', text: '곧 열려요' }) : null),
          h('span', { text: g.line }))))));
    const last = loadLast();
    $('ph-last').hidden = !last;
    if (last) $('ph-last-line').textContent = C.settingsLine(last);
    $('ph-memory-note').textContent = shared()
      ? '빌려 쓰는 PC라 설정을 기억하지 않아요. 사진도 이 창을 닫으면 사라져요.'
      : '설정은 이 브라우저에만 기억해요. 사진은 기억하지 않아요.';
  }

  function cardFor(p, ests = null) {
    const est = (() => {
      if (!p.on) return '빼 둠';
      if (p.out) return C.sizeText(p.out.size);
      const map = ests || new Map(plan().items.map((x) => [x.p, x.est]));
      return map.has(p) ? `약 ${C.sizeText(map.get(p))}` : '';
    })();
    const fit = C.fitSize(p.w, p.h, state.settings);
    const tick = h('span', { class: 'ph-tick', 'aria-hidden': 'true' }, tickIcon());
    const img = p.thumb ? h('img', { src: p.thumb, alt: '' }) : null;
    const pick = h('button', {
      type: 'button', class: 'ph-card-pick', 'aria-pressed': p.on ? 'true' : 'false',
      'aria-label': `${p.name} ${p.on ? '고름' : '빼 둠'}`,
      onclick: () => { p.on = !p.on; p.out = null; paint(); },
    },
    h('span', { class: 'ph-thumb' }, img, tick,
      p.heic ? h('span', { class: 'ph-badge', text: 'HEIC' }) : null,
      p.exif && p.exif.gps ? h('span', { class: 'ph-badge gps', text: '위치 있음 → 지움' }) : null),
    h('span', { class: 'ph-cap' },
      h('span', { class: 'ph-cap-name', text: p.name }),
      h('span', { class: 'ph-cap-size' }, `${C.sizeText(p.srcBytes)} `, h('span', { 'aria-hidden': 'true', text: '→' }), ' ', h('em', { text: est })),
      h('span', { class: 'ph-cap-px', text: `${p.w} × ${p.h} → ${p.out ? `${p.out.w} × ${p.out.h}` : `${fit.w} × ${fit.h}`}` })));
    const x = h('button', { type: 'button', class: 'ph-card-x', 'aria-label': `${p.name} 목록에서 빼기`, title: '목록에서 빼기', text: '×', onclick: () => removePhotos([p]) });
    return h('li', { class: `ph-card${p.on ? ' on' : ' off'}`, 'data-id': p.id }, pick, x);
  }
  function paintCard(p) {
    const old = document.querySelector(`.ph-card[data-id="${p.id}"]`);
    if (old) old.replaceWith(cardFor(p));
  }

  function paintGrid() {
    const ul = $('ph-grid');
    if (!state.photos.length) {
      ul.replaceChildren(h('li', { class: 'ph-empty', text: '아직 사진이 없어요. [사진 더 넣기]를 누르거나 끌어다 놓으세요.' }));
    } else {
      const ests = new Map(plan().items.map((x) => [x.p, x.est]));
      ul.replaceChildren(...state.photos.map((p) => cardFor(p, ests)));
    }
    const sel = selected();
    const gps = state.photos.filter((p) => p.exif && p.exif.gps).length;
    const heic = state.photos.filter((p) => p.heic).length;
    const head = $('ph-count');
    head.replaceChildren(`사진 ${state.photos.length}장 `, h('small', {
      text: `· ${sel.length}장 고름 · 원본 ${C.sizeText(sel.reduce((a, p) => a + p.srcBytes, 0))}${heic ? ` · 아이폰(HEIC) ${heic}장` : ''}`,
    }));
    $('ph-gps-count').textContent = gps ? `· ${gps}장에 위치 있음` : '';
    $('ph-all').textContent = sel.length === state.photos.length && state.photos.length ? '모두 빼기' : '모두 고르기';
  }

  function isDefault(s) {
    const d = C.defaultSettings(s.use);
    return ['mode', 'value', 'q', 'fmt', 'sharpen', 'noUpscale', 'keepDate', 'keepPng', 'name'].every((k) => String(d[k]) === String(s[k]));
  }

  function paintPanel() {
    const s = state.settings;
    const u = C.useOf(s.use);
    const custom = !isDefault(s);
    $('ph-rec-title').textContent = custom ? '내가 고친 설정' : u.title;
    document.querySelector('.ph-rec .ph-pill').textContent = custom ? '직접' : '추천';
    $('ph-rec-line').textContent = C.settingsLine(s);
    const pl = plan();
    const n = pl.items.length;
    $('ph-rec-count').textContent = `${n}장 합계`;
    const sum = $('ph-rec-sum');
    const doneAll = n && pl.items.every((x) => x.p.out);
    sum.replaceChildren(`${C.sizeText(pl.src)} → `, h('em', { text: `${doneAll ? '' : '약 '}${C.sizeText(pl.est)}` }));
    $('ph-rec-bar').style.width = `${pl.src ? Math.max(2, Math.min(100, Math.round((pl.est / pl.src) * 100))) : 0}%`;
    const run = $('ph-run');
    run.textContent = n > 1 ? `이대로 ${n}장 줄이기` : n === 1 ? '이대로 줄여서 저장' : '고른 사진이 없어요';
    run.disabled = !n || state.busy;
    // 휴대폰 · 태블릿: 아래에 붙은 막대(사진이 길어도 단추가 늘 보이게)
    $('ph-dock-sum').textContent = n ? `${n}장 · ${C.sizeText(pl.src)} → ${doneAll ? '' : '약 '}${C.sizeText(pl.est)}` : '고른 사진이 없어요';
    $('ph-dock-run').textContent = n > 1 ? `${n}장 줄이기` : '줄이기';
    $('ph-dock-run').disabled = !n || state.busy;

    $('ph-uses').replaceChildren(...C.USES.map((x) => h('button', {
      type: 'button', class: 'ph-chip', 'aria-pressed': x.id === s.use && !custom ? 'true' : 'false',
      onclick: () => { state.settings = C.defaultSettings(x.id); resetOuts(); paint(); },
      text: x.label,
    })));

    $('ph-more-btn').setAttribute('aria-expanded', state.more ? 'true' : 'false');
    $('ph-more-mark').textContent = state.more ? '접기' : '열기';
    $('ph-more').hidden = !state.more;
    if (!state.more) return;

    $('ph-modes').replaceChildren(...Object.entries(C.MODES).map(([id, m]) => h('button', {
      type: 'button', 'aria-pressed': id === s.mode ? 'true' : 'false', text: m.label,
      onclick: () => {
        const def = { edge: 1280, width: 1280, each: 0.5, all: 10, keep: 0 }[id];
        s.mode = id;
        s.value = def;
        resetOuts();
        paint();
      },
    })));
    const m = C.MODES[s.mode];
    $('ph-value-row').hidden = s.mode === 'keep';
    const v = $('ph-value');
    v.min = m.min; v.max = m.max; v.step = m.step;
    if (document.activeElement !== v) v.value = s.value;
    v.setAttribute('aria-label', m.label);
    $('ph-value-unit').textContent = m.unit;
    $('ph-q-row').hidden = s.fmt === 'png';
    const q = $('ph-q');
    if (document.activeElement !== q) q.value = s.q;
    $('ph-q-text').textContent = `${s.q}${s.q === C.useOf(s.use).q ? ' · 추천' : ''}`;
    $('ph-q-warn').hidden = s.q >= 70;
    $('ph-fmts').replaceChildren(...[['jpeg', 'JPG'], ['webp', 'WEBP'], ['png', 'PNG'], ['keep', '원래대로']].map(([id, label]) => h('button', {
      type: 'button', 'aria-pressed': id === s.fmt ? 'true' : 'false', text: label,
      onclick: () => { s.fmt = id; resetOuts(); paint(); },
    })));
    $('ph-sharpen').checked = !!s.sharpen;
    $('ph-noup').checked = s.noUpscale !== false;
    $('ph-keeppng').checked = !!s.keepPng;
    $('ph-keepdate').checked = !!s.keepDate;
    const name = $('ph-name');
    if (document.activeElement !== name) name.value = s.name;
    const first = selected()[0] || state.photos[0];
    const ex = first
      ? C.fileName(s.name, { name: first.name, index: 0, count: Math.max(1, selected().length), date: C.dateText(first.exif && first.exif.date), ext: C.FORMATS[outFmt(first)].ext })
      : C.fileName(s.name, { name: '과학실험_1모둠.jpg', index: 0, count: 12, date: '2026-10-05', ext: 'jpg' });
    $('ph-name-ex').textContent = `예: ${ex}`;
    $('ph-remember').hidden = shared();
  }

  function paint() {
    if (state.view === 'home') { paintGoals(); return; }
    paintGrid();
    paintPanel();
  }

  function setStatus(text) { $('ph-status').textContent = text || ''; }
  function setBusy(on, text) {
    state.busy = on;
    document.body.classList.toggle('ph-busy', on);
    ['ph-run', 'ph-dock-run', 'ph-add', 'ph-pick', 'ph-pick-folder', 'ph-compare-btn'].forEach((id) => { const b = $(id); if (b) b.disabled = on; });
    if (text != null) setStatus(text);
    if (!on && state.view !== 'home') paintPanel();
  }
  function resetOuts() { state.photos.forEach((p) => { p.out = null; }); $('ph-compare').hidden = true; calibrateSoon(); }

  function removePhotos(list) {
    for (const p of list) if (p.thumb) URL.revokeObjectURL(p.thumb);
    state.photos = state.photos.filter((p) => !list.includes(p));
    paint();
  }

  // ── 줄이기 ─────────────────────────────────────────────────────
  async function decodeOriented(blob) {
    return createImageBitmap(blob, { imageOrientation: 'from-image' });
  }
  /** 가벼운 선명하게(줄인 뒤 흐려진 가장자리만 살짝) */
  function sharpen(ctx, w, h, amount = 0.35) {
    if (w * h > 16e6) return;
    const img = ctx.getImageData(0, 0, w, h);
    const s = img.data;
    const o = new Uint8ClampedArray(s);
    const row = w * 4;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * row + x * 4;
        for (let c = 0; c < 3; c++) {
          const v = s[i + c];
          const blur = (s[i + c - 4] + s[i + c + 4] + s[i + c - row] + s[i + c + row]) / 4;
          o[i + c] = v + (v - blur) * amount;
        }
      }
    }
    img.data.set(o);
    ctx.putImageData(img, 0, 0);
  }
  async function drawTo(bmp, w, h, fmt, doSharpen) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: doSharpen });
    if (fmt === 'jpeg') { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h); }
    let src = bmp;
    let made = null;
    // 크게 줄일 때는 브라우저의 고품질 줄이기를 한 번 거친다(계단 · 물결 무늬 줄임)
    if (w < bmp.width * 0.6) {
      try { made = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }); src = made; } catch { src = bmp; }
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    if (made && made.close) made.close();
    if (doSharpen && w < bmp.width * 0.85) sharpen(ctx, w, h);
    return c;
  }
  const toBlob = (c, mime, q) => new Promise((r) => c.toBlob(r, mime, q));

  /** 한 장: 설정대로 그리고 · 형식으로 굽고 · (MB 목표면) 맞을 때까지 품질 · 크기를 낮춘다 */
  async function encodeOne(item, s) {
    const p = item.p;
    if (p.alpha == null && s.keepPng && ['png', 'webp', 'gif'].includes(p.kind)) p.alpha = await hasAlpha(p.blob);
    const fmt = outFmt(p, s);
    const mime = C.FORMATS[fmt].mime;
    const bmp = await decodeOriented(p.blob);
    try {
      const base = C.fitSize(bmp.width, bmp.height, s);
      let w = base.w;
      let h = base.h;
      let q = Math.max(0.4, Math.min(1, s.q / 100));
      let canvas = await drawTo(bmp, w, h, fmt, s.sharpen);
      let blob = await toBlob(canvas, mime, q);
      if (item.budget) {
        for (let tries = 0; blob && blob.size > item.budget && tries < 8; tries++) {
          if (fmt !== 'png' && q > 0.56) {
            q = Math.max(0.55, q - 0.1);
          } else {
            const k = Math.max(0.35, Math.sqrt(item.budget / blob.size) * 0.94);
            w = Math.max(64, Math.round(w * k));
            h = Math.max(64, Math.round(h * k));
            canvas = await drawTo(bmp, w, h, fmt, s.sharpen);
          }
          blob = await toBlob(canvas, mime, q);
        }
      }
      if (!blob) throw new Error('encode');
      let bytes = new Uint8Array(await blob.arrayBuffer());
      if (fmt === 'jpeg' && s.keepDate && p.exif && p.exif.date) bytes = C.withExifDate(bytes, p.exif.date);
      return { bytes, fmt, w, h, canvas };
    } finally {
      bmp.close && bmp.close();
    }
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  let zipLoading = null;
  function loadZip() {
    if (self.JSZip) return Promise.resolve(self.JSZip);
    if (!zipLoading) {
      zipLoading = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = '/vendor/jszip.min.js';
        el.onload = () => resolve(self.JSZip);
        el.onerror = () => { zipLoading = null; reject(new Error('jszip')); };
        document.head.append(el);
      });
    }
    return zipLoading;
  }

  async function run() {
    if (state.busy) return;
    const s = { ...state.settings };
    const pl = plan(s);
    if (!pl.items.length) return;
    setBusy(true, '');
    const outs = [];
    let estSum = 0;
    let realSum = 0;
    try {
      for (let i = 0; i < pl.items.length; i++) {
        const it = pl.items[i];
        setStatus(`${pl.items.length}장 중 ${i + 1}장째 줄이는 중…`);
        const r = await encodeOne(it, s);
        const name = C.fileName(s.name, { name: it.p.name, index: i, count: pl.items.length, date: C.dateText(it.p.exif && it.p.exif.date), ext: C.FORMATS[r.fmt].ext });
        outs.push({ name, bytes: r.bytes });
        it.p.out = { size: r.bytes.length, w: r.w, h: r.h };
        if (!it.budget) { estSum += C.estimateBytes(r.w, r.h, s.q, r.fmt, 1); realSum += r.bytes.length; }
        paintCard(it.p);
        await new Promise((res) => setTimeout(res, 0));
      }
      if (estSum > 0 && realSum > 0) state.fix = Math.max(0.3, Math.min(3, realSum / estSum));
      const names = C.uniqueNames(outs.map((o) => o.name));
      const total = outs.reduce((a, o) => a + o.bytes.length, 0);
      if (outs.length === 1) {
        download(new Blob([outs[0].bytes], { type: C.FORMATS[outFmtByName(names[0])].mime }), names[0]);
      } else {
        setStatus('ZIP 하나로 묶는 중…');
        const JSZip = await loadZip();
        const zip = new JSZip();
        outs.forEach((o, i) => zip.file(names[i], o.bytes));
        const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
        const label = { kakao: '카톡용', web: '홈페이지용', print: '인쇄용', doc: '10MB', jpg: 'JPG' }[s.use] || '작게';
        download(blob, `사진_${label}_${outs.length}장.zip`);
      }
      state.lastRun = { count: outs.length, src: pl.src, out: total };
      setStatus(`${outs.length}장 줄였어요 · ${C.sizeText(pl.src)} → ${C.sizeText(total)}`);
      toast(`${outs.length}장을 줄여 저장했어요. 원본은 그대로예요.`);
    } catch (e) {
      console.warn(e);
      setStatus('');
      toast('줄이지 못한 사진이 있어요. 사진을 빼고 다시 해 보거나, 크기를 조금 크게 해 주세요.', 'warn');
    } finally {
      setBusy(false);
      paint();
    }
  }
  const outFmtByName = (n) => (/\.png$/i.test(n) ? 'png' : /\.webp$/i.test(n) ? 'webp' : 'jpeg');

  /**
   * 예상 바로잡기: 사진을 넣거나 설정을 바꾸면 잠시 뒤 가장 큰 사진 한 장을 실제로 구워 보고
   * (실제 / 예상) 비율로 합계 예상을 고친다. 줄이는 중에는 하지 않는다.
   */
  let calTimer = 0;
  let calToken = 0;
  function calibrateSoon() {
    clearTimeout(calTimer);
    calTimer = setTimeout(calibrate, 700);
  }
  async function calibrate() {
    const s = { ...state.settings };
    if (state.busy || s.mode === 'each' || s.mode === 'all' || state.view !== 'resize') return;
    const items = plan(s).items;
    if (!items.length) return;
    const it = items.reduce((a, b) => (b.p.srcBytes > a.p.srcBytes ? b : a));
    const token = ++calToken;
    try {
      const r = await encodeOne(it, s);
      if (token !== calToken || state.busy) return;
      const est = C.estimateBytes(r.w, r.h, s.q, r.fmt, 1);
      if (est > 0) state.fix = Math.max(0.3, Math.min(3, r.bytes.length / est));
      paintGrid();
      paintPanel();
    } catch { /* 예상만 못 고침 */ }
  }

  /** 원본과 비교: 줄인 사진의 가운데 240px(100%)와, 같은 곳의 원본 */
  async function compare() {
    const p = selected()[0];
    if (!p || state.busy) return;
    setBusy(true, '비교할 사진을 만드는 중…');
    try {
      const s = { ...state.settings };
      const item = plan(s).items.find((x) => x.p === p);
      const r = await encodeOne(item, s);
      const outBmp = await createImageBitmap(new Blob([r.bytes]));
      const srcBmp = await decodeOriented(p.blob);
      const a = $('ph-cmp-a');
      const b = $('ph-cmp-b');
      const side = 240;
      const k = r.w / srcBmp.width;
      const sx = Math.max(0, Math.round(srcBmp.width / 2 - side / k / 2));
      const sy = Math.max(0, Math.round(srcBmp.height / 2 - side / k / 2));
      a.getContext('2d').drawImage(srcBmp, sx, sy, side / k, side / k, 0, 0, side, side);
      const ox = Math.max(0, Math.round(r.w / 2 - side / 2));
      const oy = Math.max(0, Math.round(r.h / 2 - side / 2));
      const bctx = b.getContext('2d');
      bctx.clearRect(0, 0, side, side);
      bctx.drawImage(outBmp, ox, oy, side, side, 0, 0, side, side);
      $('ph-cmp-a-cap').textContent = `원본 ${C.sizeText(p.srcBytes)} · ${srcBmp.width} × ${srcBmp.height}`;
      $('ph-cmp-b-cap').textContent = `줄인 것 ${C.sizeText(r.bytes.length)} · ${r.w} × ${r.h}`;
      if (!item.budget) {
        const est = C.estimateBytes(r.w, r.h, s.q, r.fmt, 1);
        if (est > 0) state.fix = Math.max(0.3, Math.min(3, r.bytes.length / est));
      }
      outBmp.close && outBmp.close();
      srcBmp.close && srcBmp.close();
      $('ph-compare').hidden = false;
      setStatus('');
    } catch (e) {
      console.warn(e);
      setStatus('');
      toast('비교 그림을 만들지 못했어요.', 'warn');
    } finally {
      setBusy(false);
      paint();
    }
  }

  // ── 고르기 · 연결 ─────────────────────────────────────────────
  function useGoal(g) {
    state.settings = C.defaultSettings(g.use || 'kakao');
    resetOuts();
    show('resize');
  }
  function pickGoal(g) {
    if (g.soon) return;
    if (!state.photos.length) {
      state.pendingGoal = g;
      $('ph-input').click();
      return;
    }
    useGoal(g);
  }

  function wire() {
    $('ph-pick').addEventListener('click', () => { state.pendingGoal = null; $('ph-input').click(); });
    $('ph-pick-folder').addEventListener('click', () => $('ph-folder').click());
    $('ph-add').addEventListener('click', () => $('ph-input').click());
    $('ph-input').addEventListener('change', (e) => { const f = e.target.files; addFiles(f).finally(() => { e.target.value = ''; }); });
    $('ph-folder').addEventListener('change', (e) => { const f = e.target.files; addFiles(f).finally(() => { e.target.value = ''; }); });
    $('ph-home-link').addEventListener('click', (e) => { e.preventDefault(); show('home'); });
    document.querySelectorAll('.ph-rail-item').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.soon) { toast('곧 열려요. 지금은 크기 줄이기부터 쓸 수 있어요.'); return; }
      show(b.dataset.go);
    }));
    $('ph-all').addEventListener('click', () => {
      const all = selected().length === state.photos.length;
      state.photos.forEach((p) => { p.on = !all; p.out = null; });
      paint();
    });
    $('ph-remove').addEventListener('click', () => {
      const list = selected();
      if (!list.length) return;
      removePhotos(list);
      toast(`${list.length}장을 목록에서 뺐어요. 원본 파일은 그대로예요.`);
    });
    $('ph-run').addEventListener('click', run);
    $('ph-dock-run').addEventListener('click', run);
    $('ph-more-btn').addEventListener('click', () => { state.more = !state.more; paintPanel(); });
    $('ph-value').addEventListener('input', (e) => {
      const m = C.MODES[state.settings.mode];
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v >= m.min && v <= m.max) { state.settings.value = v; resetOuts(); paintGrid(); paintPanel(); }
    });
    $('ph-q').addEventListener('input', (e) => { state.settings.q = Number(e.target.value); resetOuts(); paintGrid(); paintPanel(); });
    const flag = (id, key) => $(id).addEventListener('change', (e) => { state.settings[key] = e.target.checked; resetOuts(); paint(); });
    flag('ph-sharpen', 'sharpen');
    flag('ph-noup', 'noUpscale');
    flag('ph-keeppng', 'keepPng');
    flag('ph-keepdate', 'keepDate');
    $('ph-name').addEventListener('input', (e) => { state.settings.name = e.target.value || '{이름}'; paintPanel(); });
    document.querySelectorAll('.ph-token').forEach((b) => b.addEventListener('click', () => {
      const input = $('ph-name');
      input.value = `${input.value}${input.value && !/[_\s-]$/.test(input.value) ? '_' : ''}${b.dataset.token}`;
      state.settings.name = input.value;
      paintPanel();
      input.focus();
    }));
    $('ph-compare-btn').addEventListener('click', compare);
    $('ph-remember').addEventListener('click', () => {
      if (saveLast(state.settings)) toast('이 설정을 기억했어요. 처음 화면 [지난번에 쓴 설정]에서 바로 시작해요.');
    });
    $('ph-reset').addEventListener('click', () => { state.settings = C.defaultSettings(state.settings.use); resetOuts(); paint(); });
    $('ph-last-go').addEventListener('click', () => {
      const last = loadLast();
      if (!last) return;
      state.settings = { ...C.defaultSettings(last.use), ...last };
      state.more = true;
      if (!state.photos.length) { state.pendingGoal = null; $('ph-input').click(); show('resize'); } else { resetOuts(); show('resize'); }
    });
    $('ph-last-forget').addEventListener('click', () => { try { localStorage.removeItem(LAST_KEY); } catch { /* 없음 */ } paintGoals(); });

    // 끌어다 놓기 · 붙여 넣기(화면 어디든)
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; document.body.classList.add('ph-dragging'); } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('ph-dragging'); });
    window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('ph-dragging');
      addFiles(e.dataTransfer.files);
    });
    window.addEventListener('paste', (e) => {
      const files = [...((e.clipboardData && e.clipboardData.files) || [])];
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
  }

  ENTERING.then(() => paintGoals());
  wire();
  show('home');
  // 화면 검사용(사진 · 설정의 모양만, 바이트는 내주지 않는다)
  window.__photo = {
    ready: true,
    state: () => ({
      view: state.view, count: state.photos.length, selected: selected().length, busy: state.busy, more: state.more,
      settings: { ...state.settings }, plan: (({ src, est }) => ({ src, est }))(plan()), fix: state.fix, lastRun: state.lastRun,
      photos: state.photos.map((p) => ({ name: p.name, kind: p.kind, heic: p.heic, w: p.w, h: p.h, gps: !!(p.exif && p.exif.gps), date: p.exif && p.exif.date, on: p.on, out: p.out })),
    }),
  };
})();
