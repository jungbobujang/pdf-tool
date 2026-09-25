/* PDF 작업실 — 모든 처리는 브라우저 안에서만 한다. 네트워크로 파일을 보내는 코드는 없다. */
(function () {
  'use strict';

  const { PDFDocument } = PDFLib;
  const Core = PdfCore;
  const { UserError } = Core;

  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
  const PDFJS_OPTS = {
    isEvalSupported: false,
    cMapUrl: '/vendor/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/standard_fonts/',
  };

  const FILE_COLORS = ['#2f5bea', '#e8590c', '#2b8a3e', '#ae3ec9', '#0c8599', '#d6336c', '#e0a100', '#5c7cfa', '#868e96', '#12b886'];
  const MAX_CANVAS_PIXELS = 16000000; // iOS 사파리 한계(약 16.7MP) 안쪽
  const MAX_CANVAS_SIDE = 16000;

  // ── 작은 도구들 ─────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'hidden') el.hidden = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children) if (c != null && c !== false) el.append(c);
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** 스프라이트의 선 아이콘 */
  function icon(name, cls = 'ic') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  const baseName = (name) => String(name || '문서').replace(/\.[^.]+$/, '') || '문서';
  const safeName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '문서';
  function ymd(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }
  const pad3 = (n) => String(n).padStart(3, '0');

  let lastYield = 0;
  // 오래 걸리는 반복 중에 화면이 진행 표시를 그릴 틈을 준다.
  function breathe(force) {
    const now = performance.now();
    if (!force && now - lastYield < 40) return Promise.resolve();
    lastYield = now;
    return new Promise((r) => setTimeout(r, 0));
  }

  async function readBytes(file) {
    try {
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      throw new UserError(`"${file.name}"을(를) 읽지 못했어요.`, '파일이 다른 프로그램에서 열려 있거나 옮겨졌는지 확인해 주세요.');
    }
  }

  function isPdfFile(f) {
    return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  }

  // ── 알림 ───────────────────────────────────────────────────
  const toastBox = $('toasts');
  function toast(title, fix, kind = 'error', ms) {
    const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('div', { class: 'toast-body' },
        h('div', { class: 'toast-title' }, title),
        fix ? h('div', { class: 'toast-fix' }, fix) : null),
      h('button', { class: 'toast-x', type: 'button', 'aria-label': '알림 닫기', onclick: () => el.remove() }, icon('x')));
    toastBox.prepend(el);
    while (toastBox.children.length > 4) toastBox.lastChild.remove();
    const life = ms || (kind === 'error' ? 9000 : 3500);
    setTimeout(() => el.remove(), life);
    return el;
  }

  /** 어떤 오류든 원인과 해결 방법이 담긴 문장으로 바꾼다. */
  function explain(err, fileName) {
    const who = fileName ? `"${fileName}": ` : '';
    if (!err) return { title: `${who}알 수 없는 문제가 생겼어요.`, fix: '페이지를 새로 고친 뒤 다시 해 주세요.' };
    if (err instanceof UserError || err.name === 'UserError') return { title: who + err.title, fix: err.fix };
    const msg = String(err.message || err);
    if (Core.isWrongPasswordError(err) || (err.name === 'PasswordException' && err.code === 2)) {
      return { title: `${who}비밀번호가 맞지 않아요.`, fix: '대소문자와 한/영 상태를 확인해 주세요.' };
    }
    if (err.name === 'PasswordException' || Core.isEncryptedError(err)) {
      return { title: `${who}암호가 걸린 PDF예요.`, fix: '비밀번호를 입력하면 이어서 쓸 수 있어요.' };
    }
    if (err instanceof RangeError || /memory|allocation|too large|Array buffer/i.test(msg)) {
      return { title: `${who}메모리가 부족해요.`, fix: '다른 탭을 닫거나, 파일을 나눠서 조금씩 처리해 주세요.' };
    }
    if (err.name === 'InvalidPDFException' || err.name === 'MissingPDFException' ||
        /parse|PDF header|Invalid|Expected|trailer|xref|Unexpected|corrupt|undefined|null/i.test(msg)) {
      return { title: `${who}파일이 손상됐거나 읽을 수 없는 PDF예요.`, fix: '원래 프로그램에서 PDF로 다시 저장한 뒤 넣어 주세요.' };
    }
    return { title: `${who}처리하지 못했어요.`, fix: `원인: ${msg.slice(0, 160)}` };
  }
  function showError(err, fileName) {
    console.warn(err);
    const { title, fix } = explain(err, fileName);
    toast(title, fix, 'error');
  }

  window.addEventListener('error', (e) => {
    if (!e.error && !e.message) return;
    showError(e.error || new Error(e.message));
  });
  window.addEventListener('unhandledrejection', (e) => showError(e.reason));

  // ── 진행 표시와 버튼 잠금 ───────────────────────────────────
  const busy = {
    el: $('busy'),
    text: $('busy-text'),
    fill: $('busy-fill'),
    locked: [],
    depth: 0,
    show(text) {
      if (this.depth++ === 0) {
        this.locked = [...document.querySelectorAll('main button, main input, main select, .sidebar button, dialog button')]
          .filter((b) => !b.disabled);
        this.locked.forEach((b) => (b.disabled = true));
        this.el.hidden = false;
      }
      this.set(text);
    },
    set(text, done, total) {
      this.text.textContent = text;
      this.fill.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
    },
    hide() {
      if (--this.depth > 0) return;
      this.depth = 0;
      this.locked.forEach((b) => (b.disabled = false));
      this.locked = [];
      this.el.hidden = true;
      document.dispatchEvent(new Event('busyend'));
    },
  };
  async function withBusy(text, fn) {
    busy.show(text);
    await breathe(true);
    try {
      return await fn((t, d, n) => {
        busy.set(t, d, n);
        return breathe();
      });
    } finally {
      busy.hide();
    }
  }
  const isBusy = () => busy.depth > 0;

  // ── 다운로드 ────────────────────────────────────────────────
  function download(data, name, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name, style: 'display:none' });
    document.body.append(a);
    a.click();
    a.remove();
    // 브라우저가 내려받기를 시작할 시간을 준 뒤 해제한다.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`"${name}" 저장을 시작했어요.`, '브라우저의 다운로드 폴더를 확인해 주세요.', 'ok');
  }

  // ── pdf.js 렌더링 ───────────────────────────────────────────
  function openPdfjs(bytes, password) {
    const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice(), password });
    return task.promise;
  }

  function makeCanvas(w, h) {
    const W = Math.max(1, Math.floor(w));
    const H = Math.max(1, Math.floor(h));
    if (W * H > MAX_CANVAS_PIXELS * 1.05 || W > MAX_CANVAS_SIDE || H > MAX_CANVAS_SIDE) {
      throw new UserError('그림이 너무 커서 만들 수 없어요.', '해상도를 낮춰서 다시 해 주세요.');
    }
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) throw new UserError('메모리가 부족해 그림을 만들지 못했어요.', '다른 탭을 닫고 다시 해 주세요.');
    return c;
  }

  /** 쪽을 boxW×boxH 안에 들어가게 그린다. */
  async function renderThumb(pdf, pageNo, extraRot, boxW, boxH) {
    const page = await pdf.getPage(pageNo);
    const rotation = Core.normAngle(page.rotate + (extraRot || 0));
    const vp1 = page.getViewport({ scale: 1, rotation });
    const scale = Math.min(boxW / vp1.width, boxH / vp1.height);
    const vp = page.getViewport({ scale, rotation });
    const canvas = makeCanvas(vp.width, vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    return canvas;
  }

  // 썸네일은 동시에 두 개까지만 그린다.
  const renderQueue = { jobs: [], running: 0 };
  function queueRender(fn) {
    return new Promise((resolve, reject) => {
      renderQueue.jobs.push({ fn, resolve, reject });
      pumpQueue();
    });
  }
  function pumpQueue() {
    while (renderQueue.running < 2 && renderQueue.jobs.length) {
      const job = renderQueue.jobs.shift();
      renderQueue.running++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          renderQueue.running--;
          pumpQueue();
        });
    }
  }
  const THUMB_PX = Math.round(150 * Math.min(2, window.devicePixelRatio || 1));

  // ── 드래그로 순서 바꾸기 (마우스 + 터치) ───────────────────
  function makeSortable(container, { itemSelector, onMove, onTap }) {
    let st = null;
    let ghost = null;
    let marker = null;
    let raf = 0;

    container.addEventListener('pointerdown', (e) => {
      if (st || isBusy()) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const item = e.target.closest(itemSelector);
      if (!item || !container.contains(item)) return;
      if (e.target.closest('button, input, select, a, textarea')) return;
      st = {
        item, id: e.pointerId, type: e.pointerType,
        x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
        active: false, moved: false, timer: 0, target: null,
      };
      if (e.pointerType !== 'mouse') {
        // 터치는 살짝 길게 눌러야 끌기가 시작된다. 그냥 밀면 화면이 스크롤된다.
        st.timer = setTimeout(() => {
          if (st && !st.moved) begin();
        }, 260);
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      st.x = e.clientX;
      st.y = e.clientY;
      if (!st.active) {
        if (Math.hypot(st.x - st.x0, st.y - st.y0) < 8) return;
        st.moved = true;
        if (st.type === 'mouse') begin();
        else { reset(); return; }
      }
      e.preventDefault();
      update();
    }, { passive: false });

    window.addEventListener('pointerup', (e) => finish(e, false));
    window.addEventListener('pointercancel', (e) => finish(e, true));
    document.addEventListener('touchmove', (e) => {
      if (st && st.active) e.preventDefault();
    }, { passive: false });
    container.addEventListener('contextmenu', (e) => {
      if (st) e.preventDefault();
    });

    function begin() {
      if (!st) return;
      st.active = true;
      clearTimeout(st.timer);
      const r = st.item.getBoundingClientRect();
      st.dx = st.x0 - r.left;
      st.dy = st.y0 - r.top;
      ghost = st.item.cloneNode(true);
      const src = st.item.querySelectorAll('canvas');
      ghost.querySelectorAll('canvas').forEach((c, i) => {
        if (src[i] && src[i].width) c.getContext('2d').drawImage(src[i], 0, 0);
      });
      ghost.classList.add('drag-ghost');
      ghost.classList.remove('show-tools');
      ghost.style.width = `${r.width}px`;
      ghost.style.height = `${r.height}px`;
      document.body.append(ghost);
      marker = h('div', { class: 'drop-marker' });
      document.body.append(marker);
      st.item.classList.add('dragging');
      document.body.style.cursor = 'grabbing';
      if (st.type !== 'mouse' && navigator.vibrate) navigator.vibrate(12);
      update();
      autoScroll();
    }

    function update() {
      if (!st || !st.active) return;
      ghost.style.left = `${st.x - st.dx}px`;
      ghost.style.top = `${st.y - st.dy}px`;
      const items = [...container.querySelectorAll(itemSelector)];
      let best = null;
      let bestD = Infinity;
      items.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        // 같은 줄을 먼저 고르도록 세로 거리에 가중치를 준다.
        const d = Math.abs(st.x - cx) + Math.abs(st.y - cy) * 2;
        if (d < bestD) { bestD = d; best = { el, i, r, after: st.x > cx }; }
      });
      if (!best) return;
      st.target = best;
      const gap = 7;
      const x = best.after ? best.r.right + gap : best.r.left - gap;
      marker.style.left = `${x - 2}px`;
      marker.style.top = `${best.r.top}px`;
      marker.style.height = `${best.r.height}px`;
    }

    function autoScroll() {
      cancelAnimationFrame(raf);
      const step = () => {
        if (!st || !st.active) return;
        const edge = 70;
        const bar = document.querySelector('.panel:not([hidden]) .actionbar:not([hidden])');
        const bottom = window.innerHeight - (bar ? bar.offsetHeight : 0);
        let dy = 0;
        if (st.y < edge) dy = -Math.ceil((edge - st.y) / 5);
        else if (st.y > bottom - edge) dy = Math.ceil((st.y - (bottom - edge)) / 5);
        if (dy) { window.scrollBy(0, dy); update(); }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }

    function finish(e, cancelled) {
      if (!st || e.pointerId !== st.id) return;
      const s = st;
      if (s.active) {
        if (!cancelled && s.target) {
          const items = [...container.querySelectorAll(itemSelector)];
          const from = items.indexOf(s.item);
          let to = s.target.i + (s.target.after ? 1 : 0);
          if (from < to) to--;
          if (from >= 0 && to !== from) onMove(from, to);
        }
      } else if (!s.moved && !cancelled && onTap) {
        onTap(s.item, e);
      }
      reset();
    }

    function reset() {
      if (!st) return;
      clearTimeout(st.timer);
      cancelAnimationFrame(raf);
      st.item.classList.remove('dragging');
      if (ghost) ghost.remove();
      if (marker) marker.remove();
      ghost = marker = null;
      document.body.style.cursor = '';
      st = null;
    }

    return { cancel: reset };
  }

  const moveItem = (arr, from, to) => {
    const [x] = arr.splice(from, 1);
    arr.splice(to, 0, x);
  };

  /** 파일 놓는 곳: 누르면 고르기, 끌어다 놓기, 같은 파일 다시 고르기 */
  function wireDrop(zone, input, onFiles) {
    if (zone.tagName !== 'LABEL') {
      zone.addEventListener('click', (e) => {
        if (isBusy() || e.target.closest('label, button, input, a')) return;
        input.click();
      });
    }
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = '';
      if (files.length) onFiles(files);
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('over');
      if (isBusy()) return;
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) onFiles(files);
    });
  }

  /** 비밀번호 입력줄 */
  function passwordRow({ placeholder = '비밀번호', buttonText = '풀기', onSubmit }) {
    const input = h('input', { type: 'password', placeholder, autocomplete: 'off', 'aria-label': placeholder });
    const btn = h('button', { class: 'btn', type: 'button' }, buttonText);
    const msg = h('span', { class: 'msg', role: 'alert', hidden: true });
    const go = async () => {
      msg.hidden = true;
      if (!input.value) {
        msg.textContent = '비밀번호를 입력해 주세요.';
        msg.hidden = false;
        input.focus();
        return;
      }
      try {
        await onSubmit(input.value);
      } catch (e) {
        const { title, fix } = explain(e);
        msg.textContent = fix ? `${title} ${fix}` : title;
        msg.hidden = false;
        input.select();
      }
    };
    btn.addEventListener('click', go);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
    });
    return { el: h('div', { class: 'unlock-row' }, input, btn, msg), input };
  }

  // ═══════════════════════════════════════════════════════════
  // 탭 전환
  // ═══════════════════════════════════════════════════════════
  const tabs = [...document.querySelectorAll('.tab')];
  let activeTab = 'edit';
  let activeView = 'home';

  /** 처음 화면(home) ↔ 작업 화면(work) */
  function showView(name) {
    activeView = name;
    $('view-home').hidden = name !== 'home';
    $('view-work').hidden = name !== 'work';
    window.scrollTo({ top: 0 });
  }

  /** 작업 화면의 도구를 연다. 도구마다 넣은 파일과 상태는 그대로 남는다. */
  function openTool(name, focus) {
    if (activeView !== 'work') showView('work');
    showTab(name, focus);
  }

  function showTab(name, focus) {
    activeTab = name;
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== `panel-${name}`));
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      let j = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = tabs.length - 1;
      if (j != null) { e.preventDefault(); showTab(tabs[j].dataset.tab, true); }
    });
  });

  // 놓는 곳 밖에 파일을 떨어뜨려도 브라우저가 파일을 열지 않게 하고, 지금 탭으로 넘긴다.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (isBusy()) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (activeView === 'home') Home.route(files);
    else if (activeTab === 'edit') Edit.addFiles(files);
    else if (activeTab === 'img2pdf') Img.addFiles(files);
    else if (activeTab === 'pdf2img') P2I.load(files);
    else if (activeTab === 'number') Num.load(files);
    else toast('파일을 왼쪽이나 오른쪽 상자 위에 놓아 주세요.', '풀지, 걸지에 따라 놓는 곳이 달라요.', 'info');
  });

  // ═══════════════════════════════════════════════════════════
  // 탭1: 편집 · 합치기 · 자르기
  // ═══════════════════════════════════════════════════════════
  const Edit = (() => {
    const grid = $('edit-grid');
    const chips = $('edit-chips');
    const bar = $('edit-bar');
    const rangeInput = $('edit-range');
    const count = $('edit-count');

    let sources = []; // {id, name, color, bytes, doc, pageCount, locked, pdfjs}
    let pages = []; // {key, srcId, index, rot, deleted}
    let seq = 0;
    let colorSeq = 0;
    const cards = new Map(); // key -> element

    const srcById = (id) => sources.find((s) => s.id === id);

    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) paintThumb(en.target);
    }, { rootMargin: '400px 0px' });

    function getPdfjs(src) {
      if (!src.pdfjs) src.pdfjs = openPdfjs(src.bytes);
      return src.pdfjs;
    }

    function createSource(name, info) {
      const src = {
        id: `s${++seq}`,
        name,
        color: FILE_COLORS[colorSeq++ % FILE_COLORS.length],
        bytes: info.bytes,
        doc: info.doc,
        pageCount: info.doc ? info.doc.getPageCount() : 0,
        locked: info.locked,
        pdfjs: null,
      };
      sources.push(src);
      return src;
    }

    function appendPages(src) {
      for (let i = 0; i < src.pageCount; i++) {
        pages.push({ key: `p${++seq}`, srcId: src.id, index: i, rot: 0, deleted: false });
      }
    }

    async function addFiles(files, { quiet } = {}) {
      const pdfs = files.filter(isPdfFile);
      const others = files.filter((f) => !isPdfFile(f));
      if (others.length) {
        toast(`PDF가 아닌 파일 ${others.length}개는 넣지 않았어요.`,
          '사진은 "이미지 → PDF" 탭에서 PDF로 바꿀 수 있어요.', 'error');
      }
      if (!pdfs.length) return [];
      const added = [];
      await withBusy('파일 읽는 중…', async (progress) => {
        for (let i = 0; i < pdfs.length; i++) {
          const f = pdfs[i];
          await progress(`파일 읽는 중 (${i + 1}/${pdfs.length}) · ${f.name}`, i, pdfs.length);
          try {
            const bytes = await readBytes(f);
            const info = await Core.openPdf(bytes);
            if (!info.locked && info.doc.getPageCount() === 0) {
              throw new UserError('쪽이 하나도 없는 PDF예요.', '다른 파일을 넣어 주세요.');
            }
            const src = createSource(f.name, info);
            if (!quiet && !src.locked) appendPages(src);
            added.push(src);
          } catch (e) {
            showError(e, f.name);
          }
        }
      });
      render();
      return added;
    }

    /** 이미 풀린 문서를 받아서 넣는다(암호 탭에서 보내기). */
    function addDecrypted(name, bytes, doc) {
      const src = createSource(name, { bytes, doc, locked: false });
      appendPages(src);
      render();
      return src;
    }

    async function unlockSource(src, password) {
      await withBusy('암호 푸는 중…', async () => {
        const r = await Core.decrypt(src.bytes, password);
        src.bytes = r.bytes;
        src.doc = r.doc;
        src.pageCount = r.doc.getPageCount();
        src.locked = false;
        appendPages(src);
      });
      render();
      toast(`"${src.name}" 암호를 풀었어요.`, `${src.pageCount}쪽이 뒤에 붙었어요.`, 'ok');
    }

    function removeSource(id) {
      const src = srcById(id);
      if (!src) return;
      sources = sources.filter((s) => s !== src);
      pages = pages.filter((p) => p.srcId !== id);
      if (src.pdfjs) src.pdfjs.then((d) => d.destroy()).catch(() => {});
      render();
    }

    // 칩 목록
    function renderChips() {
      const items = sources.map((src) => {
        const used = pages.filter((p) => p.srcId === src.id).length;
        const meta = src.locked ? '잠김' : used === src.pageCount ? `${src.pageCount}쪽` : `${src.pageCount}쪽 중 ${used}쪽`;
        return h('li', { class: `chip${src.locked ? ' locked' : ''}`, style: `--c:${src.color}` },
          h('span', { class: 'chip-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'chip-name', title: src.name }, src.name),
          h('span', { class: 'chip-meta' }, meta),
          h('button', { class: 'chip-x', type: 'button', 'aria-label': `${src.name} 빼기`, title: '이 파일 빼기', onclick: () => removeSource(src.id) }, icon('x')));
      });
      if (sources.length) {
        items.push(h('li', null, h('label', { class: 'chip add', for: 'edit-input', tabindex: '0',
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('edit-input').click(); } } },
        icon('plus'), 'PDF 더 넣기')));
      }
      chips.replaceChildren(...items);
      renderLocks();
    }

    // 잠긴 파일마다 노란 안내줄. [비밀번호 넣기]를 누르면 그 자리에 입력칸이 열린다.
    function renderLocks() {
      const box = $('edit-locks');
      const locked = sources.filter((s) => s.locked);
      // 입력 중인 칸은 다시 그리지 않는다.
      [...box.children].forEach((el) => {
        if (!locked.some((s) => s.id === el.dataset.src)) el.remove();
      });
      locked.forEach((src) => {
        if (box.querySelector(`[data-src="${src.id}"]`)) return;
        const open = h('button', { class: 'btn', type: 'button' }, '비밀번호 넣기');
        const note = h('div', { class: 'lock-note', 'data-src': src.id, role: 'group', 'aria-label': `${src.name} 잠김` },
          icon('lock'),
          h('p', null, h('b', null, `"${src.name}"`), ' 파일이 잠겨 있어요. 비밀번호를 넣으면 같이 편집할 수 있어요.'),
          open);
        open.addEventListener('click', () => {
          const row = passwordRow({ placeholder: '이 파일의 비밀번호', onSubmit: (pw) => unlockSource(src, pw) });
          open.replaceWith(row.el);
          row.input.focus();
        });
        box.append(note);
      });
    }

    function makeCard(p) {
      const el = h('div', { class: 'page-card sort-item', tabindex: '0', 'data-key': p.key },
        h('div', { class: 'paper' },
          h('div', { class: 'thumb' }, h('span', { class: 'loading' }, '불러오는 중…')),
          h('span', { class: 'page-no' }),
          h('button', { type: 'button', class: 'del-band', 'data-act': 'del', tabindex: '-1' }, '삭제 예정 · 되돌리기')),
        h('div', { class: 'page-src' }),
        h('div', { class: 'card-tools' },
          h('button', { type: 'button', 'data-act': 'rot', title: '오른쪽으로 90도 회전', 'aria-label': '회전' }, icon('rotate')),
          h('button', { type: 'button', 'data-act': 'rep', title: '다른 쪽으로 교체', 'aria-label': '교체' }, icon('swap')),
          h('button', { type: 'button', 'data-act': 'del', class: 'del', title: '삭제 (다시 누르면 되돌리기)', 'aria-label': '삭제' }, icon('x'))));
      cards.set(p.key, el);
      io.observe(el);
      return el;
    }

    async function paintThumb(el) {
      const p = pages.find((x) => x.key === el.dataset.key);
      if (!p) return;
      const want = `${p.srcId}:${p.index}:${p.rot}`;
      if (el.dataset.painted === want || el.dataset.painting === want) return;
      el.dataset.painting = want;
      const src = srcById(p.srcId);
      try {
        const canvas = await queueRender(async () => {
          if (el.dataset.painting !== want || !el.isConnected) return null;
          const pdf = await getPdfjs(src);
          return renderThumb(pdf, p.index + 1, p.rot, THUMB_PX, THUMB_PX * 4 / 3);
        });
        if (!canvas || el.dataset.painting !== want) return;
        el.querySelector('.thumb').replaceChildren(canvas);
        el.dataset.painted = want;
      } catch (e) {
        if (el.dataset.painting === want) {
          el.querySelector('.thumb').replaceChildren(h('span', { class: 'loading' }, '미리보기 없음'));
          if (!src.thumbErrorShown) {
            src.thumbErrorShown = true;
            const { title } = explain(e, src.name);
            toast(`${title}`, '미리보기만 못 그렸어요. 저장은 시도해 볼 수 있어요.', 'error');
          }
        }
      } finally {
        if (el.dataset.painting === want) delete el.dataset.painting;
      }
    }

    function keptPages() {
      return pages.filter((p) => !p.deleted);
    }

    function render() {
      renderChips();
      const keys = new Set(pages.map((p) => p.key));
      for (const [k, el] of cards) {
        if (!keys.has(k)) { io.unobserve(el); el.remove(); cards.delete(k); }
      }
      const els = pages.map((p) => cards.get(p.key) || makeCard(p));
      // 이미 제자리에 있으면 옮기지 않는다(불필요한 다시 그리기 방지).
      els.forEach((el, i) => {
        if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
      });
      let n = 0;
      pages.forEach((p) => {
        const el = cards.get(p.key);
        const src = srcById(p.srcId);
        el.style.setProperty('--c', src.color);
        el.classList.toggle('deleted', p.deleted);
        el.querySelector('.page-no').textContent = p.deleted ? '–' : String(++n);
        const label = `${src.name.replace(/\.pdf$/i, '')} · ${p.index + 1}쪽`;
        const s = el.querySelector('.page-src');
        s.textContent = label;
        s.title = label;
        const del = el.querySelector('.card-tools [data-act="del"]');
        del.title = p.deleted ? '되돌리기' : '삭제 (다시 누르면 되돌리기)';
        del.setAttribute('aria-label', p.deleted ? '되돌리기' : '삭제');
        el.setAttribute('aria-label', `${p.deleted ? '삭제 예정' : n + '번'}, ${label}${p.rot ? `, ${p.rot}도 회전` : ''}`);
        if (el.dataset.painted && el.dataset.painted !== `${p.srcId}:${p.index}:${p.rot}`) paintThumb(el);
      });
      const has = pages.length > 0 || sources.length > 0;
      bar.hidden = !has;
      $('edit-hint').hidden = pages.length === 0;
      $('edit-empty').hidden = has;
      updateCount();
    }

    function updateCount() {
      const kept = keptPages().length;
      let extra = null;
      const r = rangeInput.value.trim();
      if (r && kept) {
        try { extra = `범위 ${Core.parseRange(r, kept).length}쪽`; } catch { extra = '범위 확인 필요'; }
      }
      count.replaceChildren(...[h('b', null, String(kept)), '쪽 저장 예정', extra && h('small', null, extra)].filter(Boolean));
      const none = kept === 0;
      ['edit-save', 'edit-save-range', 'edit-split', 'edit-odd', 'edit-even', 'edit-reverse'].forEach((id) => {
        if (isBusy()) return;
        $(id).disabled = id === 'edit-reverse' ? pages.length < 2 : none;
      });
    }

    // 카드 버튼
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || isBusy()) return;
      const el = btn.closest('.page-card');
      const p = pages.find((x) => x.key === el.dataset.key);
      if (!p) return;
      const act = btn.dataset.act;
      if (act === 'rot') {
        p.rot = (p.rot + 90) % 360;
        render();
      } else if (act === 'del') {
        p.deleted = !p.deleted;
        render();
      } else if (act === 'rep') {
        Replace.open(p);
      }
    });

    // 카드를 탭하면 버튼을 보여 준다.
    function hideAllTools(except) {
      grid.querySelectorAll('.show-tools').forEach((c) => c !== except && c.classList.remove('show-tools'));
    }
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#edit-grid .page-card')) hideAllTools(null);
    });

    makeSortable(grid, {
      itemSelector: '.page-card',
      onMove(from, to) {
        moveItem(pages, from, to);
        render();
      },
      onTap(el) {
        hideAllTools(el);
        el.classList.toggle('show-tools');
      },
    });

    // 키보드: Alt+←/→ 로 옮기기
    grid.addEventListener('keydown', (e) => {
      const el = e.target.closest('.page-card');
      if (!el || !e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const i = pages.findIndex((p) => p.key === el.dataset.key);
      const j = e.key === 'ArrowLeft' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= pages.length) return;
      moveItem(pages, i, j);
      render();
      el.focus();
    });

    rangeInput.addEventListener('input', updateCount);
    document.addEventListener('busyend', updateCount);
    rangeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveRange(); }
    });

    // 홀수/짝수/역순: 순서와 선택만 바꾼다.
    function keepParity(odd) {
      const kept = keptPages();
      if (!kept.length) return;
      let dropped = 0;
      kept.forEach((p, i) => {
        const isOdd = (i + 1) % 2 === 1;
        if (isOdd !== odd) { p.deleted = true; dropped++; }
      });
      render();
      toast(`${odd ? '홀수' : '짝수'} 번호만 남겼어요.`, `${dropped}쪽이 "삭제 예정"이 됐어요. 카드의 "되돌리기"를 누르면 되살아나요.`, 'info');
    }
    const menu = $('edit-menu');
    const more = $('edit-more');
    function closeMenu() {
      menu.hidden = true;
      more.setAttribute('aria-expanded', 'false');
    }
    more.addEventListener('click', () => {
      const open = menu.hidden;
      menu.hidden = !open;
      more.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('button:not(:disabled)')?.focus();
    });
    menu.addEventListener('click', (e) => { if (e.target.closest('button')) closeMenu(); });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { closeMenu(); more.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu-wrap')) closeMenu(); });

    $('edit-odd').addEventListener('click', () => keepParity(true));
    $('edit-even').addEventListener('click', () => keepParity(false));
    $('edit-reverse').addEventListener('click', () => {
      pages.reverse();
      render();
      toast('순서를 거꾸로 바꿨어요.', '저장하려면 "합쳐서 PDF 저장"을 누르세요.', 'info');
    });

    function toList(ps) {
      return ps.map((p) => ({ doc: srcById(p.srcId).doc, index: p.index, rot: p.rot }));
    }

    async function build(ps, label) {
      return withBusy(`${label} 준비 중…`, async (progress) => {
        const doc = await Core.assemble(toList(ps), (d, n, phase) =>
          progress(phase === 'copy' ? `${d}번째 쪽 가져오는 중 (${d}/${n})` : `${d}번째 쪽 붙이는 중 (${d}/${n})`, d, n));
        await progress('파일로 만드는 중…', 1, 1);
        return doc.save();
      });
    }

    async function saveAll() {
      const kept = keptPages();
      if (!kept.length) return toast('저장할 쪽이 없어요.', 'PDF를 넣거나 "삭제 예정" 쪽을 되살려 주세요.');
      try {
        const bytes = await build(kept, '합본');
        download(bytes, `합본_${ymd()}.pdf`);
      } catch (e) { showError(e); }
    }

    async function saveRange() {
      const kept = keptPages();
      if (!kept.length) return toast('저장할 쪽이 없어요.', 'PDF를 먼저 넣어 주세요.');
      let nums;
      try {
        nums = Core.parseRange(rangeInput.value, kept.length);
      } catch (e) {
        rangeInput.focus();
        return showError(e);
      }
      const ps = nums.map((n) => kept[n - 1]);
      const first = srcById(ps[0].srcId);
      const rangeLabel = rangeInput.value.replace(/\s+/g, '').replace(/[~〜–—]/g, '-');
      try {
        const bytes = await build(ps, '범위 저장');
        download(bytes, `${safeName(baseName(first.name))}_${safeName(rangeLabel)}.pdf`);
      } catch (e) { showError(e); }
    }

    async function saveSplit() {
      const kept = keptPages();
      if (!kept.length) return toast('저장할 쪽이 없어요.', 'PDF를 먼저 넣어 주세요.');
      try {
        const blob = await withBusy('나누는 중…', async (progress) => {
          const zip = new JSZip();
          for (let i = 0; i < kept.length; i++) {
            await progress(`${i + 1}번째 쪽 처리 중 (${i + 1}/${kept.length})`, i, kept.length);
            const p = kept[i];
            const src = srcById(p.srcId);
            const doc = await Core.assemble(toList([p]));
            zip.file(`${pad3(i + 1)}_${safeName(baseName(src.name))}_${p.index + 1}쪽.pdf`, await doc.save());
          }
          return zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => {
            busy.set(`zip으로 묶는 중 (${Math.round(m.percent)}%)`, m.percent, 100);
          });
        });
        const one = sources.length === 1 ? baseName(sources[0].name) : `합본_${ymd()}`;
        download(blob, `${safeName(one)}_쪽나눔.zip`, 'application/zip');
      } catch (e) { showError(e); }
    }

    $('edit-save').addEventListener('click', saveAll);
    $('edit-save-range').addEventListener('click', saveRange);
    $('edit-split').addEventListener('click', saveSplit);
    wireDrop($('edit-drop'), $('edit-input'), (files) => addFiles(files));

    function reset() {
      sources.forEach((s) => s.pdfjs && s.pdfjs.then((d) => d.destroy()).catch(() => {}));
      sources = [];
      pages = [];
      cards.forEach((el) => io.unobserve(el));
      cards.clear();
      grid.replaceChildren();
      rangeInput.value = '';
      colorSeq = 0;
      render();
    }

    render();

    return {
      addFiles, addDecrypted, reset, render, removeSource,
      get sources() { return sources; },
      getPdfjs, srcById,
      replacePage(p, srcId, index) {
        p.srcId = srcId;
        p.index = index;
        p.rot = 0;
        render();
      },
      unlockSource,
    };
  })();

  // ═══════════════════════════════════════════════════════════
  // 쪽 교체 대화상자
  // ═══════════════════════════════════════════════════════════
  const Replace = (() => {
    const dlg = $('replace-dialog');
    const pageSel = $('replace-page');
    const pageField = $('replace-page-field');
    const preview = $('replace-preview');
    const ok = $('replace-ok');
    const fileLabel = $('replace-file');
    const unlockBox = $('replace-unlock');
    let target = null;
    let chosen = null; // source id
    let added = []; // 이 대화상자에서 새로 넣은 source id
    let previewToken = 0;

    // 이미 넣은 파일 고르기
    const srcSel = h('select', { id: 'replace-src' });
    const srcField = h('label', { class: 'field' }, h('span', null, '넣어 둔 파일에서 고르기'), srcSel);
    $('replace-drop').before(srcField);

    function fillSources() {
      const list = Edit.sources.filter((s) => !s.locked);
      srcSel.replaceChildren(h('option', { value: '' }, '파일을 고르세요'),
        ...list.map((s) => h('option', { value: s.id }, `${s.name} (${s.pageCount}쪽)`)));
      srcSel.value = chosen || '';
      srcField.hidden = list.length === 0;
    }

    function choose(id) {
      chosen = id || null;
      const src = chosen && Edit.srcById(chosen);
      pageField.hidden = !src;
      ok.disabled = !src;
      preview.replaceChildren();
      if (!src) return;
      pageSel.replaceChildren(...Array.from({ length: src.pageCount }, (_, i) => h('option', { value: String(i) }, `${i + 1}쪽`)));
      pageSel.value = '0';
      srcSel.value = chosen;
      drawPreview();
    }

    async function drawPreview() {
      const src = chosen && Edit.srcById(chosen);
      if (!src) return;
      const token = ++previewToken;
      preview.replaceChildren(h('span', { class: 'sub' }, '미리보기 그리는 중…'));
      try {
        const pdf = await Edit.getPdfjs(src);
        const c = await renderThumb(pdf, Number(pageSel.value) + 1, 0, 320, 400);
        if (token === previewToken) preview.replaceChildren(c);
      } catch (e) {
        if (token === previewToken) preview.replaceChildren(h('span', { class: 'sub' }, '미리보기를 그리지 못했어요.'));
      }
    }

    srcSel.addEventListener('change', () => choose(srcSel.value));
    pageSel.addEventListener('change', drawPreview);

    wireDrop($('replace-drop'), $('replace-input'), async (files) => {
      const f = files[0];
      if (!isPdfFile(f)) return toast('PDF 파일만 고를 수 있어요.', '교체할 쪽은 PDF에서 가져와요.');
      unlockBox.hidden = true;
      const [src] = await Edit.addFiles([f], { quiet: true });
      if (!src) return;
      added.push(src.id);
      fileLabel.textContent = f.name;
      $('replace-drop').classList.add('has-file');
      if (src.locked) {
        const row = passwordRow({
          placeholder: '이 파일의 비밀번호',
          onSubmit: async (pw) => {
            await withBusy('암호 푸는 중…', async () => {
              const r = await Core.decrypt(src.bytes, pw);
              Object.assign(src, { bytes: r.bytes, doc: r.doc, pageCount: r.doc.getPageCount(), locked: false });
            });
            unlockBox.hidden = true;
            Edit.render();
            fillSources();
            choose(src.id);
          },
        });
        unlockBox.replaceChildren(h('p', null, '암호가 걸린 파일이에요. 비밀번호를 넣어 주세요.'), row.el);
        unlockBox.hidden = false;
        row.input.focus();
      } else {
        fillSources();
        choose(src.id);
      }
    });

    function open(p) {
      target = p;
      chosen = null;
      added = [];
      const src = Edit.srcById(p.srcId);
      $('replace-target').textContent = `"${src.name.replace(/\.pdf$/i, '')} ${p.index + 1}쪽" 자리에 넣을 쪽을 고르세요.`;
      fileLabel.textContent = '다른 PDF 고르기';
      $('replace-drop').classList.remove('has-file');
      unlockBox.hidden = true;
      fillSources();
      choose(null);
      dlg.showModal();
    }

    function close(apply) {
      if (apply && target && chosen) {
        Edit.replacePage(target, chosen, Number(pageSel.value));
        toast('쪽을 바꿨어요.', '되돌리려면 다시 교체 버튼으로 원래 쪽을 고르세요.', 'ok');
      }
      // 고르기만 하고 쓰지 않은 새 파일은 목록에서 뺀다.
      const used = new Set(apply && chosen ? [chosen] : []);
      added.filter((id) => !used.has(id)).forEach((id) => Edit.removeSource(id));
      added = [];
      target = null;
      previewToken++;
      preview.replaceChildren();
      if (dlg.open) dlg.close();
    }

    $('replace-form').addEventListener('submit', (e) => {
      e.preventDefault();
      close(e.submitter && e.submitter.value === 'ok');
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });

    return { open, close };
  })();

  // ═══════════════════════════════════════════════════════════
  // 탭2: 이미지 → PDF
  // ═══════════════════════════════════════════════════════════
  const Img = (() => {
    const grid = $('img-grid');
    let items = []; // {id, name, kind, file, orient, w, h, thumb}
    let seq = 0;

    function kindOf(f) {
      const t = (f.type || '').toLowerCase();
      const n = f.name.toLowerCase();
      if (t === 'image/jpeg' || /\.jpe?g$/.test(n)) return 'jpeg';
      if (t === 'image/png' || /\.png$/.test(n)) return 'png';
      if (t === 'image/webp' || /\.webp$/.test(n)) return 'webp';
      if (/heic|heif/.test(t) || /\.hei[cf]$/.test(n)) return 'heic';
      return null;
    }

    // JPEG EXIF 방향값(1~8). 없으면 1.
    function exifOrientation(bytes) {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
      let off = 2;
      while (off + 4 < v.byteLength) {
        const marker = v.getUint16(off);
        const len = v.getUint16(off + 2);
        if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
          const tiff = off + 10;
          const little = v.getUint16(tiff) === 0x4949;
          const ifd = tiff + v.getUint32(tiff + 4, little);
          const n = v.getUint16(ifd, little);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (e + 10 > v.byteLength) break;
            if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little) || 1;
          }
          return 1;
        }
        if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
        off += 2 + len;
      }
      return 1;
    }

    async function decode(file) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) {
        throw new UserError('사진을 열지 못했어요.', '파일이 손상됐을 수 있어요. 다른 프로그램에서 JPG나 PNG로 다시 저장해 주세요.');
      }
    }

    async function addFiles(files) {
      const bad = [];
      const heic = [];
      const ok = [];
      for (const f of files) {
        const k = kindOf(f);
        if (k === 'heic') heic.push(f.name);
        else if (!k) bad.push(f.name);
        else ok.push([f, k]);
      }
      if (heic.length) {
        toast(`HEIC 사진 ${heic.length}장은 넣을 수 없어요.`, '아이폰은 설정 › 카메라 › 포맷에서 "높은 호환성"을 고르거나, JPG로 바꿔서 올려 주세요.');
      }
      if (bad.length) {
        toast(`지원하지 않는 형식이에요: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' 외' : ''}`, 'JPG, PNG, WEBP만 넣을 수 있어요.');
      }
      if (!ok.length) return 0;
      const before = items.length;
      await withBusy('사진 읽는 중…', async (progress) => {
        for (let i = 0; i < ok.length; i++) {
          const [f, kind] = ok[i];
          await progress(`${i + 1}번째 사진 읽는 중 (${i + 1}/${ok.length})`, i, ok.length);
          try {
            const bmp = await decode(f);
            const k = Math.min(1, THUMB_PX / bmp.width, THUMB_PX / bmp.height);
            const thumb = makeCanvas(bmp.width * k, bmp.height * k);
            thumb.getContext('2d').drawImage(bmp, 0, 0, thumb.width, thumb.height);
            const item = { id: `i${++seq}`, name: f.name, kind, file: f, w: bmp.width, h: bmp.height, thumb, orient: 1 };
            bmp.close();
            if (kind === 'jpeg') item.orient = exifOrientation(await readBytes(f.slice(0, 131072)));
            items.push(item);
          } catch (e) {
            showError(e, f.name);
          }
        }
      });
      render();
      return items.length - before;
    }

    function render() {
      grid.replaceChildren(...items.map((it, i) =>
        h('div', { class: 'page-card img-card sort-item', 'data-id': it.id, tabindex: '0', style: '--c: var(--c2)' },
          h('div', { class: 'paper' },
            h('div', { class: 'thumb' }, it.thumb),
            h('span', { class: 'page-no' }, String(i + 1))),
          h('div', { class: 'page-src', title: it.name }, it.name),
          h('button', { class: 'x-btn', type: 'button', title: '빼기', 'aria-label': `${it.name} 빼기`, 'data-id': it.id }, icon('x')))));
      const has = items.length > 0;
      $('img-bar').hidden = !has;
      $('img-hint').hidden = items.length < 2;
      $('img-empty').hidden = has;
      $('img-options').hidden = !has;
      $('img-count').textContent = `${items.length}장 → ${items.length}쪽 PDF`;
    }

    grid.addEventListener('click', (e) => {
      const b = e.target.closest('button.x-btn');
      if (!b || isBusy()) return;
      items = items.filter((x) => x.id !== b.dataset.id);
      render();
    });
    grid.addEventListener('keydown', (e) => {
      const el = e.target.closest('.img-card');
      if (!el || !e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const i = items.findIndex((x) => x.id === el.dataset.id);
      const j = e.key === 'ArrowLeft' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= items.length) return;
      moveItem(items, i, j);
      render();
      grid.querySelector(`[data-id="${el.dataset.id}"]`).focus();
    });

    makeSortable(grid, {
      itemSelector: '.img-card',
      onMove(from, to) {
        moveItem(items, from, to);
        render();
      },
    });

    function canvasToBytes(canvas, type, quality) {
      return new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
          if (!b) return reject(new UserError('메모리가 부족해 사진을 변환하지 못했어요.', '사진 수를 줄이거나 다른 탭을 닫고 다시 해 주세요.'));
          b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
        }, type, quality);
      });
    }

    /** canvas에 다시 그려 방향을 바로잡고 PNG(또는 JPEG)로 바꾼다. */
    async function reencode(item, type) {
      const bmp = await decode(item.file);
      let w = bmp.width;
      let hgt = bmp.height;
      const k = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (w * hgt)), MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / hgt);
      w = Math.floor(w * k);
      hgt = Math.floor(hgt * k);
      const c = makeCanvas(w, hgt);
      const ctx = c.getContext('2d');
      if (type === 'image/jpeg') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, hgt);
      }
      ctx.drawImage(bmp, 0, 0, w, hgt);
      bmp.close();
      const bytes = await canvasToBytes(c, type, 0.92);
      c.width = c.height = 0;
      return bytes;
    }

    async function embed(doc, item) {
      if (item.kind === 'jpeg') {
        if (item.orient <= 1) {
          try { return await doc.embedJpg(await readBytes(item.file)); } catch (e) { /* 아래에서 다시 그려서 넣는다 */ }
        }
        return doc.embedJpg(await reencode(item, 'image/jpeg'));
      }
      if (item.kind === 'png') {
        try { return await doc.embedPng(await readBytes(item.file)); } catch (e) { /* 아래에서 다시 그려서 넣는다 */ }
      }
      // WEBP 등은 canvas에서 PNG로 바꿔 넣는다.
      return doc.embedPng(await reencode(item, 'image/png'));
    }

    async function save() {
      if (!items.length) return toast('사진을 먼저 넣어 주세요.', 'JPG, PNG, WEBP를 넣을 수 있어요.');
      const paper = document.querySelector('input[name="img-paper"]:checked').value;
      const margin = Number(document.querySelector('input[name="img-margin"]:checked').value);
      try {
        const bytes = await withBusy('PDF 만드는 중…', async (progress) => {
          const doc = await PDFDocument.create();
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            await progress(`${i + 1}번째 사진 넣는 중 (${i + 1}/${items.length})`, i, items.length);
            let img;
            try {
              img = await embed(doc, it);
            } catch (e) {
              const { title, fix } = explain(e, it.name);
              throw new UserError(title, fix);
            }
            const L = Core.layoutImage(paper, margin, it.w, it.h);
            const page = doc.addPage([L.pageW, L.pageH]);
            page.drawImage(img, { x: L.x, y: L.y, width: L.w, height: L.h });
          }
          await progress('파일로 만드는 중…', 1, 1);
          return doc.save();
        });
        const name = items.length === 1 ? baseName(items[0].name) : `사진모음_${ymd()}`;
        download(bytes, `${safeName(name)}.pdf`);
      } catch (e) { showError(e); }
    }

    $('img-save').addEventListener('click', save);
    $('img-clear').addEventListener('click', () => { items = []; render(); });
    wireDrop($('img-drop'), $('img-input'), addFiles);

    function reset() {
      items = [];
      render();
      document.querySelector('input[name="img-paper"][value="a4p"]').checked = true;
      document.querySelector('input[name="img-margin"][value="0"]').checked = true;
    }
    render();
    return { addFiles, reset };
  })();

  // ═══════════════════════════════════════════════════════════
  // 탭3: PDF → 이미지
  // ═══════════════════════════════════════════════════════════
  const P2I = (() => {
    const grid = $('p2i-grid');
    const unlockBox = $('p2i-unlock');
    let pdf = null;
    let name = '';
    let picked = new Set();
    let token = 0;

    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) paint(en.target);
    }, { rootMargin: '400px 0px' });

    async function load(files) {
      const f = files[0];
      if (files.length > 1) toast('PDF는 한 번에 하나씩 바꿀 수 있어요.', `첫 번째 파일 "${f.name}"만 열었어요.`, 'info');
      if (!isPdfFile(f)) return toast(`"${f.name}"은(는) PDF가 아니에요.`, 'PDF 파일을 넣어 주세요.');
      reset();
      const my = ++token;
      let bytes;
      try {
        bytes = await readBytes(f);
        if (!Core.looksLikePdf(bytes)) throw new UserError('PDF 파일이 아니에요.', 'PDF로 저장된 파일만 넣을 수 있어요.');
      } catch (e) { return showError(e, f.name); }
      const tryOpen = async (password) => {
        const doc = await withBusy('PDF 여는 중…', () => openPdfjs(bytes, password));
        if (my !== token) { doc.destroy(); return; }
        unlockBox.hidden = true;
        show(doc, f.name);
      };
      try {
        await tryOpen(undefined);
      } catch (e) {
        if (e && e.name === 'PasswordException') {
          const row = passwordRow({ placeholder: '이 파일의 비밀번호', buttonText: '열기', onSubmit: tryOpen });
          unlockBox.replaceChildren(h('p', null, `"${f.name}"은(는) 암호가 걸려 있어요. 비밀번호를 넣어 주세요.`), row.el);
          unlockBox.hidden = false;
          row.input.focus();
        } else {
          showError(e, f.name);
        }
      }
    }

    function show(doc, fileName) {
      pdf = doc;
      name = fileName;
      picked = new Set(Array.from({ length: doc.numPages }, (_, i) => i + 1));
      grid.replaceChildren(...Array.from({ length: doc.numPages }, (_, i) => {
        const n = i + 1;
        const cb = h('input', { type: 'checkbox', class: 'pick-check', checked: true, 'aria-label': `${n}쪽 고르기` });
        const el = h('label', { class: 'page-card pick-card picked', 'data-n': String(n), style: '--c: var(--c3)' },
          h('div', { class: 'paper' },
            h('div', { class: 'thumb' }, h('span', { class: 'loading' }, '불러오는 중…')),
            h('span', { class: 'page-no' }, String(n))),
          h('div', { class: 'page-src' }, `${n}쪽`),
          cb);
        cb.addEventListener('change', () => {
          if (cb.checked) picked.add(n); else picked.delete(n);
          el.classList.toggle('picked', cb.checked);
          update();
        });
        io.observe(el);
        return el;
      }));
      $('p2i-options').hidden = false;
      $('p2i-empty').hidden = true;
      $('p2i-file').hidden = false;
      $('p2i-name').textContent = `${fileName} · ${doc.numPages}쪽`;
      update();
    }

    async function paint(el) {
      if (el.dataset.painted || !pdf) return;
      el.dataset.painted = '1';
      const doc = pdf;
      try {
        const c = await queueRender(() => (doc === pdf ? renderThumb(doc, Number(el.dataset.n), 0, THUMB_PX, THUMB_PX * 4 / 3) : null));
        if (c && doc === pdf) el.querySelector('.thumb').replaceChildren(c);
      } catch (e) {
        el.querySelector('.thumb').replaceChildren(h('span', { class: 'loading' }, '미리보기 없음'));
      }
    }

    function update() {
      const n = picked.size;
      $('p2i-bar').hidden = !pdf;
      $('p2i-count').textContent = `${n}쪽 선택 · ${n > 1 ? 'zip으로 묶어 저장' : 'PNG 한 장'}`;
      if (!isBusy()) $('p2i-save').disabled = n === 0;
    }

    function setAll(on) {
      grid.querySelectorAll('.pick-card').forEach((el) => {
        const cb = el.querySelector('input');
        cb.checked = on;
        el.classList.toggle('picked', on);
        const n = Number(el.dataset.n);
        if (on) picked.add(n); else picked.delete(n);
      });
      update();
    }
    document.addEventListener('busyend', update);
    $('p2i-all').addEventListener('click', () => setAll(true));
    $('p2i-none').addEventListener('click', () => setAll(false));

    async function renderPng(n, dpi) {
      const page = await pdf.getPage(n);
      let scale = dpi / 72;
      const vp1 = page.getViewport({ scale: 1 });
      const fit = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (vp1.width * vp1.height * scale * scale)),
        MAX_CANVAS_SIDE / (vp1.width * scale), MAX_CANVAS_SIDE / (vp1.height * scale));
      scale *= fit;
      const vp = page.getViewport({ scale });
      const c = makeCanvas(vp.width, vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      c.width = c.height = 0;
      if (!blob) throw new UserError('메모리가 부족해 그림을 만들지 못했어요.', '보통(150dpi)으로 바꾸거나 쪽 수를 줄여 주세요.');
      return { blob, reduced: fit < 0.999 };
    }

    async function save() {
      if (!pdf || !picked.size) return toast('저장할 쪽을 골라 주세요.', '카드를 누르면 고르거나 뺄 수 있어요.');
      const dpi = Number(document.querySelector('input[name="p2i-dpi"]:checked').value);
      const list = [...picked].sort((a, b) => a - b);
      const stem = safeName(baseName(name));
      let reduced = 0;
      try {
        await withBusy('그림으로 바꾸는 중…', async (progress) => {
          if (list.length === 1) {
            await progress(`${list[0]}쪽 처리 중`, 0, 1);
            const r = await renderPng(list[0], dpi);
            if (r.reduced) reduced++;
            download(r.blob, `${stem}_${list[0]}쪽.png`, 'image/png');
            return;
          }
          const zip = new JSZip();
          for (let i = 0; i < list.length; i++) {
            await progress(`${list[i]}쪽 처리 중 (${i + 1}/${list.length})`, i, list.length);
            const r = await renderPng(list[i], dpi);
            if (r.reduced) reduced++;
            zip.file(`${stem}_${pad3(list[i])}쪽.png`, r.blob);
          }
          const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) =>
            busy.set(`zip으로 묶는 중 (${Math.round(m.percent)}%)`, m.percent, 100));
          download(blob, `${stem}_이미지.zip`, 'application/zip');
        });
        if (reduced) toast(`${reduced}쪽은 너무 커서 해상도를 조금 낮춰 저장했어요.`, '브라우저가 한 번에 그릴 수 있는 크기에 한계가 있어요.', 'info');
      } catch (e) { showError(e, name); }
    }
    $('p2i-save').addEventListener('click', save);
    wireDrop($('p2i-drop'), $('p2i-input'), load);

    function reset() {
      token++;
      if (pdf) pdf.destroy();
      pdf = null;
      picked = new Set();
      grid.querySelectorAll('.pick-card').forEach((el) => io.unobserve(el));
      grid.replaceChildren();
      unlockBox.hidden = true;
      $('p2i-options').hidden = true;
      $('p2i-bar').hidden = true;
      $('p2i-empty').hidden = false;
      $('p2i-file').hidden = true;
      document.querySelector('input[name="p2i-dpi"][value="150"]').checked = true;
    }
    return { load, reset };
  })();

  // ═══════════════════════════════════════════════════════════
  // 탭4: 암호
  // ═══════════════════════════════════════════════════════════
  const Lock = (() => {
    const WRONG_PW = '비밀번호가 맞지 않아요. 대소문자와 한/영 상태를 확인해 주세요.';
    let unlockFile = null;
    let lockFile = null; // {name, bytes, doc}

    function formError(id, text) {
      const el = $(id);
      el.textContent = text || '';
      el.hidden = !text;
    }

    function pickFile(files, labelId, dropId, errId) {
      const f = files[0];
      formError(errId, '');
      if (!isPdfFile(f)) {
        formError(errId, `"${f.name}"은(는) PDF가 아니에요. PDF 파일을 골라 주세요.`);
        return null;
      }
      $(labelId).textContent = f.name;
      $(dropId).classList.add('has-file');
      return f;
    }

    // 암호 풀기
    wireDrop($('unlock-drop'), $('unlock-input'), (files) => {
      const f = pickFile(files, 'unlock-file', 'unlock-drop', 'unlock-error');
      if (f) { unlockFile = f; $('unlock-pw').focus(); }
    });

    async function doUnlock() {
      formError('unlock-error', '');
      if (!unlockFile) return formError('unlock-error', '먼저 PDF 파일을 골라 주세요.');
      const pw = $('unlock-pw').value;
      let bytes;
      try { bytes = await readBytes(unlockFile); } catch (e) { return formError('unlock-error', explain(e).title + ' ' + explain(e).fix); }
      if (!Core.looksLikePdf(bytes)) return formError('unlock-error', 'PDF 파일이 아니에요. 다른 파일을 골라 주세요.');
      try {
        return await withBusy('암호 푸는 중…', async () => {
          const info = await Core.openPdf(bytes);
          if (!info.wasEncrypted) return { bytes: bytes, doc: info.doc, plain: true };
          if (!info.locked) return { ...info, noPassword: true };
          if (!pw) throw new UserError('비밀번호를 입력해 주세요.', '');
          return Core.decrypt(bytes, pw);
        });
      } catch (e) {
        if (Core.isWrongPasswordError(e)) formError('unlock-error', WRONG_PW);
        else { const x = explain(e); formError('unlock-error', `${x.title} ${x.fix}`.trim()); }
        $('unlock-pw').select();
        return null;
      }
    }

    $('unlock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await doUnlock();
      if (!r) return;
      if (r.plain) {
        formError('unlock-error', '이 파일은 암호가 걸려 있지 않아요. 그대로 쓰면 돼요.');
        return;
      }
      download(r.bytes, `${safeName(baseName(unlockFile.name))}_암호해제.pdf`);
    });

    $('unlock-send').addEventListener('click', async () => {
      const r = await doUnlock();
      if (!r) return;
      const name = unlockFile.name;
      Edit.addDecrypted(name, r.bytes, r.doc);
      showTab('edit');
      toast(r.plain ? `"${name}"을(를) 편집 탭에 넣었어요.` : `"${name}" 암호를 풀어 편집 탭에 넣었어요.`,
        r.plain ? '원래 암호가 없는 파일이었어요.' : '저장하면 암호 없는 PDF가 돼요.', 'ok');
    });

    // 암호 걸기
    const lockUnlock = $('lock-unlock');
    wireDrop($('lock-drop'), $('lock-input'), async (files) => {
      const f = pickFile(files, 'lock-file', 'lock-drop', 'lock-error');
      lockFile = null;
      lockUnlock.hidden = true;
      if (!f) return;
      try {
        const bytes = await readBytes(f);
        const info = await withBusy('PDF 여는 중…', () => Core.openPdf(bytes));
        if (info.locked) {
          const row = passwordRow({
            placeholder: '지금 걸린 비밀번호',
            onSubmit: async (pw) => {
              const r = await withBusy('암호 푸는 중…', () => Core.decrypt(bytes, pw));
              lockFile = { name: f.name, bytes: r.bytes };
              lockUnlock.hidden = true;
              toast('기존 암호를 풀었어요.', '이제 새 암호를 정해 주세요.', 'ok');
              $('lock-pw').focus();
            },
          });
          lockUnlock.replaceChildren(h('p', null, '이미 암호가 걸린 파일이에요. 지금 암호를 먼저 넣어 주세요.'), row.el);
          lockUnlock.hidden = false;
          row.input.focus();
        } else {
          lockFile = { name: f.name, bytes: info.wasEncrypted ? info.bytes : bytes };
          $('lock-pw').focus();
        }
      } catch (e) {
        const x = explain(e, f.name);
        formError('lock-error', `${x.title} ${x.fix}`.trim());
      }
    });

    $('lock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      formError('lock-error', '');
      if (!lockFile) {
        return formError('lock-error', lockUnlock.hidden ? '먼저 PDF 파일을 골라 주세요.' : '기존 암호를 먼저 풀어 주세요.');
      }
      const userPassword = $('lock-pw').value;
      const ownerPassword = $('lock-owner').value;
      if (!userPassword) {
        $('lock-pw').focus();
        return formError('lock-error', '열기 암호를 입력해 주세요.');
      }
      try {
        const bytes = await withBusy('암호 거는 중…', async (progress) => {
          const doc = await PDFDocument.load(lockFile.bytes.slice(), { updateMetadata: false });
          await progress('AES-256으로 암호화하는 중…', 1, 2);
          Core.encrypt(doc, {
            userPassword,
            ownerPassword,
            allowPrint: $('perm-print').checked,
            allowCopy: $('perm-copy').checked,
            allowEdit: $('perm-edit').checked,
          });
          return doc.save({ useObjectStreams: false });
        });
        download(bytes, `${safeName(baseName(lockFile.name))}_암호.pdf`);
        if (!ownerPassword || ownerPassword === userPassword) {
          toast('권한 암호가 열기 암호와 같아요.', '열기 암호를 아는 사람은 인쇄·복사 제한도 풀 수 있어요. 제한을 지키려면 권한 암호를 따로 정하세요.', 'info', 8000);
        }
      } catch (err) {
        const x = explain(err, lockFile.name);
        formError('lock-error', `${x.title} ${x.fix}`.trim());
      }
    });

    function reset() {
      unlockFile = null;
      lockFile = null;
      $('unlock-form').reset();
      $('lock-form').reset();
      $('unlock-file').textContent = 'PDF 고르기';
      $('lock-file').textContent = 'PDF 고르기';
      $('unlock-drop').classList.remove('has-file');
      $('lock-drop').classList.remove('has-file');
      formError('unlock-error', '');
      formError('lock-error', '');
      lockUnlock.hidden = true;
    }
    return { reset };
  })();

  // ═══════════════════════════════════════════════════════════
  // 탭5: 쪽번호
  // ═══════════════════════════════════════════════════════════
  const Num = (() => {
    const unlockBox = $('num-unlock');
    const canvas = $('num-canvas');
    const mark = $('num-mark');
    let file = null; // {name, bytes, pageCount}
    let pdf = null; // pdf.js 문서(미리보기용)
    let previewPage = 0;
    let visW = 0;
    let visH = 0;
    let token = 0;

    const opts = () => ({
      position: document.querySelector('input[name="num-pos"]:checked').value,
      format: document.querySelector('input[name="num-fmt"]:checked').value,
      start: $('num-start').value.trim() === '' ? NaN : Number($('num-start').value),
      skipFirst: $('num-skip').checked,
    });

    async function load(files) {
      const f = files[0];
      if (files.length > 1) toast('쪽번호는 한 번에 한 파일씩 넣을 수 있어요.', `첫 번째 파일 "${f.name}"만 열었어요.`, 'info');
      if (!isPdfFile(f)) return toast(`"${f.name}"은(는) PDF가 아니에요.`, 'PDF 파일을 넣어 주세요.');
      reset(true);
      const my = token;
      try {
        const bytes = await readBytes(f);
        const info = await withBusy('PDF 여는 중…', () => Core.openPdf(bytes));
        if (my !== token) return;
        if (info.locked) {
          const row = passwordRow({
            placeholder: '이 파일의 비밀번호',
            onSubmit: async (pw) => {
              const r = await withBusy('암호 푸는 중…', () => Core.decrypt(bytes, pw));
              unlockBox.hidden = true;
              await ready(f.name, r.bytes, r.doc.getPageCount());
            },
          });
          unlockBox.replaceChildren(h('p', null, `"${f.name}"은(는) 암호가 걸려 있어요. 비밀번호를 넣으면 번호를 넣을 수 있어요. 저장한 파일에는 암호가 없어요.`), row.el);
          unlockBox.hidden = false;
          row.input.focus();
          return;
        }
        await ready(f.name, info.bytes, info.doc.getPageCount());
      } catch (e) {
        showError(e, f.name);
      }
    }

    async function ready(name, bytes, pageCount) {
      file = { name, bytes, pageCount };
      pdf = await openPdfjs(bytes);
      $('num-layout').hidden = false;
      $('num-empty').hidden = true;
      $('num-file').hidden = false;
      $('num-name').textContent = `${name} · ${pageCount}쪽`;
      await drawPreview();
    }

    async function drawPreview() {
      if (!pdf || !file) return;
      const o = opts();
      const want = o.skipFirst && file.pageCount > 1 ? 2 : 1;
      const my = ++token;
      if (want !== previewPage) {
        const page = await pdf.getPage(want);
        const vp1 = page.getViewport({ scale: 1 });
        const maxH = Math.min(640, window.innerHeight * 0.7);
        const cssW = Math.min(520, $('num-preview').parentElement.clientWidth || 520, maxH * (vp1.width / vp1.height));
        const k = cssW / vp1.width;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const vp = page.getViewport({ scale: k * dpr });
        if (my !== token) return;
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${Math.floor(vp1.width * k)}px`;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        visW = vp1.width;
        visH = vp1.height;
        previewPage = want;
      }
      placeMark();
    }

    // 미리보기 위에 번호 위치를 겹쳐 그린다(저장 때와 같은 계산).
    function placeMark() {
      if (!file) return;
      const o = opts();
      const info = $('num-info');
      if (!Number.isInteger(o.start) || o.start < 0) {
        mark.hidden = true;
        info.textContent = '시작 번호는 0 이상의 정수로 적어 주세요.';
        return;
      }
      const numbered = file.pageCount - (o.skipFirst ? 1 : 0);
      const total = o.start + numbered - 1;
      const showNo = o.skipFirst ? (file.pageCount > 1 ? o.start : null) : o.start;
      info.textContent = numbered > 0
        ? `모두 ${file.pageCount}쪽 · ${numbered}쪽에 “${Core.numberText(o.start, total, o.format)}”부터 “${Core.numberText(total, total, o.format)}”까지 들어가요.`
        : '번호를 넣을 쪽이 없어요. "첫 쪽 건너뛰기"를 끄세요.';
      $('num-caption').textContent = previewPage === 2 ? '2쪽 미리보기 (첫 쪽은 번호 없음)' : '첫 쪽 미리보기';
      if (showNo == null) { mark.hidden = true; return; }
      const text = Core.numberText(showNo, total, o.format);
      const { size, margin } = Core.numberMetrics(visW, visH);
      // Helvetica 폭을 대략 맞추기 위해 canvas로 잰다.
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `${size}px Helvetica, Arial, sans-serif`;
      const textW = ctx.measureText(text).width;
      const { vx, vy } = Core.numberSpot(visW, visH, textW, size, margin, o.position);
      const k = canvas.getBoundingClientRect().width / visW || 1;
      mark.textContent = text;
      mark.style.fontSize = `${size * k}px`;
      mark.style.left = `${vx * k}px`;
      // 기준선(vy) 위로 글자 높이만큼 올린다.
      mark.style.top = `${(visH - vy - size * 0.78) * k}px`;
      mark.hidden = false;
    }

    $('panel-number').addEventListener('change', (e) => {
      if (e.target.closest('.num-options')) drawPreview().catch(showError);
    });
    $('num-start').addEventListener('input', placeMark);
    window.addEventListener('resize', () => {
      if (activeTab === 'number' && file) { previewPage = 0; drawPreview().catch(() => {}); }
    });

    $('num-save').addEventListener('click', async () => {
      if (!file) return toast('PDF를 먼저 넣어 주세요.', '');
      const o = opts();
      if (!Number.isInteger(o.start) || o.start < 0) {
        $('num-start').focus();
        return toast('시작 번호가 올바르지 않아요.', '0 이상의 정수로 적어 주세요. 예: 1');
      }
      if (file.pageCount - (o.skipFirst ? 1 : 0) < 1) {
        return toast('번호를 넣을 쪽이 없어요.', '한 쪽짜리 PDF는 "첫 쪽 건너뛰기"를 끄고 저장하세요.');
      }
      try {
        const bytes = await withBusy('번호 넣는 중…', async (progress) => {
          // 매번 원본에서 새로 연다(두 번 저장해도 번호가 겹치지 않게).
          const doc = await PDFDocument.load(file.bytes.slice(), { updateMetadata: false });
          await Core.addPageNumbers(doc, o, (d, n) => progress(`${d}번째 쪽 처리 중 (${d}/${n})`, d, n));
          await progress('파일로 만드는 중…', 1, 1);
          return doc.save();
        });
        download(bytes, `${safeName(baseName(file.name))}_쪽번호.pdf`);
      } catch (e) { showError(e, file.name); }
    });

    wireDrop($('num-drop'), $('num-input'), load);

    function reset(keepOptions) {
      token++;
      if (pdf) pdf.destroy();
      pdf = null;
      file = null;
      previewPage = 0;
      unlockBox.hidden = true;
      mark.hidden = true;
      $('num-layout').hidden = true;
      $('num-empty').hidden = false;
      $('num-file').hidden = true;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!keepOptions) {
        document.querySelector('input[name="num-pos"][value="bc"]').checked = true;
        document.querySelector('input[name="num-fmt"][value="n"]').checked = true;
        $('num-start').value = '1';
        $('num-skip').checked = false;
      }
    }
    return { load, reset };
  })();

  // ═══════════════════════════════════════════════════════════
  // 로고: 새로고침 없이 처음 상태로
  // ═══════════════════════════════════════════════════════════
  function resetAll() {
    Replace.close(false);
    Edit.reset();
    Img.reset();
    P2I.reset();
    Lock.reset();
    Num.reset();
    toastBox.replaceChildren();
    showTab('edit');
    showView('home');
  }
  document.querySelectorAll('.logo').forEach((logo) => logo.addEventListener('click', (e) => {
    e.preventDefault();
    if (isBusy()) return;
    resetAll();
  }));

  // ═══════════════════════════════════════════════════════════
  // 처음 화면: 파일을 넣으면 알맞은 도구로 보낸다
  // ═══════════════════════════════════════════════════════════
  const Home = (() => {
    async function route(files) {
      const pdfs = files.filter(isPdfFile);
      const imgs = files.filter((f) => !isPdfFile(f));
      if (pdfs.length) {
        openTool('edit');
        await Edit.addFiles(pdfs);
        if (imgs.length) {
          const n = await Img.addFiles(imgs);
          if (n) toast(`사진 ${n}장은 사진 → PDF에 넣어 뒀어요.`, '왼쪽 "사진 → PDF"를 누르면 이어서 할 수 있어요.', 'info');
        }
      } else {
        openTool('img2pdf');
        await Img.addFiles(imgs);
      }
    }
    wireDrop($('home-drop'), $('home-input'), route);
    document.querySelectorAll('.tool-card').forEach((card) =>
      card.addEventListener('click', () => openTool(card.dataset.open, true)));
    return { route };
  })();

  // 검증용으로 상태를 살짝 드러낸다(개인 정보 없음).
  // 배포된 커밋을 화면 구석에 작게 보여 준다(옛 버전이 떠 있는지 바로 알 수 있게).
  fetch('/version', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => {
      if (!v || !v.commit) return;
      document.querySelectorAll('.app-version').forEach((el) => {
        el.textContent = `v ${v.commit}`;
        el.title = `배포 시각 ${new Date(v.builtAt).toLocaleString('ko-KR')}`;
      });
    })
    .catch(() => { /* 버전 표시는 없어도 쓰는 데 지장 없다 */ });

  window.__pdfWorkshop = { version: 2, ready: true };
})();
