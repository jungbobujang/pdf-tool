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

  // 이 화면을 이루는 파일의 배포 버전(Worker 주소에도 붙인다)
  const VER = (() => {
    try { return new URL(document.currentScript.src).searchParams.get('v') || 'dev'; } catch { return 'dev'; }
  })();

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
  /** 쪽 캡션용 파일이름 앞부분 */
  const shortName = (name) => {
    const b = baseName(name);
    return [...b].length > 12 ? `${[...b].slice(0, 11).join('')}…` : b;
  };
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
    rememberName(file.name);
    noteFile(file.size);
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
  /**
   * 알림. 오류 알림에는 [오류 내용 복사] 버튼이 붙는다(report: 복사할 글, 없으면 제목·안내·상황으로 만든다).
   */
  function toast(title, fix, kind = 'error', ms, report) {
    const copyBtn = kind === 'error'
      ? h('button', { class: 'toast-copy', type: 'button', title: '오류 내용(파일 이름 · 내용 제외)을 복사해요' }, '오류 내용 복사')
      : null;
    const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('div', { class: 'toast-body' },
        h('div', { class: 'toast-title' }, title),
        fix ? h('div', { class: 'toast-fix' }, fix) : null,
        copyBtn),
      h('button', { class: 'toast-x', type: 'button', 'aria-label': '알림 닫기', onclick: () => el.remove() }, icon('x')));
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const text = report || errorReport(null, { title, fix });
        const ok = await copyText(text);
        copyBtn.textContent = ok ? '복사했어요 ✓' : '복사하지 못했어요';
        if (!ok) console.warn(text);
      });
    }
    toastBox.prepend(el);
    while (toastBox.children.length > 4) toastBox.lastChild.remove();
    // 열린 대화상자보다 위에 보이도록 다시 띄운다(top layer는 나중에 띄운 것이 위).
    if (toastBox.showPopover) {
      try {
        if (toastBox.matches(':popover-open')) toastBox.hidePopover();
        toastBox.showPopover();
      } catch { /* popover를 모르는 브라우저는 z-index로 */ }
    }
    const life = ms || (kind === 'error' ? 15000 : 3500);
    let timer = setTimeout(() => el.remove(), life);
    // 마우스를 올려 두는 동안은 닫히지 않는다(복사할 시간)
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => { timer = setTimeout(() => el.remove(), 4000); });
    return el;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0' });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }
  }

  // 오류 보고에 넣을 상황(파일 이름과 내용은 넣지 않는다)
  const errCtx = { stage: '', file: null };
  const knownNames = new Set();
  /** 파일 이름을 기억해 두었다가 보고서에서 가린다 */
  const rememberName = (name) => { if (name) { knownNames.add(name); knownNames.add(baseName(name)); } };
  const scrub = (text) => {
    let s = String(text || '');
    for (const n of knownNames) if (n && n.length > 1) s = s.split(n).join('(파일 이름)');
    return s.replace(/"[^"\n]{1,120}\.(pdf|jpe?g|png|webp|zip)"/gi, '"(파일 이름)"').replace(/[^\s"'/\\]+\.(pdf|jpe?g|png|webp|zip)\b/gi, '(파일 이름)');
  };
  /** 진행 중인 단계(진행 표시 글)를 기억 */
  function noteStage(text) { errCtx.stage = scrub(text); }
  /** 다루는 파일의 크기 · 쪽수 */
  function noteFile(size, pages) { errCtx.file = { size, pages }; }

  function errorReport(err, shown) {
    const lines = ['[PDF 작업실 오류 보고]'];
    lines.push(`버전: v ${VER}`);
    lines.push(`도구: ${activeView === 'work' ? activeTab : '처음 화면'}`);
    if (shown) lines.push(`알림: ${scrub(shown.title)}${shown.fix ? ` / ${scrub(shown.fix)}` : ''}`);
    if (errCtx.stage) lines.push(`단계: ${errCtx.stage}`);
    const page = /\((\d+)\/(\d+)\)|(\d+)쪽/.exec(errCtx.stage || '');
    if (page) lines.push(`쪽 번호: ${page[1] ? `${page[1]} / ${page[2]}` : page[3]}`);
    if (errCtx.file) lines.push(`파일: ${(errCtx.file.size / 1048576).toFixed(2)}MB${errCtx.file.pages ? ` · ${errCtx.file.pages}쪽` : ''}`);
    if (err) {
      lines.push(`오류: ${err.name || 'Error'}: ${scrub(err.message || err)}`);
      const stack = String(err.stack || '').split('\n').slice(0, 7).map(scrub).join('\n  ');
      if (stack) lines.push(`스택:\n  ${stack}`);
    }
    const pm = typeof performance !== 'undefined' && performance.memory;
    const mem = pm ? ` · JS 힙 ${(pm.usedJSHeapSize / 1048576).toFixed(0)}/${(pm.jsHeapSizeLimit / 1048576).toFixed(0)}MB` : '';
    lines.push(`브라우저: ${navigator.userAgent}`);
    lines.push(`환경: 화면 ${innerWidth}×${innerHeight} · 기기 메모리 ${navigator.deviceMemory || '?'}GB · 코어 ${navigator.hardwareConcurrency || '?'}${mem} · Worker ${typeof OffscreenCanvas !== 'undefined' ? '가능' : '없음'}`);
    lines.push(`시각: ${new Date().toISOString()}`);
    return lines.join('\n');
  }

  const isMemoryError = (err) => !!err && (err instanceof RangeError || /out of memory|memory|allocation failed|Array buffer allocation|too large|Could not allocate/i.test(String(err.message || err)));

  /** 어떤 오류든 원인과 해결 방법이 담긴 문장으로 바꾼다. */
  function explain(err, fileName) {
    const who = fileName ? `"${fileName}": ` : '';
    if (!err) return { title: `${who}알 수 없는 문제가 생겼어요.`, fix: '페이지를 새로 고친 뒤 다시 해 주세요. 계속되면 [오류 내용 복사]로 알려 주세요.' };
    if (err instanceof UserError || err.name === 'UserError') return { title: who + err.title, fix: err.fix };
    const msg = String(err.message || err);
    if (Core.isWrongPasswordError(err) || (err.name === 'PasswordException' && err.code === 2)) {
      return { title: `${who}비밀번호가 맞지 않아요.`, fix: '대소문자와 한/영 상태를 확인해 주세요.' };
    }
    if (err.name === 'PasswordException' || Core.isEncryptedError(err)) {
      return { title: `${who}암호가 걸린(잠긴) PDF예요.`, fix: '비밀번호를 입력하면 이어서 쓸 수 있어요. 비밀번호를 모르면 만든 사람에게 받아야 해요.' };
    }
    if (isMemoryError(err)) {
      return { title: `${who}쪽이 많아 메모리가 부족해요.`, fix: '다른 탭을 닫거나 편집에서 나눠서 줄여 보세요.' };
    }
    if (err.workerDied) {
      return { title: `${who}처리하던 작업이 멈췄어요.`, fix: '다른 탭을 닫고 다시 해 주세요. 계속되면 편집에서 파일을 나눠서 해 보세요.' };
    }
    if (/PDF\/A|object and cross-reference streams/i.test(msg)) {
      return { title: `${who}PDF/A(보존용) 형식이라 그대로 다시 저장하지 못했어요.`, fix: '[오류 내용 복사]를 눌러 알려 주세요. 편집에서 쪽을 모아 새로 저장하면 될 수 있어요.' };
    }
    if (/unsupported|not supported|지원하지 않/i.test(msg)) {
      return { title: `${who}지원하지 않는 형식이 들어 있어요.`, fix: '원래 프로그램에서 PDF로 다시 저장하거나 인쇄 → "PDF로 저장"으로 만든 뒤 넣어 주세요.' };
    }
    if (err.name === 'InvalidPDFException' || err.name === 'MissingPDFException' ||
        /parse|PDF header|Invalid|Expected|trailer|xref|Unexpected|corrupt/i.test(msg)) {
      return { title: `${who}파일이 손상됐거나 읽을 수 없는 PDF예요.`, fix: '원래 프로그램에서 PDF로 다시 저장한 뒤 넣어 주세요.' };
    }
    return { title: `${who}예상하지 못한 문제로 처리하지 못했어요.`, fix: `[오류 내용 복사]를 눌러 내용을 알려 주시면 고칠게요. (원인: ${msg.slice(0, 120)})` };
  }
  function showError(err, fileName) {
    if (isAbort(err)) return toast('취소했어요.', '', 'info');
    console.warn(err);
    rememberName(fileName);
    const shown = explain(err, fileName);
    toast(shown.title, shown.fix, 'error', undefined, errorReport(err, shown));
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
      noteStage(text);
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
  /**
   * 진행 표시를 띄우고 fn을 실행한다. cancellable이면 [취소] 버튼이 생기고 fn은 두 번째 인자로 AbortSignal을 받는다.
   */
  async function withBusy(text, fn, { cancellable = false } = {}) {
    busy.show(text);
    let ctrl = null;
    if (cancellable) {
      ctrl = new AbortController();
      busy.abort = ctrl;
      busy.cancelBtn.hidden = false;
      busy.cancelBtn.disabled = false;
    }
    await breathe(true);
    try {
      noteStage(text);
      return await fn((t, d, n) => {
        if (ctrl && ctrl.signal.aborted) throw abortError();
        busy.set(t, d, n);
        return breathe();
      }, ctrl ? ctrl.signal : undefined);
    } finally {
      if (ctrl) { busy.cancelBtn.hidden = true; busy.abort = null; }
      busy.hide();
    }
  }
  const isBusy = () => busy.depth > 0;
  const abortError = () => Object.assign(new Error('취소했어요.'), { name: 'AbortError' });
  const isAbort = (e) => e && e.name === 'AbortError';
  busy.cancelBtn = $('busy-cancel');
  busy.abort = null;
  busy.cancelBtn.addEventListener('click', () => {
    if (!busy.abort) return;
    busy.abort.abort();
    busy.cancelBtn.disabled = true;
    busy.text.textContent = '취소하는 중…';
  });

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
  let guideSync = () => {}; // 사용법 패널 애니메이션 켜고 끄기 (Guide가 채운다)

  /** 처음 화면(home) ↔ 작업 화면(work) */
  function showView(name) {
    activeView = name;
    $('view-home').hidden = name !== 'home';
    $('view-work').hidden = name !== 'work';
    window.scrollTo({ top: 0 });
    if (name === 'home') setHash('');
    else setHash(activeTab);
    guideSync();
  }

  // 주소의 #도구 이름. 예전 이름(lock, number)은 새 도구로 이어 준다.
  const TOOL_ALIAS = { lock: 'security', password: 'security', number: 'decorate', numbers: 'decorate', shrink: 'compress' };
  function toolFromHash() {
    const raw = decodeURIComponent(location.hash.slice(1)).toLowerCase();
    const t = TOOL_ALIAS[raw] || raw;
    return tabs.some((x) => x.dataset.tab === t) ? t : null;
  }
  function setHash(tool) {
    try {
      const want = tool ? `#${tool}` : '';
      if (location.hash !== want) history.replaceState(null, '', tool ? want : location.pathname + location.search);
    } catch { /* 주소를 못 바꿔도 동작한다 */ }
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
    if (activeView === 'work') setHash(name);
    try { localStorage.setItem('pdfws.tab', name); } catch { /* 무시 */ }
    guideSync();
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
    else if (activeTab === 'decorate') Decor.load(files);
    else if (activeTab === 'compress') Shrink.addFiles(files);
    else toast('파일을 알맞은 상자 위에 놓아 주세요.', '풀기 · 걸기 · 제한 보기에 따라 놓는 곳이 달라요.', 'info');
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
      const el = h('div', { class: 'page-card sort-item', tabindex: '0', 'data-key': p.key, role: 'option', 'aria-selected': 'false' },
        h('div', { class: 'paper' },
          h('div', { class: 'thumb' }, h('span', { class: 'loading' }, '불러오는 중…')),
          h('span', { class: 'page-no' }),
          h('button', { type: 'button', class: 'del-band', 'data-act': 'del', tabindex: '-1' }, '삭제 예정 · 되돌리기')),
        h('button', { type: 'button', class: 'sel-check', 'data-act': 'check', role: 'checkbox', 'aria-checked': 'false', 'aria-label': '이 쪽 선택', title: '선택 (Ctrl+클릭과 같아요)', tabindex: '-1' },
          icon('check')),
        h('button', { type: 'button', class: 'cut-slot', 'data-act': 'cut', 'aria-pressed': 'false', 'aria-label': '이 쪽 다음에서 자르기', title: '여기서 자르기' }, icon('scissors', 'ic sm')),
        h('div', { class: 'page-src' }),
        h('div', { class: 'card-tools' },
          h('button', { type: 'button', 'data-act': 'rotl', title: '왼쪽으로 90° 회전', 'aria-label': '왼쪽 회전' }, icon('rotate-left')),
          h('button', { type: 'button', 'data-act': 'rot', title: '오른쪽으로 90° 회전', 'aria-label': '회전' }, icon('rotate')),
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
      // 파일이 하나뿐이면 "N쪽"만, 여러 개면 "파일이름 앞부분 · N쪽"
      const multi = new Set(pages.map((p) => p.srcId)).size > 1;
      pages.forEach((p) => {
        const el = cards.get(p.key);
        const src = srcById(p.srcId);
        el.style.setProperty('--c', src.color);
        el.classList.toggle('deleted', p.deleted);
        el.querySelector('.page-no').textContent = p.deleted ? '–' : String(++n);
        const label = multi ? `${shortName(src.name)} · ${p.index + 1}쪽` : `${p.index + 1}쪽`;
        const s = el.querySelector('.page-src');
        s.textContent = label;
        s.title = `${src.name} · ${p.index + 1}쪽`;
        const del = el.querySelector('.card-tools [data-act="del"]');
        del.title = p.deleted ? '되돌리기' : '삭제 (다시 누르면 되돌리기)';
        del.setAttribute('aria-label', p.deleted ? '되돌리기' : '삭제');
        el.setAttribute('aria-label', `${p.deleted ? '삭제 예정' : n + '번'}, ${label}${p.rot ? `, ${p.rot}도 회전` : ''}`);
        if (el.dataset.painted && el.dataset.painted !== `${p.srcId}:${p.index}:${p.rot}`) paintThumb(el);
      });
      const has = pages.length > 0 || sources.length > 0;
      bar.hidden = !has;
      $('edit-empty').hidden = has;
      updateCount();
      updateSelection();
      updateSplit();
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
      ['edit-save', 'edit-save-opts', 'edit-save-range', 'edit-split', 'edit-odd', 'edit-even', 'edit-reverse'].forEach((id) => {
        if (isBusy()) return;
        $(id).disabled = id === 'edit-reverse' ? pages.length < 2 : none;
      });
    }

    // ── 되돌리기 기록 (옮기기 · 회전 · 삭제 · 교체, 최대 50단계) ──
    const HISTORY_MAX = 50;
    let undoStack = [];
    let redoStack = [];
    const snap = () => pages.map((p) => ({ key: p.key, srcId: p.srcId, index: p.index, rot: p.rot, deleted: p.deleted }));

    /** fn이 pages를 바꾸면 바뀌기 전 상태를 label과 함께 기록한다. */
    function record(label, fn) {
      const before = snap();
      fn();
      if (JSON.stringify(before) !== JSON.stringify(snap())) {
        undoStack.push({ label, pages: before });
        if (undoStack.length > HISTORY_MAX) undoStack.shift();
        redoStack = [];
      }
      render();
    }
    // 기록 뒤에 파일을 넣거나 뺐을 수 있다: 없는 파일의 쪽은 버리고, 기록에 없던 새 쪽은 뒤에 남긴다.
    function restore(state) {
      const alive = new Set(sources.map((s) => s.id));
      const keys = new Set(state.map((p) => p.key));
      const extra = pages.filter((p) => !keys.has(p.key));
      pages = [...state.filter((p) => alive.has(p.srcId)).map((p) => ({ ...p })), ...extra];
    }
    function undo() {
      const last = undoStack.pop();
      if (!last) return toast('되돌릴 작업이 없어요.', '옮기기 · 회전 · 삭제 · 교체를 한 뒤에 되돌릴 수 있어요.', 'info');
      redoStack.push({ label: last.label, pages: snap() });
      restore(last.pages);
      render();
      toast(`되돌렸어요: ${last.label}`, 'Ctrl+Shift+Z(또는 Ctrl+Y)를 누르면 다시 해요.', 'info');
    }
    function redo() {
      const next = redoStack.pop();
      if (!next) return toast('다시 할 작업이 없어요.', '', 'info');
      undoStack.push({ label: next.label, pages: snap() });
      restore(next.pages);
      render();
      toast(`다시 했어요: ${next.label}`, '', 'info');
    }
    const byKey = () => new Map(pages.map((p) => [p.key, p]));
    function applyOrder(keys) {
      const m = byKey();
      pages = keys.map((k) => m.get(k));
    }

    // ── 여러 쪽 선택: 쪽 key의 Set + 기준점(anchor) ──
    let sel = new Set();
    let anchor = null;
    let selectMode = false; // 터치: 길게 눌러 켜는 선택 모드
    const selbar = $('edit-selbar');
    const selCount = $('sel-count');
    const selDel = $('sel-del');
    const selUndo = $('sel-undo');
    const afterForm = $('sel-after');
    const afterInput = $('sel-after-n');
    const selMenu = $('sel-menu');
    const selMore = $('sel-more');
    const selectedPages = () => pages.filter((p) => sel.has(p.key));

    function updateSelection() {
      const alive = new Set(pages.map((p) => p.key));
      for (const k of sel) if (!alive.has(k)) sel.delete(k);
      if (anchor && !alive.has(anchor)) anchor = null;
      if (!sel.size) selectMode = false;
      for (const [k, el] of cards) {
        const on = sel.has(k);
        el.classList.toggle('selected', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
        el.querySelector('.sel-check').setAttribute('aria-checked', on ? 'true' : 'false');
      }
      grid.classList.toggle('select-mode', selectMode);
      const n = sel.size;
      selbar.hidden = n === 0;
      $('edit-hint').hidden = pages.length === 0 || n > 0;
      if (!n) closeAfter();
      selCount.textContent = `${n}쪽 선택됨`;
      const allDeleted = n > 0 && selectedPages().every((p) => p.deleted);
      selDel.textContent = allDeleted ? '복구' : '삭제';
      selDel.title = allDeleted ? '선택한 쪽 되살리기' : '선택한 쪽 삭제 예정 (Delete)';
      selUndo.disabled = isBusy() || undoStack.length === 0;
    }
    function setSelection(keys, anc = anchor) {
      sel = new Set(keys);
      anchor = anc;
      updateSelection();
    }
    function clearSelection() {
      selectMode = false;
      setSelection([], null);
    }
    /** 클릭 규칙: 그냥 = 그 쪽만, Ctrl = 토글, Shift = 기준점부터 범위, Ctrl+Shift = 범위를 더하기 */
    function clickSelect(key, { ctrl = false, shift = false } = {}) {
      if (shift) {
        const order = pages.map((p) => p.key);
        const from = anchor && order.includes(anchor) ? anchor : key;
        const a = order.indexOf(from);
        const b = order.indexOf(key);
        const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
        setSelection(ctrl ? [...sel, ...range] : range, from);
      } else if (ctrl) {
        const next = new Set(sel);
        if (next.has(key)) next.delete(key); else next.add(key);
        setSelection(next, key);
      } else {
        setSelection([key], key);
      }
    }
    const nPages = (n) => `${n}쪽`;

    // ── 선택한 쪽 일괄 처리 ──
    function moveSelected(kind, n) {
      const ids = [...sel];
      if (!ids.length) return false;
      const order = pages.map((p) => p.key);
      let next;
      let label;
      if (kind === 'front') { next = Core.moveToFront(order, ids); label = `${nPages(ids.length)} 맨 앞으로`; }
      else if (kind === 'end') { next = Core.moveToEnd(order, ids); label = `${nPages(ids.length)} 맨 뒤로`; }
      else {
        const counted = keptPages().map((p) => p.key);
        try {
          next = Core.moveAfter(order, ids, n, counted);
        } catch (e) {
          showError(e);
          return false;
        }
        label = Number(n) === 0 ? `${nPages(ids.length)} 맨 앞으로` : `${nPages(ids.length)} ${Number(n)}쪽 다음으로`;
      }
      record(label, () => applyOrder(next));
      return true;
    }
    function rotateSelected(dir) {
      const ps = selectedPages();
      if (!ps.length) return;
      record(`${nPages(ps.length)} ${dir === 'left' ? '왼쪽' : '오른쪽'} 90°`, () => {
        ps.forEach((p) => (p.rot = Core.rotate(p.rot, dir)));
      });
    }
    function toggleDeleteSelected() {
      const ps = selectedPages();
      if (!ps.length) return;
      const restoreAll = ps.every((p) => p.deleted);
      record(`${nPages(ps.length)} ${restoreAll ? '복구' : '삭제'}`, () => ps.forEach((p) => (p.deleted = !restoreAll)));
    }
    async function saveSelected() {
      const ps = selectedPages().filter((p) => !p.deleted);
      if (!ps.length) return toast('저장할 쪽이 없어요.', '고른 쪽이 모두 "삭제 예정"이에요. [복구]를 먼저 눌러 주세요.');
      const first = srcById(ps[0].srcId);
      try {
        const bytes = await build(ps, '선택한 쪽 저장');
        download(bytes, `${safeName(baseName(first.name))}_선택${ps.length}쪽.pdf`);
      } catch (e) { showError(e); }
    }

    function openAfter() {
      afterForm.hidden = false;
      const max = keptPages().length;
      afterInput.placeholder = `0~${max}`;
      afterInput.value = '';
      selbar.querySelectorAll('[data-sel="after"]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
      afterInput.focus();
    }
    function closeAfter() {
      if (afterForm.hidden) return;
      afterForm.hidden = true;
      selbar.querySelectorAll('[data-sel="after"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    }
    afterForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (moveSelected('after', afterInput.value)) closeAfter();
      else afterInput.select();
    });
    afterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAfter(); }
    });

    function closeSelMenu() {
      selMenu.hidden = true;
      selMore.setAttribute('aria-expanded', 'false');
    }
    selMore.addEventListener('click', () => {
      const open = selMenu.hidden;
      selMenu.hidden = !open;
      selMore.setAttribute('aria-expanded', String(open));
      if (open) selMenu.querySelector('button')?.focus();
    });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.sel-more')) closeSelMenu(); });
    selMenu.addEventListener('keydown', (e) => {
      const items = [...selMenu.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSelMenu(); selMore.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    });

    selbar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sel]');
      if (!b || isBusy()) return;
      const act = b.dataset.sel;
      if (b.closest('#sel-menu')) closeSelMenu();
      if (act === 'rotl') rotateSelected('left');
      else if (act === 'rotr') rotateSelected('right');
      else if (act === 'front' || act === 'end') moveSelected(act);
      else if (act === 'after') { if (afterForm.hidden) openAfter(); else closeAfter(); }
      else if (act === 'after-close') closeAfter();
      else if (act === 'save') saveSelected();
      else if (act === 'del') toggleDeleteSelected();
      else if (act === 'undo') undo();
      else if (act === 'clear') clearSelection();
    });

    // 카드 버튼
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || isBusy()) return;
      const el = btn.closest('.page-card');
      const p = pages.find((x) => x.key === el.dataset.key);
      if (!p) return;
      const act = btn.dataset.act;
      const no = () => (p.deleted ? '삭제 예정 쪽' : `${keptPages().indexOf(p) + 1}번째 쪽`);
      if (act === 'check') {
        if (e.pointerType && e.pointerType !== 'mouse') selectMode = true;
        clickSelect(p.key, { ctrl: true });
      } else if (act === 'rot' || act === 'rotl') {
        const dir = act === 'rotl' ? 'left' : 'right';
        record(`${no()} ${dir === 'left' ? '왼쪽' : '오른쪽'} 90°`, () => (p.rot = Core.rotate(p.rot, dir)));
      } else if (act === 'del') {
        record(p.deleted ? `${no()} 복구` : `${no()} 삭제`, () => (p.deleted = !p.deleted));
      } else if (act === 'cut') {
        if (split.cuts.has(p.key)) split.cuts.delete(p.key); else split.cuts.add(p.key);
        updateSplit();
      } else if (act === 'rep') {
        Replace.open(p);
      }
    });

    // 카드를 탭하면 버튼을 보여 준다(선택 모드가 아닐 때, 터치).
    function hideAllTools(except) {
      grid.querySelectorAll('.show-tools').forEach((c) => c !== except && c.classList.remove('show-tools'));
    }
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#edit-grid .page-card')) hideAllTools(null);
    });

    // ── 누르기 · 끌기 · 네모 선택 (마우스 + 터치) ──
    const LONG_PRESS = 450;
    const EDGE = 60;
    let ptr = null; // 지금 누르고 있는 손가락/마우스
    let ghost = null;
    let marker = null;
    let box = null;
    let raf = 0;

    grid.addEventListener('pointerdown', (e) => {
      if (ptr && ptr.id !== e.pointerId && ptr.mode !== 'drag' && ptr.mode !== 'box') endPointer(); // 놓친 pointerup 정리
      if (ptr || isBusy()) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button, input, select, a, textarea')) return;
      const item = e.target.closest('.page-card');
      ptr = {
        id: e.pointerId, type: e.pointerType, item, key: item ? item.dataset.key : null,
        x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
        sx0: e.clientX + scrollX, sy0: e.clientY + scrollY,
        ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey,
        mode: item ? 'press' : 'empty', moved: false, longPressed: false, timer: 0,
      };
      if (!item) {
        // 빈 곳: 마우스는 네모 선택, 터치는 스크롤에 맡긴다.
        if (e.pointerType !== 'mouse') ptr = null;
        else e.preventDefault();
        return;
      }
      if (e.pointerType !== 'mouse' && !selectMode) {
        ptr.timer = setTimeout(() => {
          if (!ptr || ptr.moved) return;
          ptr.longPressed = true;
          selectMode = true;
          hideAllTools(null);
          setSelection([...sel, ptr.key], ptr.key);
          navigator.vibrate?.(15);
        }, LONG_PRESS);
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!ptr || e.pointerId !== ptr.id) return;
      ptr.x = e.clientX;
      ptr.y = e.clientY;
      if (ptr.mode === 'drag') { e.preventDefault(); updateDrag(); return; }
      if (ptr.mode === 'box') { e.preventDefault(); updateBox(); return; }
      if (Math.hypot(ptr.x - ptr.x0, ptr.y - ptr.y0) < 8) return;
      ptr.moved = true;
      clearTimeout(ptr.timer);
      if (ptr.mode === 'empty') { startBox(); return; }
      if (ptr.type === 'mouse' || ptr.longPressed || (selectMode && sel.has(ptr.key))) { e.preventDefault(); startDrag(); return; }
      endPointer(); // 터치로 그냥 밀면 화면 스크롤
    }, { passive: false });

    window.addEventListener('pointerup', (e) => finish(e, false));
    window.addEventListener('pointercancel', (e) => finish(e, true));
    document.addEventListener('touchmove', (e) => {
      if (ptr && (ptr.mode === 'drag' || ptr.longPressed)) e.preventDefault();
    }, { passive: false });
    grid.addEventListener('contextmenu', (e) => {
      if (ptr || selectMode) e.preventDefault();
    });

    function startDrag() {
      if (!sel.has(ptr.key)) setSelection([ptr.key], ptr.key); // 선택 안 된 쪽을 끌면 그 쪽만
      ptr.mode = 'drag';
      ptr.group = pages.filter((p) => sel.has(p.key)).map((p) => p.key);
      const n = ptr.group.length;
      // 커서 옆에 겹친 카드 + "N쪽" 배지
      const face = ptr.item.querySelector('.paper').cloneNode(true);
      const srcCanvas = ptr.item.querySelector('canvas');
      const c2 = face.querySelector('canvas');
      if (srcCanvas && c2 && srcCanvas.width) c2.getContext('2d').drawImage(srcCanvas, 0, 0);
      face.querySelectorAll('.del-band').forEach((b) => b.remove());
      ghost = h('div', { class: `drag-stack${n > 1 ? ' multi' : ''}` },
        n > 2 ? h('div', { class: 'stack-back b2' }) : null,
        n > 1 ? h('div', { class: 'stack-back b1' }) : null,
        face,
        h('span', { class: 'stack-badge' }, `${n}쪽`));
      ghost.style.setProperty('--c', getComputedStyle(ptr.item).getPropertyValue('--c'));
      document.body.append(ghost);
      marker = h('div', { class: 'drop-marker' });
      document.body.append(marker);
      ptr.group.forEach((k) => cards.get(k)?.classList.add('dragging'));
      document.body.classList.add('is-dragging');
      if (ptr.type !== 'mouse') navigator.vibrate?.(12);
      updateDrag();
      autoScroll();
    }

    function updateDrag() {
      if (!ptr || ptr.mode !== 'drag') return;
      ghost.style.left = `${ptr.x + 14}px`;
      ghost.style.top = `${ptr.y + 10}px`;
      let best = null;
      let bestD = Infinity;
      pages.forEach((p, i) => {
        const r = cards.get(p.key).getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        // 같은 줄을 먼저 고르도록 세로 거리에 가중치를 준다.
        const d = Math.abs(ptr.x - cx) + Math.abs(ptr.y - cy) * 2;
        if (d < bestD) { bestD = d; best = { i, r, after: ptr.x > cx }; }
      });
      if (!best) return;
      ptr.target = best;
      const gap = 7;
      const x = best.after ? best.r.right + gap : best.r.left - gap;
      marker.style.left = `${x - 2}px`;
      marker.style.top = `${best.r.top}px`;
      marker.style.height = `${best.r.height}px`;
    }

    function startBox() {
      ptr.mode = 'box';
      ptr.base = ptr.ctrl ? new Set(sel) : new Set();
      box = h('div', { class: 'select-box' });
      document.body.append(box);
      document.body.classList.add('is-dragging');
      updateBox();
      autoScroll();
    }
    function updateBox() {
      if (!ptr || ptr.mode !== 'box') return;
      const x1 = Math.min(ptr.sx0, ptr.x + scrollX);
      const y1 = Math.min(ptr.sy0, ptr.y + scrollY);
      const x2 = Math.max(ptr.sx0, ptr.x + scrollX);
      const y2 = Math.max(ptr.sy0, ptr.y + scrollY);
      Object.assign(box.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
      const hits = [];
      for (const p of pages) {
        const r = cards.get(p.key).getBoundingClientRect();
        const l = r.left + scrollX;
        const t = r.top + scrollY;
        if (l < x2 && l + r.width > x1 && t < y2 && t + r.height > y1) hits.push(p.key);
      }
      const next = new Set([...ptr.base, ...hits]);
      if (next.size !== sel.size || [...next].some((k) => !sel.has(k))) {
        setSelection(next, hits.length ? hits[0] : anchor);
      }
    }

    // 끄는 중 화면 위·아래 가장자리 60px 안이면 자동 스크롤(가까울수록 빠르게)
    function autoScroll() {
      cancelAnimationFrame(raf);
      const step = () => {
        if (!ptr || (ptr.mode !== 'drag' && ptr.mode !== 'box')) return;
        const barRect = bar.hidden ? null : bar.getBoundingClientRect();
        // 아래쪽은 저장 막대에 가려지므로 막대 위쪽을 화면 끝으로 본다.
        const bottom = barRect && barRect.top > innerHeight / 2 ? Math.min(innerHeight, barRect.top) : innerHeight;
        let dy = 0;
        if (ptr.y < EDGE) dy = -Math.ceil(((EDGE - Math.max(0, ptr.y)) / EDGE) * 24);
        else if (ptr.y > bottom - EDGE) dy = Math.ceil(((Math.min(bottom, ptr.y) - (bottom - EDGE)) / EDGE) * 24);
        if (dy) {
          const before = scrollY;
          window.scrollBy(0, dy);
          if (scrollY !== before) { if (ptr.mode === 'drag') updateDrag(); else updateBox(); }
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }

    function finish(e, cancelled) {
      if (!ptr || e.pointerId !== ptr.id) return;
      const s = ptr;
      if (s.mode === 'drag') {
        if (!cancelled && s.target) {
          const gapIndex = s.target.i + (s.target.after ? 1 : 0);
          const next = Core.moveGroup(pages.map((p) => p.key), s.group, gapIndex);
          endPointer();
          record(`${nPages(s.group.length)} 옮기기`, () => applyOrder(next));
          return;
        }
      } else if (s.mode === 'empty' && !cancelled) {
        // 빈 곳을 그냥 클릭하면 선택 해제
        if (!s.ctrl && !s.shift) clearSelection();
      } else if (s.mode === 'press' && !s.moved && !cancelled) {
        if (s.type === 'mouse') {
          clickSelect(s.key, { ctrl: s.ctrl, shift: s.shift });
        } else if (s.longPressed) {
          // 길게 눌러 이미 골랐다.
        } else if (selectMode) {
          clickSelect(s.key, { ctrl: true });
          if (!sel.size) clearSelection();
        } else {
          hideAllTools(s.item);
          s.item.classList.toggle('show-tools');
        }
      }
      endPointer();
    }

    function endPointer() {
      if (!ptr) return;
      clearTimeout(ptr.timer);
      cancelAnimationFrame(raf);
      grid.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
      ghost?.remove();
      marker?.remove();
      box?.remove();
      ghost = marker = box = null;
      document.body.classList.remove('is-dragging');
      ptr = null;
    }

    // 키보드: 카드에서 Space = 선택 토글(Shift+Space = 범위), Alt+←/→ = 한 칸 옮기기
    grid.addEventListener('keydown', (e) => {
      const el = e.target.closest('.page-card');
      if (!el || e.target !== el) return;
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        clickSelect(el.dataset.key, { ctrl: !e.shiftKey || e.ctrlKey || e.metaKey, shift: e.shiftKey });
        return;
      }
      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const i = pages.findIndex((p) => p.key === el.dataset.key);
      const j = e.key === 'ArrowLeft' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= pages.length) return;
      record('1쪽 옮기기', () => moveItem(pages, i, j));
      el.focus();
    });

    // 단축키 (입력칸에 포커스가 없을 때만)
    document.addEventListener('keydown', (e) => {
      if (activeView !== 'work' || activeTab !== 'edit' || isBusy() || e.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'a') {
        if (!pages.length) return;
        e.preventDefault();
        setSelection(pages.map((p) => p.key), anchor || pages[0].key);
      } else if (mod && ((k === 'z' && e.shiftKey) || k === 'y')) {
        e.preventDefault();
        redo();
      } else if (mod && k === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size && !mod) {
        e.preventDefault();
        toggleDeleteSelected();
      } else if (e.key === 'Escape' && sel.size) {
        clearSelection();
      } else if (e.key === 'Escape' && !splitPanel.hidden) {
        openSplit(false);
      }
    });

    rangeInput.addEventListener('input', updateCount);
    document.addEventListener('busyend', () => { updateCount(); updateSelection(); });
    rangeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveRange(); }
    });

    // 홀수/짝수/역순: 순서와 선택만 바꾼다.
    function keepParity(odd) {
      const kept = keptPages();
      if (!kept.length) return;
      let dropped = 0;
      record(`${odd ? '홀수' : '짝수'}만 남기기`, () => kept.forEach((p, i) => {
        const isOdd = (i + 1) % 2 === 1;
        if (isOdd !== odd) { p.deleted = true; dropped++; }
      }));
      toast(`${odd ? '홀수' : '짝수'} 번호만 남겼어요.`, `${dropped}쪽이 "삭제 예정"이 됐어요. Ctrl+Z로 한 번에 되돌릴 수 있어요.`, 'info');
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
      record('순서 뒤집기', () => pages.reverse());
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

    // ── 설정하고 저장… ──
    /** 미리보기용 쪽 목록 */
    function makeSource(list) {
      return {
        count: list.length,
        selected: list.map((p, i) => (sel.has(p.key) ? i : -1)).filter((i) => i >= 0),
        async getPage(i) {
          const p = list[i];
          const pdf = await getPdfjs(srcById(p.srcId));
          return { page: await pdf.getPage(p.index + 1), rot: p.rot };
        },
      };
    }
    const metaText = (kept) => `${kept.length}쪽 · 삭제 예정 ${pages.length - kept.length}쪽 제외`;

    function openSaveDialog() {
      const kept = keptPages();
      if (!kept.length) return toast('저장할 쪽이 없어요.', 'PDF를 넣거나 "삭제 예정" 쪽을 되살려 주세요.');
      const source = makeSource(kept);
      SaveDialog.open({
        name: saveStem(kept, `합본_${ymd()}`),
        meta: metaText(kept),
        source,
        run: async (o, name) => {
          try {
            const r = await withBusy('저장 준비 중…', async (progress, signal) => {
              const doc = await Core.assemble(toList(kept), (d, n) => progress(`${d}번째 쪽 가져오는 중 (${d}/${n})`, d, n));
              return applyOptions(doc, o, progress, signal, { selected: source.selected });
            }, { cancellable: true });
            download(r.bytes, `${name}.pdf`);
            if (r.sizeNote && r.sizeNote.status !== 'done') {
              toast(`목표보다 ${fmtMB(r.bytes.length - Number(o.size.mb) * MB)} 커요.`, `지금 ${fmtMB(r.bytes.length)}까지 줄였어요. 목표를 조금 올리거나 "용량 줄이기" 도구에서 비교해 보세요.`, 'info', 9000);
            }
          } catch (e) { showError(e); }
        },
      });
    }

    // ── 나눠 저장 패널 ──
    const splitPanel = $('split-panel');
    const split = { mode: 'each', cuts: new Set() };
    const splitNum = (id) => {
      const v = $(id).value.trim();
      return /^\d+$/.test(v) ? Number(v) : NaN;
    };
    function cutPositions() {
      let count = 0;
      const out = [];
      for (const p of pages) {
        if (!p.deleted) count++;
        if (split.cuts.has(p.key) && count > 0) out.push(count);
      }
      return [...new Set(out)];
    }
    function splitPlan() {
      const param = split.mode === 'every' ? splitNum('split-every') : split.mode === 'parts' ? splitNum('split-parts') : split.mode === 'cuts' ? cutPositions() : undefined;
      return Core.splitGroups(pages, split.mode, param);
    }
    const splitStem = () => safeName(saveStem(keptPages(), `합본_${ymd()}`));

    function openSplit(on) {
      splitPanel.hidden = !on;
      $('edit-split').setAttribute('aria-expanded', String(on));
      grid.classList.toggle('cut-mode', on && split.mode === 'cuts');
      if (on) {
        updateSplit();
        splitPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    $('edit-split').addEventListener('click', () => openSplit(splitPanel.hidden));
    $('split-close').addEventListener('click', () => { openSplit(false); $('edit-split').focus(); });
    splitPanel.addEventListener('change', (e) => {
      if (e.target.name === 'split-mode') {
        split.mode = e.target.value;
        grid.classList.toggle('cut-mode', split.mode === 'cuts');
      }
      updateSplit();
    });
    splitPanel.addEventListener('input', (e) => {
      if (e.target.id === 'split-every' || e.target.id === 'split-parts') {
        const mode = e.target.id === 'split-every' ? 'every' : 'parts';
        splitPanel.querySelector(`input[name="split-mode"][value="${mode}"]`).checked = true;
        split.mode = mode;
        grid.classList.remove('cut-mode');
      }
      updateSplit();
    });
    splitPanel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-every]');
      if (!b) return;
      e.preventDefault();
      $('split-every').value = b.dataset.every;
      splitPanel.querySelector('input[name="split-mode"][value="every"]').checked = true;
      split.mode = 'every';
      grid.classList.remove('cut-mode');
      updateSplit();
    });

    function updateSplit() {
      for (const [k, el] of cards) {
        const on = split.cuts.has(k);
        el.classList.toggle('cut-after', on);
        const slot = el.querySelector('.cut-slot');
        if (slot) slot.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (splitPanel.hidden) return;
      let groups = [];
      let err = null;
      try { groups = splitPlan(); } catch (e) { err = e; }
      splitPanel.querySelectorAll('.mode-card').forEach((c) => c.classList.toggle('on', c.querySelector('input[type="radio"]').checked));
      const kept = keptPages().length;
      // 미니 쪽 줄 (자르는 곳에 ✂)
      const strip = $('split-strip');
      const bits = [];
      if (kept <= 300) {
        groups.forEach((g, gi) => {
          for (let i = 0; i < g.items.length; i++) bits.push(h('i', { class: gi % 2 ? 'alt' : null }));
          if (gi < groups.length - 1) bits.push(h('b', null, '✂'));
        });
      } else {
        groups.forEach((g, gi) => {
          bits.push(h('i', { class: `wide${gi % 2 ? ' alt' : ''}`, style: `flex-grow:${g.items.length}` }));
          if (gi < groups.length - 1 && groups.length < 60) bits.push(h('b', null, '✂'));
        });
      }
      strip.replaceChildren(...bits);
      const stem = splitStem();
      $('split-files').replaceChildren(...groups.slice(0, 3).map((g, i) =>
        h('li', null, h('span', { class: 'f-name' }, Core.splitFileName(stem, i, groups.length, g.from, g.to)), h('span', { class: 'f-meta' }, `${g.items.length}쪽`))));
      const more = $('split-more');
      more.classList.toggle('err', !!err);
      if (err) more.textContent = `${err.title} ${err.fix || ''}`.trim();
      else if (!groups.length) more.textContent = '저장할 쪽이 없어요.';
      else if (groups.length > 3) more.textContent = `… 모두 ${groups.length}개 · 마지막 파일은 ${groups[groups.length - 1].items.length}쪽`;
      else more.textContent = `모두 ${groups.length}개`;
      const n = err ? 0 : groups.length;
      $('split-save').textContent = n ? `${n}개 파일 저장` : '파일 저장';
      $('split-save').disabled = isBusy() || !n;
      $('split-save-opts').disabled = isBusy() || !n;
      const cuts = cutPositions().length;
      $('split-cut-hint').textContent = split.mode === 'cuts'
        ? (cuts ? `✂ ${cuts}곳에서 잘라요. 카드 사이를 다시 누르면 빠져요.` : '카드 사이에 마우스를 올리고(휴대폰은 탭) ✂를 눌러요.')
        : '카드 사이 ✂를 눌러 자를 곳을 정해요';
    }

    async function saveSplitFiles(o, stemIn) {
      let groups;
      try { groups = splitPlan(); } catch (e) { return showError(e); }
      if (!groups.length) return toast('저장할 쪽이 없어요.', 'PDF를 넣거나 "삭제 예정" 쪽을 되살려 주세요.');
      const stem = safeName(stemIn || splitStem());
      const zipOn = $('split-zip').checked;
      const withOpts = o && hasAnyOption(o);
      try {
        const files = await withBusy('나누는 중…', async (progress, signal) => {
          const out = [];
          for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const label = groups.length > 1 ? `${i + 1}/${groups.length}번째 파일 · ` : '';
            await progress(`${label}쪽 모으는 중`, i, groups.length);
            const doc = await Core.assemble(toList(g.items));
            let bytes;
            if (withOpts) {
              const selected = g.items.map((p, j) => (sel.has(p.key) ? j : -1)).filter((j) => j >= 0);
              ({ bytes } = await applyOptions(doc, o, progress, signal, { label, selected }));
            } else bytes = await doc.save();
            out.push({ name: Core.splitFileName(stem, i, groups.length, g.from, g.to), bytes });
          }
          if (!zipOn || out.length === 1) return out;
          const zip = new JSZip();
          out.forEach((f) => zip.file(f.name, f.bytes));
          const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => busy.set(`zip으로 묶는 중 (${Math.round(m.percent)}%)`, m.percent, 100));
          return [{ name: `${stem}_나눔.zip`, blob }];
        }, { cancellable: true });
        if (files.length === 1) {
          const f = files[0];
          download(f.blob || f.bytes, f.name, f.blob ? 'application/zip' : 'application/pdf');
        } else {
          // zip 없이 여러 개: 브라우저가 막지 않도록 조금씩 간격을 둔다.
          for (let i = 0; i < files.length; i++) {
            download(files[i].bytes, files[i].name);
            await new Promise((r) => setTimeout(r, 350));
          }
          toast(`${files.length}개 파일 저장을 시작했어요.`, '브라우저가 "여러 파일 다운로드"를 물으면 허용해 주세요.', 'ok');
        }
      } catch (e) { showError(e); }
    }
    $('split-save').addEventListener('click', () => saveSplitFiles(null));
    function openSplitDialog() {
      let groups;
      try { groups = splitPlan(); } catch (e) { return showError(e); }
      if (!groups.length) return toast('저장할 쪽이 없어요.', '');
      const kept = keptPages();
      SaveDialog.open({
        title: `설정하고 나눠 저장 (${groups.length}개 파일)`,
        name: splitStem(),
        meta: `${metaText(kept)} · ${groups.length}개 파일 · 쪽번호는 파일마다 1부터`,
        source: makeSource(groups[0].items),
        run: (o, name) => saveSplitFiles(o, name),
      });
    }
    $('split-save-opts').addEventListener('click', openSplitDialog);

    $('edit-save').addEventListener('click', saveAll);
    $('edit-save-opts').addEventListener('click', openSaveDialog);
    $('edit-save-range').addEventListener('click', saveRange);
    wireDrop($('edit-drop'), $('edit-input'), (files) => addFiles(files));

    /** Ctrl+S / Ctrl+Shift+S */
    function shortcutSave(withOpts) {
      if (!pages.length) return toast('저장할 쪽이 없어요.', 'PDF를 먼저 넣어 주세요.', 'info');
      if (!splitPanel.hidden) return withOpts ? openSplitDialog() : saveSplitFiles(null);
      return withOpts ? openSaveDialog() : saveAll();
    }

    function reset() {
      sources.forEach((s) => s.pdfjs && s.pdfjs.then((d) => d.destroy()).catch(() => {}));
      sources = [];
      pages = [];
      cards.forEach((el) => io.unobserve(el));
      cards.clear();
      grid.replaceChildren();
      rangeInput.value = '';
      colorSeq = 0;
      undoStack = [];
      redoStack = [];
      sel.clear();
      anchor = null;
      selectMode = false;
      split.cuts.clear();
      openSplit(false);
      render();
    }

    render();

    return {
      addFiles, addDecrypted, reset, render, removeSource, shortcutSave,
      get sources() { return sources; },
      getPdfjs, srcById,
      replacePage(p, srcId, index) {
        record('쪽 교체', () => {
          p.srcId = srcId;
          p.index = index;
          p.rot = 0;
        });
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
        toast('쪽을 바꿨어요.', 'Ctrl+Z(또는 선택 막대의 [되돌리기])로 되돌릴 수 있어요.', 'ok');
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
  // 공용: 글꼴 · 쪽을 그림으로 · 서명/도장 보관 · 확인 창 · 용량 줄이기 실행기
  // ═══════════════════════════════════════════════════════════
  const MB = 1024 * 1024;
  const fmtMB = (n) => {
    const v = n / MB;
    return v >= 10 ? `${v.toFixed(1).replace(/\.0$/, '')}MB` : v >= 0.1 ? `${v.toFixed(2).replace(/0$/, '')}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = h('script', { src });
      el.onload = resolve;
      el.onerror = () => { el.remove(); reject(new Error(`${src}를 불러오지 못했어요`)); };
      document.head.append(el);
    });
  }

  // 한글 워터마크 글꼴: 워터마크를 쓸 때만 불러온다.
  let fontkitLoading = null;
  let fontBytes = null;
  async function watermarkFont(doc) {
    try {
      if (!window.fontkit) {
        if (!fontkitLoading) fontkitLoading = loadScript('/vendor/fontkit.min.js');
        await fontkitLoading;
      }
      if (!fontBytes) {
        const res = await fetch('/vendor/fonts/Pretendard-Bold.otf');
        if (!res.ok) throw new Error(`글꼴 응답 ${res.status}`);
        fontBytes = new Uint8Array(await res.arrayBuffer());
      }
    } catch (e) {
      fontkitLoading = null;
      console.warn(e);
      throw new UserError('워터마크 글꼴을 불러오지 못했어요.', '인터넷 연결을 확인하고 다시 해 주세요. 글꼴은 이 서버에서만 받아요.');
    }
    return Core.embedFont(doc, window.fontkit, fontBytes);
  }

  function canvasToBytes(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(async (b) => {
      if (!b) return reject(new UserError('메모리가 부족해 그림을 만들지 못했어요.', '선명도를 낮추거나 쪽 수를 줄여 주세요.'));
      resolve(new Uint8Array(await b.arrayBuffer()));
    }, type, quality));
  }

  /** 쪽을 dpi 해상도 캔버스로 그린다. 한 변 8192px, 1,670만 화소를 넘으면 낮춘다. */
  async function renderPageCanvas(page, dpi, extraRot = 0, { white = true } = {}) {
    const rotation = Core.normAngle(page.rotate + extraRot);
    const vp1 = page.getViewport({ scale: 1, rotation });
    let scale = dpi / 72;
    const fit = Math.min(1, Math.sqrt(16.7e6 / (vp1.width * vp1.height * scale * scale)),
      8192 / (vp1.width * scale), 8192 / (vp1.height * scale));
    scale *= fit;
    const vp = page.getViewport({ scale, rotation });
    const c = makeCanvas(vp.width, vp.height);
    const ctx = c.getContext('2d');
    if (white) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { canvas: c, reduced: fit < 0.999, vp1 };
  }

  /** 모든 쪽을 JPEG 그림으로 바꾼 새 PDF (워터마크 굳히기, 용량 줄이기 3단계) */
  async function rasterizePdf(bytes, { dpi, q }, progress, signal) {
    const pdf = await openPdfjs(bytes);
    try {
      const out = await PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        if (signal && signal.aborted) throw abortError();
        if (progress) await progress(`쪽을 그림으로 바꾸는 중 (${i}/${pdf.numPages})`, i - 1, pdf.numPages);
        const page = await pdf.getPage(i);
        const { canvas, vp1 } = await renderPageCanvas(page, dpi);
        const jpg = await canvasToBytes(canvas, 'image/jpeg', q);
        canvas.width = canvas.height = 0;
        page.cleanup();
        const img = await out.embedJpg(jpg);
        out.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      }
      return await out.save({ useObjectStreams: true });
    } finally {
      pdf.destroy();
    }
  }

  /** 3단계: 쪽을 사진으로 바꿔 목표에 맞춘다. 표본 쪽 몇 장으로 크기를 추정하며 dpi · 품질을 이진 탐색 */
  async function rasterEstimate(bytes, signal) {
    const pdf = await openPdfjs(bytes);
    try {
      const n = pdf.numPages;
      const picks = [...new Set([1, Math.ceil(n / 2), n])];
      const memo = new Map();
      return {
        pages: n,
        async size(t) {
          if (memo.has(t)) return memo.get(t);
          const { dpi, q } = Compress.rasterParams(t);
          let sum = 0;
          for (const no of picks) {
            if (signal && signal.aborted) throw abortError();
            const page = await pdf.getPage(no);
            const { canvas } = await renderPageCanvas(page, dpi);
            sum += (await canvasToBytes(canvas, 'image/jpeg', q)).length;
            canvas.width = canvas.height = 0;
          }
          const est = Math.round((sum / picks.length) * n * 1.02 + 3000 + n * 600);
          memo.set(t, est);
          return est;
        },
        close() { pdf.destroy(); },
      };
    } catch (e) { pdf.destroy(); throw e; }
  }
  async function rasterToTarget(bytes, target, progress, signal) {
    const est = await rasterEstimate(bytes, signal);
    let t;
    try {
      await progress('쪽을 그림으로 바꿀 크기를 찾는 중…', 0, 1);
      t = (await Compress.searchT((x) => est.size(x), target * 0.95, { steps: 6, signal })).t;
    } finally { est.close(); }
    let out = await rasterizePdf(bytes, Compress.rasterParams(t), progress, signal);
    if (out.length > target && t > 0) out = await rasterizePdf(bytes, Compress.rasterParams(Math.max(0, t - 0.2)), progress, signal);
    return out;
  }

  // ── 확인 창 (브라우저 confirm 대신) ──
  function confirmBox({ title, body, yes = '확인', no = '취소' }) {
    const dlg = $('confirm-dialog');
    $('cf-title').textContent = title;
    $('cf-body').textContent = body;
    $('cf-yes').textContent = yes;
    $('cf-no').textContent = no;
    // 진행 표시가 떠 있는 동안에도 누를 수 있어야 한다(진행 표시는 버튼을 잠근다)
    $('cf-yes').disabled = false;
    $('cf-no').disabled = false;
    return new Promise((resolve) => {
      const done = () => {
        dlg.removeEventListener('close', done);
        resolve(dlg.returnValue === 'yes');
      };
      dlg.returnValue = '';
      dlg.addEventListener('close', done);
      dlg.showModal();
      $('cf-yes').focus();
    });
  }

  // ── 서명 · 도장 보관 (이 브라우저에만: IndexedDB, 안 되면 이번 방문 동안만) ──
  const Stamps = (() => {
    let items = null;
    let dbp = null;
    const listeners = new Set();
    function db() {
      if (!dbp) {
        dbp = new Promise((resolve) => {
          try {
            const req = indexedDB.open('pdf-workshop', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('stamps', { keyPath: 'id' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
          } catch { resolve(null); }
        });
      }
      return dbp;
    }
    const tx = async (mode, fn) => {
      const d = await db();
      if (!d) return null;
      return new Promise((resolve) => {
        try {
          const t = d.transaction('stamps', mode);
          const r = fn(t.objectStore('stamps'));
          t.oncomplete = () => resolve(r && r.result);
          t.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    };
    async function list() {
      if (!items) {
        const rows = (await tx('readonly', (st) => st.getAll())) || [];
        items = rows.sort((a, b) => a.created - b.created).map((r) => ({ ...r, bytes: new Uint8Array(r.bytes) }));
      }
      return items;
    }
    const notify = () => listeners.forEach((f) => f());
    async function add(item) {
      await list();
      const it = { id: `st${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, created: Date.now(), clearWhite: false, ...item };
      items.push(it);
      await tx('readwrite', (st) => st.put({ ...it, bytes: it.bytes.buffer.slice(0) }));
      notify();
      return it;
    }
    async function update(it) {
      delete it.processed;
      await tx('readwrite', (st) => st.put({ ...it, bytes: it.bytes.buffer.slice(0), processed: undefined, url: undefined }));
      if (it.url) { URL.revokeObjectURL(it.url); delete it.url; }
      notify();
    }
    async function remove(id) {
      await list();
      const it = items.find((x) => x.id === id);
      if (it && it.url) URL.revokeObjectURL(it.url);
      items = items.filter((x) => x.id !== id);
      await tx('readwrite', (st) => st.delete(id));
      notify();
    }
    /** 실제로 넣을 PNG (흰 배경 지우기 반영) */
    async function pngOf(it) {
      if (!it.clearWhite) return it.bytes;
      if (!it.processed) it.processed = await whiteToAlpha(it.bytes);
      return it.processed;
    }
    async function urlOf(it) {
      if (!it.url) it.url = URL.createObjectURL(new Blob([await pngOf(it)], { type: 'image/png' }));
      return it.url;
    }
    const byId = (id) => (items || []).find((x) => x.id === id);
    return { list, add, update, remove, pngOf, urlOf, byId, onChange: (f) => listeners.add(f) };
  })();

  /** 밝은(흰) 부분을 투명하게. 스캔한 도장용 */
  async function whiteToAlpha(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = makeCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum >= 235) d[i + 3] = 0;
      else if (lum > 195) d[i + 3] = Math.round(d[i + 3] * ((235 - lum) / 40));
    }
    ctx.putImageData(img, 0, 0);
    return canvasToBytes(c, 'image/png');
  }

  /** 올린 그림을 PNG로(너무 크면 긴 변 1200px로 줄여 보관) */
  async function imageFileToPng(file) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw new UserError(`"${file.name}"을(를) 그림으로 읽지 못했어요.`, 'PNG나 JPG 파일을 골라 주세요.');
    }
    const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const c = makeCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    return { bytes: await canvasToBytes(c, 'image/png'), w: c.width, h: c.height };
  }

  // ── 손으로 서명 그리기 ──
  const SignPad = (() => {
    const dlg = $('sign-dialog');
    const canvas = $('sign-canvas');
    let ctx = null;
    let drawing = null;
    let dirty = false;
    let resolveFn = null;
    const penW = () => Number(document.querySelector('input[name="sign-w"]:checked').value);
    const penC = () => document.querySelector('input[name="sign-c"]:checked').value;
    function setup() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      dirty = false;
      dlg.classList.remove('dirty');
    }
    const pt = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const p = pt(e);
      drawing = { last: p, mid: p };
      ctx.strokeStyle = penC();
      ctx.fillStyle = penC();
      ctx.lineWidth = penW();
      ctx.beginPath();
      ctx.arc(p.x, p.y, penW() / 2, 0, Math.PI * 2);
      ctx.fill();
      dirty = true;
      dlg.classList.add('dirty');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pt(e);
      const mid = { x: (drawing.last.x + p.x) / 2, y: (drawing.last.y + p.y) / 2 };
      ctx.beginPath();
      ctx.moveTo(drawing.mid.x, drawing.mid.y);
      ctx.quadraticCurveTo(drawing.last.x, drawing.last.y, mid.x, mid.y);
      ctx.stroke();
      drawing = { last: p, mid };
    });
    const end = () => { drawing = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    $('sign-clear').addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; dlg.classList.remove('dirty'); });
    $('sign-cancel').addEventListener('click', () => dlg.close('cancel'));

    /** 그린 부분만 잘라 투명 PNG로 */
    async function trimmed() {
      const w = canvas.width;
      const hh = canvas.height;
      const d = canvas.getContext('2d').getImageData(0, 0, w, hh).data;
      let x0 = w; let y0 = hh; let x1 = -1; let y1 = -1;
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 8) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return null;
      const pad = 6;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
      x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(hh - 1, y1 + pad);
      const out = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
      out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
      return { bytes: await canvasToBytes(out, 'image/png'), w: out.width, h: out.height };
    }
    $('sign-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!dirty) { toast('서명판이 비어 있어요.', '마우스나 손가락으로 서명한 뒤 저장해 주세요.', 'info'); return; }
      const r = await trimmed();
      dlg.close('ok');
      if (resolveFn) resolveFn(r);
      resolveFn = null;
    });
    dlg.addEventListener('close', () => {
      if (resolveFn) { resolveFn(null); resolveFn = null; }
    });
    function open() {
      return new Promise((resolve) => {
        resolveFn = resolve;
        dlg.showModal();
        requestAnimationFrame(setup);
      });
    }
    return { open };
  })();

  // ── 용량 줄이기 실행기: Web Worker(OffscreenCanvas) 또는 메인 스레드 ──
  // Worker가 죽거나(onerror) 30초 동안 말이 없거나 메모리가 모자라면 메인 스레드에서 쉬어 가며 다시 한다.
  const Squeeze = (() => {
    // 주소에 ?worker=0 이 있으면 메인 스레드만 쓴다(메모리 측정 · 검증용)
    const noWorker = /[?&]worker=0(&|$)/.test(location.search);
    const workerOk = !noWorker && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' &&
      typeof OffscreenCanvas.prototype.convertToBlob === 'function';
    const SILENT_MS = 30000;
    let worker = null;
    let seq = 0;
    const pending = new Map();
    const died = (message) => Object.assign(new Error(message), { workerDied: true });
    function failAll(err) {
      pending.forEach((p) => { clearTimeout(p.watch); p.reject(err); });
      pending.clear();
      if (worker) worker.terminate();
      worker = null;
    }
    function watch(p) {
      clearTimeout(p.watch);
      p.watch = setTimeout(() => failAll(died('용량 줄이기 작업이 30초 동안 응답이 없어요.')), SILENT_MS);
    }
    function getWorker() {
      if (worker) return worker;
      worker = new Worker(`compress-worker.js?v=${encodeURIComponent(VER)}`);
      worker.onmessage = (e) => {
        const { id, progress, result, error } = e.data;
        const p = pending.get(id);
        if (!p) return;
        watch(p);
        if (progress) { if (p.onProgress) p.onProgress(progress); return; }
        clearTimeout(p.watch);
        pending.delete(id);
        if (error) p.reject(Object.assign(new Error(error.message), { name: error.name || 'Error', stack: error.stack || '' }));
        else p.resolve(result);
      };
      worker.onerror = (e) => {
        e.preventDefault();
        failAll(died(`용량 줄이기 작업이 멈췄어요: ${e.message || '알 수 없는 오류'}`));
      };
      worker.onmessageerror = () => failAll(died('용량 줄이기 결과를 받지 못했어요.'));
      return worker;
    }
    function kill() {
      pending.forEach((p) => clearTimeout(p.watch));
      failAll(abortError());
    }
    let codec = null;
    const mainCodec = () => (codec = codec || Compress.browserCodec());
    function runMain(cmd, bytes, target, { onProgress, signal } = {}) {
      // 메인 스레드: 사진 하나마다 쉬어 가며 화면이 멈추지 않게 한다.
      const opts = { signal, onProgress: async (p) => { if (onProgress) onProgress(p); await breathe(true); } };
      return cmd === 'analyze' ? Compress.analyzePdf(bytes, mainCodec(), opts) : Compress.compressPdf(bytes, target, mainCodec(), opts);
    }
    function runWorker(cmd, bytes, target, { onProgress, signal } = {}) {
      const w = getWorker();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const p = { resolve, reject, onProgress };
        pending.set(id, p);
        watch(p);
        if (signal) signal.addEventListener('abort', kill, { once: true });
        const copy = bytes.slice();
        w.postMessage({ id, cmd, bytes: copy, target }, [copy.buffer]);
      });
    }
    async function run(cmd, bytes, target, opts = {}) {
      if (opts.signal && opts.signal.aborted) throw abortError();
      if (!workerOk) return runMain(cmd, bytes, target, opts);
      try {
        // 검증용: Worker가 죽은 것처럼 한 번 실패시킨다
        if (self.__pdfTestFailWorker) { self.__pdfTestFailWorker = false; throw died('검증용: Worker가 멈춘 것처럼'); }
        return await runWorker(cmd, bytes, target, opts);
      } catch (e) {
        if (isAbort(e)) throw e;
        if (!e.workerDied && !isMemoryError(e)) throw e;
        console.warn('Worker 실패 → 메인 스레드에서 다시', e);
        noteStage('Worker 실패 → 화면에서 다시 시도');
        busy.set('다른 방법으로 다시 하는 중… (화면이 조금 느려질 수 있어요)');
        return runMain(cmd, bytes, target, opts);
      }
    }
    return {
      inWorker: workerOk,
      analyze: (bytes, opts) => run('analyze', bytes, 0, opts),
      compress: (bytes, target, opts) => run('compress', bytes, target, opts),
      codec: mainCodec,
      /** 검증용: Worker를 일부러 죽인다 */
      _crash: () => failAll(died('검증용으로 Worker를 멈췄어요.')),
    };
  })();

  const STAGE_TEXT = { tidy: '정리 중', search: '알맞은 크기 찾는 중', images: '사진 줄이는 중', save: '확인 중', check: '확인 중' };
  const stageText = (p) => (p.phase === 'images' ? `사진 줄이는 중 ${p.done + 1}/${p.total}` : p.phase === 'search' && p.total ? `알맞은 크기 찾는 중 (${p.done + 1}/${p.total})` : STAGE_TEXT[p.phase] || '처리 중');

  /**
   * PDF를 목표 이하로. 2단계로 부족하면 3단계(쪽을 사진으로)를 물어본다.
   * @returns {Promise<{bytes, result, rastered:boolean}>}
   */
  async function squeezePdf(bytes, target, progress, signal, { ask = true, label = '' } = {}) {
    const r = await Squeeze.compress(bytes, target, {
      signal,
      onProgress: (p) => busy.set(`${label}${stageText(p)}…`),
    });
    // 2단계로 모자라거나(raster) 줄일 사진이 아예 없을 때(cannot)도 3단계를 물어본다
    const short = r.status === 'raster' || (r.status === 'cannot' && r.size > target);
    if (!short || !ask) return { bytes: r.bytes, result: r, rastered: false };
    // 3단계: 자동으로 하지 않고 먼저 묻는다.
    busy.set(`${label}쪽을 사진으로 바꾸면 얼마나 줄어드는지 재는 중…`);
    const est = await rasterEstimate(r.bytes, signal);
    let low;
    try { low = await est.size(0); } finally { est.close(); }
    const ok = await confirmBox({
      title: r.status === 'cannot' ? '줄일 사진이 없어 목표에 못 미쳐요' : '사진만 줄여서는 목표에 못 미쳐요',
      body: `지금 ${fmtMB(r.size)}까지 줄였어요. 쪽을 사진으로 바꾸면 약 ${fmtMB(low)}까지 줄일 수 있어요. 대신 글자를 선택하거나 검색할 수 없어요.`,
      yes: '그래도 줄이기',
      no: '여기까지만',
    });
    if (!ok) return { bytes: r.bytes, result: r, rastered: false };
    const out = await rasterToTarget(r.bytes, target, progress, signal);
    const best = out.length < r.bytes.length ? out : r.bytes;
    return { bytes: best, result: { ...r, size: best.length, stage: 3, status: best.length <= target ? 'done' : 'raster' }, rastered: true };
  }

  // ═══════════════════════════════════════════════════════════
  // 꾸미기 옵션 + 미리보기 (설정하고 저장 창과 꾸미기 도구가 함께 쓴다)
  // ═══════════════════════════════════════════════════════════
  const defaultOpts = () => ({
    number: { on: false, position: 'bc', format: 'n', skipFirst: false },
    watermark: { on: false, text: '내부 자료', layout: 'diagonal', strength: 'normal', color: 'red', flatten: false },
    stamp: { on: false, ids: [], places: {}, target: 'last' },
    lock: { on: false, pw: '', pw2: '', print: true, copy: false, edit: false },
    size: { on: false, mb: '' },
  });
  const WM_RGB = { red: '#D62E2E', gray: '#595E6B', blue: '#3355FF' };
  const ITEM_META = {
    number: { title: '쪽번호', icon: 'hash', color: 'var(--c5)' },
    watermark: { title: '워터마크', icon: 'brush', color: 'var(--c2)' },
    stamp: { title: '서명 · 도장 이미지', icon: 'pen', color: 'var(--c3)' },
    lock: { title: '암호 걸기', icon: 'lock', color: 'var(--c4)' },
    size: { title: '용량 목표', icon: 'filedown', color: 'var(--c6)' },
  };
  const POS_TEXT = { bc: '아래 가운데', br: '아래 오른쪽', tr: '위 오른쪽' };
  const FMT_TEXT = { n: '3', dash: '- 3 -', total: '3 / N' };
  const LAYOUT_TEXT = { diagonal: '대각선', center: '가운데', tile: '바둑판' };
  const STRENGTH_TEXT = { light: '연하게', normal: '보통', dark: '진하게' };
  const COLOR_TEXT = { red: '빨강', gray: '회색', blue: '파랑' };
  const TARGET_TEXT = { last: '마지막 쪽', all: '모든 쪽', selected: '고른 쪽' };
  const defaultPlace = (k) => ({ x: Math.max(0.02, 0.7 - k * 0.06), y: Math.max(0.02, 0.8 - k * 0.06), w: 0.2 });

  function seg(name, legend, options, value) {
    return h('fieldset', { class: 'seg' }, h('legend', null, legend),
      ...options.map(([v, label, extra]) => h('label', extra || null,
        h('input', { type: 'radio', name, value: v, checked: v === value }), h('span', null, label))));
  }

  let editorSeq = 0;
  /**
   * items: ['number','watermark','stamp','lock','size'] 중 쓸 것
   * 돌려주는 것: {getOpts, setOpts, setSource, validate, onChange, refresh}
   */
  function createDecorEditor({ itemsEl, previewEl, items, order = items }) {
    const P = `de${++editorSeq}`;
    let opts = defaultOpts();
    let source = null; // {count, getPage(i), selected: [i…]}
    let pageIdx = 0;
    const listeners = new Set();
    const changed = () => { listeners.forEach((f) => f(opts)); };
    const bodies = {};
    const sums = {};
    const switches = {};

    // ── 항목 머리(아이콘 · 이름 · 요약 · 스위치)와 본문 ──
    function accItem(key, body) {
      const m = ITEM_META[key];
      const sw = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input', 'data-toggle': key, 'aria-label': `${m.title} 켜기` });
      const sum = h('small', { class: 'acc-sum' });
      const sec = h('section', { class: 'acc', 'data-item': key, style: `--tc: ${m.color}` },
        h('label', { class: 'acc-head' },
          h('span', { class: 'acc-icon', 'aria-hidden': 'true' }, icon(m.icon)),
          h('span', { class: 'acc-title' }, h('strong', null, m.title), sum),
          sw, h('span', { class: 'switch', 'aria-hidden': 'true' })),
        h('div', { class: 'acc-body', hidden: true }, ...body));
      bodies[key] = sec.querySelector('.acc-body');
      sums[key] = sum;
      switches[key] = sw;
      sw.addEventListener('change', () => {
        opts[key].on = sw.checked;
        syncItem(key);
        if (key === 'size' && sw.checked) setTimeout(() => sec.querySelector('input[data-f="mb"]').focus(), 0);
        if (key === 'stamp' && sw.checked) jumpToStampPage();
        if (key === 'watermark' && sw.checked) setTimeout(() => sec.querySelector('input[data-f="text"]').select(), 0);
        updatePreview();
        changed();
      });
      return sec;
    }

    // 1) 쪽번호
    const numberBody = [
      seg(`${P}-npos`, '위치', [['bc', '아래 가운데'], ['br', '아래 오른쪽'], ['tr', '위 오른쪽']], 'bc'),
      seg(`${P}-nfmt`, '모양', [['n', '3'], ['dash', '- 3 -'], ['total', '3 / N']], 'n'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-f': 'skipFirst' }), h('span', null, '표지(첫 쪽) 건너뛰기')),
    ];
    // 2) 워터마크
    const wmText = h('input', { type: 'text', 'data-f': 'text', maxlength: '40', autocomplete: 'off', 'aria-label': '워터마크 글자' });
    const watermarkBody = [
      h('label', { class: 'field' }, h('span', null, '글자'), wmText),
      seg(`${P}-wlay`, '배치', [['diagonal', '대각선'], ['center', '가운데'], ['tile', '바둑판']], 'diagonal'),
      seg(`${P}-wstr`, '진하기', [['light', '연하게'], ['normal', '보통'], ['dark', '진하게']], 'normal'),
      seg(`${P}-wcol`, '색', [['red', '빨강', { class: 'sw-red' }], ['gray', '회색', { class: 'sw-gray' }], ['blue', '파랑', { class: 'sw-blue' }]], 'red'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-f': 'flatten' }),
        h('span', null, '지울 수 없게 쪽을 이미지로 굳히기 ', h('small', null, '(글자 선택 안 됨 · 용량 커짐)'))),
    ];
    // 3) 서명 · 도장
    const chipBox = h('ul', { class: 'stamp-chips', 'aria-label': '보관한 서명 · 도장' });
    const upInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,.png,.jpg,.jpeg', hidden: true });
    const clearWhite = h('input', { type: 'checkbox', 'data-f': 'clearWhite', checked: true });
    const targetSeg = seg(`${P}-starget`, '넣을 쪽', [['last', '마지막 쪽'], ['all', '모든 쪽'], ['selected', '고른 쪽']], 'last');
    const selNote = h('small', { class: 'sel-note' });
    const stampBody = [
      chipBox,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn sm', 'data-act': 'draw' }, icon('pen', 'ic sm'), '손으로 그리기'),
        h('button', { type: 'button', class: 'btn sm', 'data-act': 'upload' }, icon('upload', 'ic sm'), '이미지 올리기'),
        upInput),
      h('label', { class: 'check' }, clearWhite, h('span', null, '흰 배경 지우기 ', h('small', null, '(스캔한 도장용, 고른 이미지에 적용)'))),
      targetSeg, selNote,
      h('p', { class: 'hint-box' }, '서명 이미지를 넣는 기능이에요. 인증서로 하는 법적 전자서명과는 달라요.'),
      h('p', { class: 'sub' }, '미리보기에서 끌어서 옮기고, 오른쪽 아래 모서리를 끌어 크기를 바꿔요. 만든 서명과 도장은 이 브라우저에만 보관돼요.'),
    ];
    // 4) 암호
    const pw1 = h('input', { type: 'password', 'data-f': 'pw', autocomplete: 'new-password', 'aria-label': '열기 암호' });
    const pw2 = h('input', { type: 'password', 'data-f': 'pw2', autocomplete: 'new-password', 'aria-label': '열기 암호 한 번 더' });
    const pwMsg = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const lockBody = [
      h('label', { class: 'field' }, h('span', null, '열기 암호'), pw1),
      h('label', { class: 'field' }, h('span', null, '한 번 더'), pw2),
      pwMsg,
      h('fieldset', { class: 'checks' }, h('legend', null, '허용할 것'),
        h('label', null, h('input', { type: 'checkbox', 'data-f': 'print', checked: true }), h('span', null, '인쇄')),
        h('label', null, h('input', { type: 'checkbox', 'data-f': 'copy' }), h('span', null, '복사')),
        h('label', null, h('input', { type: 'checkbox', 'data-f': 'edit' }), h('span', null, '편집'))),
      h('p', { class: 'hint-box warn' }, '비밀번호를 잊으면 이 파일은 누구도 열 수 없어요. 따로 적어 두세요.'),
    ];
    // 5) 용량 목표
    const mbInput = h('input', { type: 'text', 'data-f': 'mb', inputmode: 'decimal', autocomplete: 'off', placeholder: '10', 'aria-label': '목표 용량(MB)' });
    const sizeBody = [
      h('label', { class: 'inline-num' }, mbInput, h('span', null, 'MB 이하로 맞추기')),
      h('p', { class: 'sub' }, '글자는 그대로 두고 사진만 줄여요. 그래도 크면 쪽을 사진으로 바꿀지 물어봐요.'),
    ];
    const build = { number: numberBody, watermark: watermarkBody, stamp: stampBody, lock: lockBody, size: sizeBody };
    itemsEl.replaceChildren(...items.map((k) => accItem(k, build[k])));

    // 입력 → opts
    itemsEl.addEventListener('input', (e) => readInput(e.target));
    itemsEl.addEventListener('change', (e) => readInput(e.target));
    function readInput(t) {
      const sec = t.closest('.acc');
      if (!sec || t.classList.contains('switch-input')) return;
      const key = sec.dataset.item;
      const o = opts[key];
      if (t.type === 'radio') {
        const name = t.name.replace(`${P}-`, '');
        const field = { npos: 'position', nfmt: 'format', wlay: 'layout', wstr: 'strength', wcol: 'color', starget: 'target' }[name];
        if (field && t.checked) o[field] = t.value;
      } else if (t.dataset.f === 'clearWhite') {
        applyClearWhite(t.checked);
      } else if (t.dataset.f) {
        o[t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value;
      }
      if (key === 'stamp' && t.type === 'radio') jumpToStampPage();
      syncItem(key);
      updatePreview();
      changed();
    }

    async function applyClearWhite(on) {
      const list = opts.stamp.ids.map((id) => Stamps.byId(id)).filter((it) => it && it.kind === 'upload');
      for (const it of list) { it.clearWhite = on; await Stamps.update(it); }
      renderChips();
      updatePreview();
    }

    function summary(key) {
      const o = opts[key];
      if (!o.on) return '';
      if (key === 'number') return `${POS_TEXT[o.position]} · ${FMT_TEXT[o.format]}${o.skipFirst ? ' · 표지 제외' : ''}`;
      if (key === 'watermark') return `"${o.text || ''}" · ${LAYOUT_TEXT[o.layout]} · ${STRENGTH_TEXT[o.strength]} · ${COLOR_TEXT[o.color]}${o.flatten ? ' · 굳히기' : ''}`;
      if (key === 'stamp') return `${o.ids.length}개 · ${TARGET_TEXT[o.target]}`;
      if (key === 'lock') return `AES-256 · 인쇄 ${o.print ? '허용' : '막음'}`;
      if (key === 'size') return o.mb ? `${o.mb}MB 이하` : '용량을 적어 주세요';
      return '';
    }
    function syncItem(key) {
      const o = opts[key];
      switches[key].checked = o.on;
      bodies[key].hidden = !o.on;
      sums[key].textContent = summary(key);
      bodies[key].closest('.acc').classList.toggle('on', o.on);
      if (key === 'lock') {
        const bad = o.on && o.pw && o.pw2 && o.pw !== o.pw2;
        pwMsg.hidden = !bad;
        pwMsg.textContent = bad ? '두 암호가 달라요. 같게 적어 주세요.' : '';
      }
      if (key === 'stamp') {
        const hasSel = !!(source && source.selected && source.selected.length);
        const selRadio = targetSeg.querySelector('input[value="selected"]');
        selRadio.disabled = !hasSel;
        selRadio.closest('label').classList.toggle('disabled', !hasSel);
        if (!hasSel && o.target === 'selected') { o.target = 'last'; targetSeg.querySelector('input[value="last"]').checked = true; }
        selNote.textContent = hasSel ? `편집에서 고른 ${source.selected.length}쪽에 넣어요.` : '"고른 쪽"은 편집 화면에서 쪽을 골랐을 때 쓸 수 있어요.';
        const anyUpload = o.ids.some((id) => (Stamps.byId(id) || {}).kind === 'upload');
        clearWhite.disabled = !anyUpload;
        if (anyUpload) clearWhite.checked = o.ids.map(Stamps.byId).filter((it) => it && it.kind === 'upload').every((it) => it.clearWhite);
      }
    }

    // ── 서명 · 도장 칩 ──
    async function renderChips() {
      const list = await Stamps.list();
      opts.stamp.ids = opts.stamp.ids.filter((id) => list.some((x) => x.id === id));
      const chips = await Promise.all(list.map(async (it) => {
        const on = opts.stamp.ids.includes(it.id);
        return h('li', { class: `stamp-chip${on ? ' on' : ''}` },
          h('button', { type: 'button', class: 'stamp-pick', 'data-id': it.id, 'aria-pressed': on ? 'true' : 'false', title: on ? '넣지 않기' : '이 이미지 넣기' },
            h('img', { src: await Stamps.urlOf(it), alt: '' }), h('span', null, it.name)),
          h('button', { type: 'button', class: 'stamp-x', 'data-del': it.id, 'aria-label': `${it.name} 지우기`, title: '이 브라우저에서 지우기' }, icon('x', 'ic sm')));
      }));
      chipBox.replaceChildren(...chips);
      if (!list.length) chipBox.append(h('li', { class: 'stamp-empty' }, '아직 보관한 서명 · 도장이 없어요.'));
      syncItem('stamp');
      sums.stamp.textContent = summary('stamp');
    }
    Stamps.onChange(() => { if (itemsEl.isConnected) renderChips(); });
    chipBox.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const it = Stamps.byId(del.dataset.del);
        opts.stamp.ids = opts.stamp.ids.filter((x) => x !== del.dataset.del);
        await Stamps.remove(del.dataset.del);
        toast(`"${it ? it.name : '이미지'}"을(를) 지웠어요.`, '', 'info');
        updatePreview();
        changed();
        return;
      }
      const pick = e.target.closest('[data-id]');
      if (!pick) return;
      const id = pick.dataset.id;
      opts.stamp.ids = opts.stamp.ids.includes(id) ? opts.stamp.ids.filter((x) => x !== id) : [...opts.stamp.ids, id];
      await renderChips();
      updatePreview();
      changed();
    });
    async function addStamp(item) {
      const n = (await Stamps.list()).filter((x) => x.kind === item.kind).length + 1;
      const it = await Stamps.add({ ...item, name: item.kind === 'drawn' ? `서명 ${n}` : `도장 ${n}` });
      opts.stamp.ids.push(it.id);
      if (!opts.stamp.on) { opts.stamp.on = true; syncItem('stamp'); }
      await renderChips();
      jumpToStampPage();
      updatePreview();
      changed();
    }
    itemsEl.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || !itemsEl.contains(b)) return;
      if (b.dataset.act === 'draw') {
        const r = await SignPad.open();
        if (r) await addStamp({ kind: 'drawn', bytes: r.bytes, w: r.w, h: r.h, clearWhite: false });
      } else if (b.dataset.act === 'upload') upInput.click();
    });
    upInput.addEventListener('change', async () => {
      const f = upInput.files[0];
      upInput.value = '';
      if (!f) return;
      if (!/^image\/(png|jpeg)$/.test(f.type) && !/\.(png|jpe?g)$/i.test(f.name)) return toast('PNG나 JPG만 올릴 수 있어요.', '도장을 스캔했다면 PNG나 JPG로 저장해 주세요.');
      try {
        const r = await imageFileToPng(f);
        await addStamp({ kind: 'upload', bytes: r.bytes, w: r.w, h: r.h, clearWhite: clearWhite.disabled ? true : clearWhite.checked });
      } catch (err) { showError(err, f.name); }
    });

    // ── 미리보기 ──
    const pvCanvas = h('canvas', { class: 'pv-canvas' });
    const pvLayer = h('div', { class: 'pv-layer' });
    const pvStage = h('div', { class: 'pv-stage' }, pvCanvas, pvLayer);
    const pvPage = h('span', { class: 'pv-page' });
    const prev = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '이전 쪽' }, '◀');
    const next = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '다음 쪽' }, '▶');
    const ORDER = [['number', '쪽번호'], ['watermark', '워터마크'], ['stamp', '도장'], ['size', '용량 맞추기'], ['lock', '암호(항상 마지막)']];
    const orderList = h('ol', { class: 'pv-order', 'aria-label': '적용 순서' },
      ...ORDER.filter(([k]) => order.includes(k)).map(([k, t]) => h('li', { 'data-k': k }, t)));
    previewEl.replaceChildren(
      h('div', { class: 'pv' }, h('p', { class: 'pv-cap' }, '미리보기'), pvStage, h('div', { class: 'pv-nav' }, prev, pvPage, next),
        h('div', { class: 'pv-order-wrap' }, h('span', null, '적용 순서'), orderList)));
    prev.addEventListener('click', () => go(pageIdx - 1));
    next.addEventListener('click', () => go(pageIdx + 1));
    let frame = null; // {visW, visH, cssW, cssH}
    let drawToken = 0;

    function go(i) {
      if (!source) return;
      pageIdx = Math.max(0, Math.min(source.count - 1, i));
      drawPage();
    }
    function stampPageList() {
      if (!source) return [];
      const t = opts.stamp.target === 'selected' ? (source.selected || []) : opts.stamp.target;
      return Core.stampPages(t, source.count);
    }
    function jumpToStampPage() {
      if (!source || !opts.stamp.on) return;
      const list = stampPageList();
      if (list.length && !list.includes(pageIdx)) go(list[0]);
    }

    async function drawPage() {
      if (!source || !source.count) return;
      const my = ++drawToken;
      pvPage.textContent = `${pageIdx + 1} / ${source.count}쪽`;
      prev.disabled = pageIdx <= 0;
      next.disabled = pageIdx >= source.count - 1;
      try {
        const { page, rot } = await source.getPage(pageIdx);
        if (my !== drawToken) return;
        const rotation = Core.normAngle(page.rotate + (rot || 0));
        const vp1 = page.getViewport({ scale: 1, rotation });
        const boxW = Math.max(200, (previewEl.clientWidth || 340) - 8);
        const maxH = window.innerWidth <= 760 ? Math.max(220, window.innerHeight * 0.36) : Math.min(460, Math.max(260, window.innerHeight * 0.55));
        const cssW = Math.min(boxW, maxH * (vp1.width / vp1.height));
        const cssH = cssW * (vp1.height / vp1.width);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const vp = page.getViewport({ scale: (cssW / vp1.width) * dpr, rotation });
        const c = makeCanvas(vp.width, vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        if (my !== drawToken) return;
        pvCanvas.width = c.width;
        pvCanvas.height = c.height;
        pvCanvas.getContext('2d').drawImage(c, 0, 0);
        pvStage.style.width = `${cssW}px`;
        pvStage.style.height = `${cssH}px`;
        frame = { visW: vp1.width, visH: vp1.height, cssW, cssH };
        updatePreview();
      } catch (e) {
        console.warn(e);
      }
    }

    const measureCtx = document.createElement('canvas').getContext('2d');

    function updatePreview() {
      orderList.querySelectorAll('li').forEach((li) => li.classList.toggle('on', !!(opts[li.dataset.k] && opts[li.dataset.k].on)));
      if (!frame || !source) return;
      const { visW, visH, cssW, cssH } = frame;
      const k = cssW / visW;
      const parts = [];
      // 쪽번호
      const o = opts.number;
      if (o.on && !(o.skipFirst && pageIdx === 0)) {
        const total = source.count - (o.skipFirst ? 1 : 0);
        const n = pageIdx + 1 - (o.skipFirst ? 1 : 0);
        const text = Core.numberText(n, total, o.format);
        const { size, margin } = Core.numberMetrics(visW, visH);
        measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
        const tw = measureCtx.measureText(text).width;
        const { vx, vy } = Core.numberSpot(visW, visH, tw, size, margin, o.position);
        parts.push(h('span', { class: 'pv-num', style: `left:${vx * k}px;top:${(visH - vy - size * 0.78) * k}px;font-size:${size * k}px` }, text));
      }
      // 워터마크
      const w = opts.watermark;
      if (w.on && w.text.trim()) {
        const text = w.text.trim();
        measureCtx.font = '700 100px "Pretendard Variable", Pretendard, sans-serif';
        const w1 = measureCtx.measureText(text).width / 100;
        const lay = Core.watermarkLayout(visW, visH, w1, w.layout);
        const alpha = Core.WM_OPACITY[w.strength] || 0.2;
        for (const s of lay.spots) {
          parts.push(h('span', {
            class: 'pv-wm',
            style: `left:${s.cx * k}px;top:${(visH - s.cy) * k}px;font-size:${lay.size * k}px;color:${WM_RGB[w.color]};opacity:${alpha};transform:translate(-50%,-50%) rotate(${-lay.angle}deg)`,
          }, text));
        }
      }
      pvLayer.replaceChildren(...parts);
      // 도장
      if (opts.stamp.on && stampPageList().includes(pageIdx)) {
        opts.stamp.ids.forEach((id, idx) => {
          const it = Stamps.byId(id);
          if (!it) return;
          const place = opts.stamp.places[id] || (opts.stamp.places[id] = defaultPlace(idx));
          const aspect = it.h / it.w;
          const el = h('div', { class: 'pv-stamp', 'data-id': id, tabindex: '0', title: '끌어서 옮기기 · 모서리로 크기 바꾸기', 'aria-label': `${it.name} 위치` },
            h('img', { alt: '', draggable: 'false' }), h('span', { class: 'pv-handle', 'aria-hidden': 'true' }));
          Stamps.urlOf(it).then((u) => { el.querySelector('img').src = u; });
          const hFrac = (place.w * visW * aspect) / visH;
          place.y = Math.min(place.y, Math.max(0, 1 - hFrac));
          Object.assign(el.style, { left: `${place.x * cssW}px`, top: `${place.y * cssH}px`, width: `${place.w * cssW}px`, height: `${place.w * cssW * aspect}px` });
          pvLayer.append(el);
        });
      }
    }

    // 도장 끌기 · 크기 조절 (쪽 크기 대비 비율로 저장)
    let drag = null;
    pvLayer.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('.pv-stamp');
      if (!el || !frame) return;
      e.preventDefault();
      const id = el.dataset.id;
      const it = Stamps.byId(id);
      const place = opts.stamp.places[id];
      el.setPointerCapture(e.pointerId);
      drag = { el, id, place, aspect: it.h / it.w, resize: !!e.target.closest('.pv-handle'), x0: e.clientX, y0: e.clientY, start: { ...place } };
      el.classList.add('moving');
    });
    pvLayer.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const { cssW, cssH, visW, visH } = frame;
      const dx = (e.clientX - drag.x0) / cssW;
      const dy = (e.clientY - drag.y0) / cssH;
      const p = drag.place;
      if (drag.resize) {
        const maxW = Math.min(1 - p.x, ((1 - p.y) * visH) / (drag.aspect * visW));
        p.w = Math.max(0.03, Math.min(maxW, drag.start.w + dx));
      } else {
        const hFrac = (p.w * visW * drag.aspect) / visH;
        p.x = Math.max(0, Math.min(1 - p.w, drag.start.x + dx));
        p.y = Math.max(0, Math.min(1 - hFrac, drag.start.y + dy));
      }
      Object.assign(drag.el.style, { left: `${p.x * cssW}px`, top: `${p.y * cssH}px`, width: `${p.w * cssW}px`, height: `${p.w * cssW * drag.aspect}px` });
    });
    const endDrag = () => {
      if (!drag) return;
      drag.el.classList.remove('moving');
      drag = null;
      changed();
    };
    pvLayer.addEventListener('pointerup', endDrag);
    pvLayer.addEventListener('pointercancel', endDrag);
    // 키보드로도 옮기기(화살표 1%, Shift 5%)
    pvLayer.addEventListener('keydown', (e) => {
      const el = e.target.closest('.pv-stamp');
      if (!el || !frame) return;
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault();
      const p = opts.stamp.places[el.dataset.id];
      const step = e.shiftKey ? 0.05 : 0.01;
      p.x = Math.max(0, Math.min(1 - p.w, p.x + d[0] * step));
      p.y = Math.max(0, Math.min(0.99, p.y + d[1] * step));
      updatePreview();
      pvLayer.querySelector(`.pv-stamp[data-id="${el.dataset.id}"]`)?.focus();
      changed();
    });

    function setOpts(o) {
      const base = defaultOpts();
      opts = {};
      for (const key of Object.keys(base)) opts[key] = { ...base[key], ...((o && o[key]) || {}) };
      opts.stamp.places = { ...((o && o.stamp && o.stamp.places) || {}) };
      opts.stamp.ids = [...((o && o.stamp && o.stamp.ids) || [])];
      // 화면 값 채우기
      for (const key of items) {
        const sec = itemsEl.querySelector(`.acc[data-item="${key}"]`);
        sec.querySelectorAll('input').forEach((inp) => {
          if (inp.classList.contains('switch-input') || inp.type === 'file') return;
          if (inp.type === 'radio') {
            const name = inp.name.replace(`${P}-`, '');
            const field = { npos: 'position', nfmt: 'format', wlay: 'layout', wstr: 'strength', wcol: 'color', starget: 'target' }[name];
            inp.checked = opts[key][field] === inp.value;
          } else if (inp.dataset.f && inp.dataset.f !== 'clearWhite') {
            if (inp.type === 'checkbox') inp.checked = !!opts[key][inp.dataset.f];
            else inp.value = opts[key][inp.dataset.f] ?? '';
          }
        });
        syncItem(key);
      }
      renderChips();
      updatePreview();
    }

    function validate() {
      if (items.includes('lock') && opts.lock.on) {
        if (!opts.lock.pw) return '열기 암호를 적어 주세요.';
        if (opts.lock.pw !== opts.lock.pw2) return '두 암호가 달라요.';
      }
      if (items.includes('size') && opts.size.on) {
        const v = Number(String(opts.size.mb).replace(',', '.'));
        if (!(v > 0)) return '목표 용량을 MB 숫자로 적어 주세요.';
      }
      if (opts.watermark.on && !opts.watermark.text.trim()) return '워터마크 글자를 적어 주세요.';
      return null;
    }

    return {
      getOpts: () => JSON.parse(JSON.stringify(opts)),
      setOpts,
      validate,
      onChange: (f) => listeners.add(f),
      async setSource(src, startAt = 0) {
        source = src;
        pageIdx = Math.min(startAt, Math.max(0, (src ? src.count : 1) - 1));
        frame = null;
        pvLayer.replaceChildren();
        for (const key of items) syncItem(key);
        if (opts.stamp.on) jumpToStampPage();
        await drawPage();
      },
      redraw: () => drawPage(),
      get pageIndex() { return pageIdx; },
    };
  }

  /**
   * 꾸미기 옵션을 적용해 PDF 바이트를 만든다.
   * 순서: 쪽번호 → 워터마크(→ 굳히기) → 도장 → 용량 맞추기 → 암호(항상 마지막)
   * ctx.selected: 편집에서 고른 쪽의 결과 문서 속 번호(0부터)
   */
  async function applyOptions(doc, o, progress, signal, ctx = {}) {
    const label = ctx.label || '';
    if (o.number && o.number.on) {
      await Core.addPageNumbers(doc, { position: o.number.position, format: o.number.format, start: 1, skipFirst: o.number.skipFirst },
        (d, n) => progress(`${label}쪽번호 넣는 중 (${d}/${n})`, d, n));
    }
    if (o.watermark && o.watermark.on) {
      await progress(`${label}워터마크 글꼴 준비 중…`, 0, 1);
      const font = await watermarkFont(doc);
      await Core.addWatermark(doc, o.watermark, font, (d, n) => progress(`${label}워터마크 넣는 중 (${d}/${n})`, d, n));
      if (o.watermark.flatten) {
        const flat = await rasterizePdf(await doc.save(), { dpi: 150, q: 0.85 }, (t, d, n) => progress(`${label}${t}`, d, n), signal);
        doc = await PDFDocument.load(flat, { updateMetadata: false });
      }
    }
    if (o.stamp && o.stamp.on && o.stamp.ids.length) {
      await Stamps.list();
      const stamps = [];
      o.stamp.ids.forEach((id, idx) => {
        const it = Stamps.byId(id);
        if (it) stamps.push({ it, place: (o.stamp.places && o.stamp.places[id]) || defaultPlace(idx) });
      });
      const list = [];
      for (const s of stamps) list.push({ bytes: await Stamps.pngOf(s.it), place: s.place });
      const target = o.stamp.target === 'selected' ? (ctx.selected || []) : o.stamp.target;
      await progress(`${label}서명 · 도장 넣는 중…`, 1, 1);
      await Core.addStamps(doc, list, target);
    }
    await progress(`${label}파일로 만드는 중…`, 1, 1);
    let bytes = await doc.save({ useObjectStreams: true });
    let sizeNote = null;
    if (o.size && o.size.on) {
      const target = Number(String(o.size.mb).replace(',', '.')) * MB;
      if (bytes.length > target) {
        const r = await squeezePdf(bytes, target, progress, signal, { label });
        bytes = r.bytes;
        sizeNote = r.result;
      }
    }
    if (o.lock && o.lock.on) {
      await progress(`${label}AES-256으로 암호 거는 중…`, 1, 1);
      const d = await PDFDocument.load(bytes, { updateMetadata: false });
      // 권한을 막았다면 권한 암호는 아무도 모르는 값으로 둔다(열기 암호로 제한을 풀 수 없게).
      const restricted = !o.lock.print || !o.lock.copy || !o.lock.edit;
      const owner = restricted ? Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('') : o.lock.pw;
      Core.encrypt(d, { userPassword: o.lock.pw, ownerPassword: owner, allowPrint: o.lock.print, allowCopy: o.lock.copy, allowEdit: o.lock.edit });
      bytes = await d.save({ useObjectStreams: false });
    }
    return { bytes, sizeNote };
  }

  const hasAnyOption = (o) => ['number', 'watermark', 'stamp', 'lock', 'size'].some((k) => o[k] && o[k].on);

  // ═══════════════════════════════════════════════════════════
  // 설정하고 저장… 창
  // ═══════════════════════════════════════════════════════════
  const SaveDialog = (() => {
    const dlg = $('save-dialog');
    const nameInput = $('sd-name');
    const nameNote = $('sd-name-note');
    const saveBtn = $('sd-save');
    const remember = $('sd-remember');
    const KEY = 'pdfws.saveOpts';
    const editor = createDecorEditor({ itemsEl: $('sd-items'), previewEl: $('sd-preview'), items: ['number', 'watermark', 'stamp', 'lock', 'size'] });
    let ctx = null;
    let errMsg = null;

    const BAD = /[\\/:*?"<>|\u0000-\u001f]/g;
    nameInput.addEventListener('input', () => {
      if (new RegExp(BAD.source).test(nameInput.value)) {
        const pos = nameInput.selectionStart;
        nameInput.value = nameInput.value.replace(BAD, '_');
        nameInput.setSelectionRange(pos, pos);
        nameNote.textContent = '파일 이름에 쓸 수 없는 글자(\\ / : * ? " < > |)는 _ 로 바꿨어요.';
        nameNote.hidden = false;
      }
      validate();
    });
    function validate() {
      errMsg = editor.validate() || (!nameInput.value.trim() ? '파일 이름을 적어 주세요.' : null);
      saveBtn.disabled = !!errMsg;
      saveBtn.title = errMsg || '';
    }
    editor.onChange(validate);

    function loadRemembered() {
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }
    function storeRemembered(o) {
      try {
        if (!o) return localStorage.removeItem(KEY);
        const safe = JSON.parse(JSON.stringify(o));
        // 비밀번호는 절대 저장하지 않는다.
        safe.lock = { ...safe.lock, pw: '', pw2: '' };
        localStorage.setItem(KEY, JSON.stringify(safe));
      } catch { /* 저장소를 못 써도 저장은 된다 */ }
    }

    /**
     * context: {name, meta, source, selected, run(opts, name), sizeAllowed?, preset?}
     */
    async function open(context) {
      if (isBusy()) return;
      ctx = context;
      const saved = loadRemembered();
      remember.checked = !!saved;
      editor.setOpts(context.preset || saved || defaultOpts());
      nameInput.value = context.name;
      nameNote.hidden = true;
      $('sd-meta').textContent = context.meta || '';
      $('sd-title').textContent = context.title || '설정하고 저장';
      dlg.showModal();
      validate();
      nameInput.focus();
      nameInput.select();
      await editor.setSource(context.source, context.startPage || 0);
    }
    function close() {
      if (dlg.open) dlg.close();
      if (ctx && ctx.onClose) ctx.onClose();
    }
    $('sd-cancel').addEventListener('click', close);
    $('sd-x').addEventListener('click', close);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    $('sd-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      validate();
      if (errMsg) return toast(errMsg, '');
      const o = editor.getOpts();
      storeRemembered(remember.checked ? o : null);
      const name = nameInput.value.trim().replace(/\.pdf$/i, '');
      const run = ctx.run;
      close();
      await run(o, safeName(name));
    });
    return { open, close, get isOpen() { return dlg.open; }, editor };
  })();

  /** 결과 파일 이름 앞부분 */
  const saveStem = (list, fallback) => {
    const ids = [...new Set(list.map((p) => p.srcId))];
    return ids.length === 1 ? baseName(Edit.srcById(ids[0]).name) : fallback;
  };

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
    const est = $('p2i-est');
    const copyBtn = $('p2i-copy');
    const FMT = {
      png: { type: 'image/png', ext: 'png', label: 'PNG' },
      jpg: { type: 'image/jpeg', ext: 'jpg', label: 'JPG' },
      webp: { type: 'image/webp', ext: 'webp', label: 'WEBP' },
    };
    let pdf = null;
    let name = '';
    let picked = new Set();
    let token = 0;
    let estToken = 0;
    let estTimer = 0;

    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) paint(en.target);
    }, { rootMargin: '400px 0px' });

    const radioVal = (n) => document.querySelector(`input[name="${n}"]:checked`).value;
    const settings = () => ({ fmt: radioVal('p2i-fmt'), dpi: Number(radioVal('p2i-dpi')), q: Number(radioVal('p2i-q')) });
    const isPhone = () => matchMedia('(pointer: coarse)').matches && window.innerWidth <= 820;

    async function load(files) {
      const f = files[0];
      if (files.length > 1) toast('PDF는 한 번에 하나씩 바꿀 수 있어요.', `첫 번째 파일 "${f.name}"만 열었어요.`, 'info');
      if (!isPdfFile(f)) return toast(`"${f.name}"은(는) PDF가 아니에요.`, 'PDF 파일을 넣어 주세요.');
      reset(true);
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
      const s = settings();
      $('p2i-bar').hidden = !pdf;
      $('p2i-count').textContent = `${n}쪽 선택 · ${n > 1 ? 'zip으로 묶어 저장' : `${FMT[s.fmt].label} 한 장`}`;
      $('p2i-q').disabled = s.fmt === 'png';
      $('p2i-webp').hidden = !(pdf && s.fmt === 'webp');
      if (!isBusy()) {
        $('p2i-save').disabled = n === 0;
        $('p2i-save-opts').disabled = n === 0;
        copyBtn.disabled = n !== 1;
      }
      copyBtn.title = n === 1 ? '이 쪽을 PNG로 복사 (PPT · 한글에 붙여넣기)' : '한 쪽만 골랐을 때 복사할 수 있어요';
      scheduleEstimate();
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

    // 형식 · 선명도 · 품질을 바꾸면 다시 계산
    $('p2i-bar').addEventListener('change', (e) => {
      if (e.target.name === 'p2i-dpi' && e.target.value === '300' && isPhone()) {
        document.querySelector('input[name="p2i-dpi"][value="150"]').checked = true;
        toast('휴대폰에서는 보통(150)으로 바꿨어요.', '인쇄용(300)은 메모리가 많이 들어 휴대폰에서 멈출 수 있어요. 컴퓨터에서 해 주세요.', 'info');
      }
      update();
    });

    /** 쪽 하나를 그림 파일로 */
    async function renderImage(n, { fmt, dpi, q }) {
      const page = await pdf.getPage(n);
      const { canvas, reduced } = await renderPageCanvas(page, dpi);
      page.cleanup();
      const bytes = await canvasToBytes(canvas, FMT[fmt].type, fmt === 'png' ? undefined : q);
      canvas.width = canvas.height = 0;
      return { bytes, reduced };
    }

    // 예상 용량: 첫 쪽을 실제로 바꿔 본 크기 × 쪽수 (0.4초 모아서)
    function scheduleEstimate() {
      clearTimeout(estTimer);
      if (!pdf || !picked.size) { est.textContent = ''; return; }
      est.textContent = '예상 용량 계산 중…';
      estTimer = setTimeout(async () => {
        const my = ++estToken;
        const first = Math.min(...picked);
        try {
          const r = await queueRender(() => renderImage(first, settings()));
          if (my !== estToken) return;
          est.textContent = `약 ${fmtMB(r.bytes.length * picked.size)}`;
          est.title = `${first}쪽을 실제로 바꿔 본 크기(${fmtMB(r.bytes.length)}) × ${picked.size}쪽`;
        } catch {
          if (my === estToken) est.textContent = '';
        }
      }, 400);
    }

    const pageName = (stem, n, total, ext) => `${stem}_p${String(n).padStart(String(total).length, '0')}.${ext}`;

    async function save(s = settings(), { stem, zipOn = true } = {}) {
      if (!pdf || !picked.size) return toast('저장할 쪽을 골라 주세요.', '카드를 누르면 고르거나 뺄 수 있어요.');
      const list = [...picked].sort((a, b) => a - b);
      const base = safeName(stem || baseName(name));
      const ext = FMT[s.fmt].ext;
      let reduced = 0;
      try {
        const out = await withBusy('그림으로 바꾸는 중…', async (progress, signal) => {
          const files = [];
          const zip = list.length > 1 && zipOn ? new JSZip() : null;
          for (let i = 0; i < list.length; i++) {
            if (signal.aborted) throw abortError();
            await progress(`${list[i]}쪽 바꾸는 중 (${i + 1}/${list.length})`, i, list.length);
            const r = await renderImage(list[i], s);
            if (r.reduced) reduced++;
            const fname = pageName(base, list[i], pdf.numPages, ext);
            if (zip) zip.file(fname, r.bytes); else files.push({ name: fname, bytes: r.bytes });
          }
          if (!zip) return files;
          const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) =>
            busy.set(`zip으로 묶는 중 (${Math.round(m.percent)}%)`, m.percent, 100));
          return [{ name: `${base}_${ext}.zip`, blob }];
        }, { cancellable: true });
        for (let i = 0; i < out.length; i++) {
          const f = out[i];
          download(f.blob || f.bytes, f.name, f.blob ? 'application/zip' : FMT[s.fmt].type);
          if (out.length > 1) await new Promise((r) => setTimeout(r, 350));
        }
        if (reduced) toast(`${reduced}쪽은 너무 커서 해상도를 조금 낮췄어요.`, '브라우저가 한 번에 그릴 수 있는 크기(한 변 8192px)에 한계가 있어요.', 'info');
      } catch (e) { showError(e, name); }
    }
    $('p2i-save').addEventListener('click', () => save());

    // 한 쪽을 PNG로 복사 (ClipboardItem은 PNG만 된다)
    copyBtn.addEventListener('click', async () => {
      if (picked.size !== 1) return;
      const n = [...picked][0];
      if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
        return toast('이 브라우저는 그림 복사를 지원하지 않아요.', '[바로 저장]으로 저장해서 쓰세요.');
      }
      try {
        // 사용자 동작 안에서 바로 쓰기 시작해야 하는 브라우저(사파리)를 위해 Promise를 넘긴다.
        const s = settings();
        const blobP = withBusy(`${n}쪽 복사 준비 중…`, async () => new Blob([(await renderImage(n, { ...s, fmt: 'png' })).bytes], { type: 'image/png' }));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })]);
        toast('복사했어요. PPT나 한글에서 Ctrl+V 하세요.', s.fmt === 'png' ? '' : '복사는 형식과 상관없이 PNG로 돼요.', 'ok');
      } catch (e) {
        console.warn(e);
        toast('복사하지 못했어요.', `${/denied|permission|NotAllowed/i.test(String(e && (e.name + e.message))) ? '브라우저가 클립보드 쓰기를 막았어요.' : `원인: ${String((e && e.message) || e).slice(0, 80)}`} 저장해서 쓰세요.`);
      }
    });

    // 설정하고 저장… (작은 창)
    const dlg = $('p2i-dialog');
    function openDialog() {
      if (!pdf || !picked.size) return toast('저장할 쪽을 골라 주세요.', '');
      const s = settings();
      dlg.querySelector(`input[name="p2d-fmt"][value="${s.fmt}"]`).checked = true;
      dlg.querySelector(`input[name="p2d-dpi"][value="${s.dpi}"]`).checked = true;
      dlg.querySelector(`input[name="p2d-q"][value="${s.q}"]`).checked = true;
      $('p2d-stem').value = baseName(name);
      $('p2d-zip').closest('label').hidden = picked.size < 2;
      syncDialog();
      dlg.showModal();
    }
    function syncDialog() {
      const fmt = dlg.querySelector('input[name="p2d-fmt"]:checked').value;
      $('p2d-q').disabled = fmt === 'png';
      $('p2d-note').textContent = fmt === 'webp' ? 'WEBP는 한글(HWP)이나 예전 오피스에서 안 열릴 수 있어요.' : `${picked.size}쪽 · 이름 예: ${pageName(safeName($('p2d-stem').value || baseName(name)), Math.min(...picked), pdf.numPages, FMT[fmt].ext)}`;
    }
    dlg.addEventListener('change', syncDialog);
    dlg.addEventListener('input', syncDialog);
    $('p2d-form').addEventListener('submit', (e) => {
      if (!e.submitter || e.submitter.value !== 'ok') return;
      e.preventDefault();
      const v = (n) => dlg.querySelector(`input[name="${n}"]:checked`).value;
      let dpi = Number(v('p2d-dpi'));
      if (dpi === 300 && isPhone()) { dpi = 150; toast('휴대폰에서는 보통(150)으로 바꿨어요.', '', 'info'); }
      const s = { fmt: v('p2d-fmt'), dpi, q: Number(v('p2d-q')) };
      dlg.close();
      save(s, { stem: $('p2d-stem').value.trim() || baseName(name), zipOn: $('p2d-zip').checked });
    });
    $('p2i-save-opts').addEventListener('click', openDialog);
    wireDrop($('p2i-drop'), $('p2i-input'), load);

    function reset(keepOptions) {
      token++;
      estToken++;
      clearTimeout(estTimer);
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
      $('p2i-webp').hidden = true;
      est.textContent = '';
      if (!keepOptions) {
        document.querySelector('input[name="p2i-dpi"][value="150"]').checked = true;
        document.querySelector('input[name="p2i-fmt"][value="png"]').checked = true;
        document.querySelector('input[name="p2i-q"][value="0.8"]').checked = true;
      }
    }
    return { load, reset, shortcutSave: (withOpts) => (withOpts ? openDialog() : save()) };
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

    // 이 파일에 걸린 제한 보기 (푸는 기능은 없다)
    const rTable = $('restrict-table');
    wireDrop($('restrict-drop'), $('restrict-input'), async (files) => {
      const f = files[0];
      formError('restrict-error', '');
      rTable.hidden = true;
      if (!isPdfFile(f)) return formError('restrict-error', `"${f.name}"은(는) PDF가 아니에요. PDF 파일을 골라 주세요.`);
      $('restrict-file').textContent = f.name;
      $('restrict-drop').classList.add('has-file');
      try {
        const bytes = await readBytes(f);
        const r = await withBusy('걸린 제한 확인 중…', () => Core.readRestrictions(bytes));
        const yes = (ok, a = '허용', b = '제한') => h('td', { class: ok ? 'ok' : 'no' }, ok ? a : b);
        const rows = [
          ['열기 암호', h('td', { class: r.needsPassword ? 'no' : 'ok' }, r.needsPassword ? '있음 — 비밀번호를 알아야 열려요' : r.encrypted ? '없음 (권한만 잠김)' : '없음')],
          ['암호 방식', h('td', null, r.encrypted ? r.algorithm : '걸려 있지 않음')],
          ['인쇄', yes(r.print)],
          ['내용 복사', yes(r.copy)],
          ['편집', yes(r.edit)],
          ['메모 · 주석', yes(r.annotate)],
          ['양식 채우기', yes(r.forms)],
          ['쪽 추가 · 빼기', yes(r.assemble)],
        ];
        rTable.tBodies[0].replaceChildren(...rows.map(([k, td]) => h('tr', null, h('th', { scope: 'row' }, k), td)));
        rTable.hidden = false;
        const limited = r.encrypted && !(r.print && r.copy && r.edit);
        if (limited) formError('restrict-error', '');
        toast(r.encrypted ? `"${f.name}"에 암호가 걸려 있어요.` : `"${f.name}"에는 제한이 없어요.`,
          limited ? '제한을 바꾸려면 만든 사람에게 권한 암호를 받아 [암호 풀기]에서 풀어 주세요. 비밀번호 없이 푸는 기능은 없어요.' : '', 'info', 7000);
      } catch (e) {
        const x = explain(e, f.name);
        formError('restrict-error', `${x.title} ${x.fix}`.trim());
      }
    });

    function reset() {
      rTable.hidden = true;
      $('restrict-file').textContent = 'PDF 고르기';
      $('restrict-drop').classList.remove('has-file');
      formError('restrict-error', '');
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
  // 꾸미기: 쪽번호 · 워터마크 · 서명/도장 (설정하고 저장 창과 같은 코드)
  // ═══════════════════════════════════════════════════════════
  const Decor = (() => {
    const unlockBox = $('decor-unlock');
    const ITEMS = ['number', 'watermark', 'stamp'];
    const editor = createDecorEditor({ itemsEl: $('decor-options'), previewEl: $('decor-preview'), items: ITEMS, order: ITEMS });
    const startOpts = () => ({ ...defaultOpts(), number: { ...defaultOpts().number, on: true } });
    editor.setOpts(startOpts());
    let file = null; // {name, bytes, pageCount}
    let pdf = null;
    let token = 0;
    editor.onChange(update);

    async function load(files) {
      const f = files[0];
      if (files.length > 1) toast('꾸미기는 한 번에 한 파일씩 할 수 있어요.', `첫 번째 파일 "${f.name}"만 열었어요.`, 'info');
      if (!isPdfFile(f)) return toast(`"${f.name}"은(는) PDF가 아니에요.`, 'PDF 파일을 넣어 주세요.');
      close();
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
          unlockBox.replaceChildren(h('p', null, `"${f.name}"은(는) 암호가 걸려 있어요. 비밀번호를 넣으면 꾸밀 수 있어요. 저장한 파일에는 암호가 없어요(설정하고 저장에서 다시 걸 수 있어요).`), row.el);
          unlockBox.hidden = false;
          row.input.focus();
          return;
        }
        await ready(f.name, info.bytes, info.doc.getPageCount());
      } catch (e) {
        showError(e, f.name);
      }
    }

    const source = () => ({
      count: file.pageCount,
      selected: [],
      getPage: async (i) => ({ page: await pdf.getPage(i + 1), rot: 0 }),
    });

    async function ready(name, bytes, pageCount) {
      file = { name, bytes, pageCount };
      pdf = await openPdfjs(bytes);
      $('decor-layout').hidden = false;
      $('decor-empty').hidden = true;
      $('decor-file').hidden = false;
      $('decor-bar').hidden = false;
      $('decor-name').textContent = `${name} · ${pageCount}쪽`;
      await editor.setSource(source());
      update();
    }

    const NAMES = { number: '쪽번호', watermark: '워터마크', stamp: '서명 · 도장' };
    function update() {
      if (!file) return;
      const o = editor.getOpts();
      const on = ITEMS.filter((k) => o[k].on && (k !== 'stamp' || o.stamp.ids.length));
      const err = editor.validate();
      $('decor-count').textContent = on.length ? `${file.pageCount}쪽 · ${on.map((k) => NAMES[k]).join(' · ')}` : '꾸밀 것을 켜 주세요';
      if (!isBusy()) $('decor-save').disabled = !on.length || !!err;
      $('decor-save').title = err || '바로 저장 (Ctrl+S)';
    }
    document.addEventListener('busyend', update);

    const stem = () => safeName(baseName(file.name));
    async function saveNow(o = editor.getOpts(), name = `${stem()}_꾸미기`) {
      if (!file) return toast('PDF를 먼저 넣어 주세요.', '');
      const err = editor.validate();
      if (err) return toast(err, '');
      try {
        const r = await withBusy('꾸미는 중…', async (progress, signal) => {
          const doc = await PDFDocument.load(file.bytes.slice(), { updateMetadata: false });
          return applyOptions(doc, o, progress, signal);
        }, { cancellable: true });
        download(r.bytes, `${name}.pdf`);
      } catch (e) { showError(e, file.name); }
    }
    function openDialog() {
      if (!file) return toast('PDF를 먼저 넣어 주세요.', '');
      SaveDialog.open({
        name: `${stem()}_꾸미기`,
        meta: `${file.pageCount}쪽`,
        source: source(),
        startPage: editor.pageIndex,
        preset: editor.getOpts(),
        run: (o, name) => saveNow(o, name),
      });
    }
    $('decor-save').addEventListener('click', () => saveNow());
    $('decor-save-opts').addEventListener('click', openDialog);
    wireDrop($('decor-drop'), $('decor-input'), load);
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (activeTab === 'decorate' && file) editor.redraw(); }, 200);
    });

    function close() {
      token++;
      if (pdf) pdf.destroy();
      pdf = null;
      file = null;
      unlockBox.hidden = true;
      $('decor-layout').hidden = true;
      $('decor-empty').hidden = false;
      $('decor-file').hidden = true;
      $('decor-bar').hidden = true;
    }
    function reset() {
      close();
      editor.setOpts(startOpts());
    }
    return { load, reset, shortcutSave: (withOpts) => (withOpts ? openDialog() : saveNow()) };
  })();

  // ═══════════════════════════════════════════════════════════
  // 비교해 보기 (원본과 결과의 같은 쪽을 나란히)
  // ═══════════════════════════════════════════════════════════
  const Compare = (() => {
    const dlg = $('compare-dialog');
    const fileSel = $('cv-file');
    const zoomSel = $('cv-zoom');
    const paneA = $('cv-a');
    const paneB = $('cv-b');
    let items = [];
    let cur = 0;
    let page = 1;
    let docs = {};
    let token = 0;

    async function docOf(key, bytes) {
      if (!docs[key]) docs[key] = openPdfjs(bytes);
      return docs[key];
    }
    async function drawPdf(pane, doc, zoom, my) {
      const pg = await doc.getPage(Math.min(page, doc.numPages));
      const vp1 = pg.getViewport({ scale: 1 });
      const cssW = (pane.clientWidth - 4) * zoom;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = pg.getViewport({ scale: (cssW / vp1.width) * dpr });
      const c = makeCanvas(vp.width, vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      if (my !== token) return;
      c.style.width = `${cssW}px`;
      pane.replaceChildren(c);
    }
    async function draw() {
      const it = items[cur];
      if (!it) return;
      const my = ++token;
      const zoom = Number(zoomSel.value);
      $('cv-a-size').textContent = fmtMB(it.aSize);
      $('cv-b-size').textContent = fmtMB(it.bSize);
      if (it.kind === 'pdf') {
        const a = await docOf(`a${cur}`, it.a);
        const b = await docOf(`b${cur}`, it.b);
        const n = Math.min(a.numPages, b.numPages);
        page = Math.max(1, Math.min(page, n));
        $('cv-page').textContent = `${page} / ${n}쪽`;
        $('cv-prev').disabled = page <= 1;
        $('cv-next').disabled = page >= n;
        await Promise.all([drawPdf(paneA, a, zoom, my), drawPdf(paneB, b, zoom, my)]);
      } else {
        $('cv-page').textContent = '사진';
        $('cv-prev').disabled = $('cv-next').disabled = true;
        for (const [pane, blob] of [[paneA, it.a], [paneB, it.b]]) {
          const img = h('img', { alt: '', src: URL.createObjectURL(blob) });
          img.style.width = `${(pane.clientWidth - 4) * zoom}px`;
          img.onload = () => URL.revokeObjectURL(img.src);
          pane.replaceChildren(img);
        }
      }
    }
    // 두 칸을 같이 스크롤
    let syncing = false;
    for (const [x, y] of [[paneA, paneB], [paneB, paneA]]) {
      x.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        y.scrollTop = x.scrollTop;
        y.scrollLeft = x.scrollLeft;
        requestAnimationFrame(() => { syncing = false; });
      });
    }
    zoomSel.addEventListener('change', draw);
    fileSel.addEventListener('change', () => { cur = Number(fileSel.value); page = 1; draw(); });
    $('cv-prev').addEventListener('click', () => { page--; draw(); });
    $('cv-next').addEventListener('click', () => { page++; draw(); });
    dlg.addEventListener('close', () => {
      Object.values(docs).forEach((p) => p.then((d) => d.destroy()).catch(() => {}));
      docs = {};
      paneA.replaceChildren();
      paneB.replaceChildren();
    });
    function open(list) {
      items = list;
      cur = 0;
      page = 1;
      fileSel.replaceChildren(...list.map((it, i) => h('option', { value: String(i) }, it.name)));
      fileSel.hidden = list.length < 2;
      dlg.showModal();
      requestAnimationFrame(() => draw().catch(showError));
    }
    return { open };
  })();

  // ═══════════════════════════════════════════════════════════
  // 용량 줄이기
  // ═══════════════════════════════════════════════════════════
  const Shrink = (() => {
    const listEl = $('cmp-files');
    const thumb = $('cmp-thumb');
    const track = $('cmp-track');
    const mbInput = $('cmp-mb');
    const TICKS = [['공문 10MB', 10], ['메일 20MB', 20], ['5MB', 5], ['2MB', 2]];
    const IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    let files = [];
    let seq = 0;
    let target = 0; // 바이트
    let range = { min: 0, max: 0 };

    const isPdf = (f) => f.kind === 'pdf';
    const basis = () => document.querySelector('input[name="cmp-basis"]:checked').value;
    const photos = () => files.filter((f) => f.kind === 'image' && f.ready);
    const readyFiles = () => files.filter((f) => f.ready);
    const mergeReasons = (list) => {
      const out = {};
      for (const r of list) for (const [k, v] of Object.entries(r || {})) out[k] = (out[k] || 0) + v;
      return out;
    };
    const reasonText = (r) => Object.entries(r || {}).map(([k, v]) => `${k} ${v}장`).join(', ');

    async function addFiles(list) {
      const ok = list.filter((f) => isPdfFile(f) || /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name));
      const bad = list.length - ok.length;
      if (bad) toast(`넣을 수 없는 파일 ${bad}개는 뺐어요.`, 'PDF나 JPG · PNG · WEBP 사진만 줄일 수 있어요.');
      if (!ok.length) return;
      const added = ok.map((file) => ({ id: `c${++seq}`, file, name: file.name, kind: isPdfFile(file) ? 'pdf' : 'image', size: file.size, state: '읽는 중…' }));
      files.push(...added);
      clearResults();
      render();
      try {
        await withBusy('얼마까지 줄일 수 있는지 재는 중…', async (progress, signal) => {
          for (let i = 0; i < added.length; i++) {
            const f = added[i];
            await progress(`${f.name} 살펴보는 중 (${i + 1}/${added.length})`, i, added.length);
            try {
              await prepare(f, signal);
            } catch (e) {
              if (isAbort(e)) throw e;
              f.error = explain(e, f.name);
              f.state = '읽지 못했어요';
              showError(e, f.name);
            }
            render();
          }
        }, { cancellable: true });
      } catch (e) {
        if (!isAbort(e)) showError(e);
        added.filter((f) => !f.ready && !f.locked).forEach((f) => { f.state = '취소함'; });
      }
      render();
      setupTarget();
    }

    async function prepare(f, signal) {
      const bytes = await readBytes(f.file);
      if (f.kind === 'pdf') {
        const info = await Core.openPdf(bytes);
        if (info.locked) {
          f.locked = true;
          f.bytes = bytes;
          f.state = '암호가 걸려 있어요';
          return;
        }
        f.bytes = info.wasEncrypted ? info.bytes : bytes;
        f.pages = info.doc.getPageCount();
        await analyzePdf(f, signal);
      } else {
        f.bytes = bytes;
        const codec = Squeeze.codec();
        const hd = await codec.fromBlob(new Blob([bytes], { type: f.file.type || 'image/jpeg' }));
        const alpha = f.file.type === 'image/png' && codec.hasAlpha(hd);
        f.outType = alpha ? (await canEncode('image/webp') ? 'image/webp' : 'image/png') : 'image/jpeg';
        f.handle = hd;
        const low = await codec.encode(hd, Compress.params(0).scale, Compress.params(0).q, f.outType);
        f.min = Math.min(bytes.length, low.bytes.length);
        f.lossless = bytes.length;
        f.ready = true;
        f.state = `${f.handle.w}×${f.handle.h}`;
        if (f.outType !== f.file.type) f.note = alpha ? `투명한 곳이 있어 ${IMG_TYPES[f.outType].toUpperCase()}로 저장해요` : 'JPG로 바꿔 저장해요';
      }
    }
    async function analyzePdf(f, signal) {
      const a = await Squeeze.analyze(f.bytes, { signal });
      f.min = a.min;
      f.lossless = a.lossless;
      f.mostlyText = a.mostlyText;
      f.images = a.images;
      f.skipped = a.skipped;
      f.reasons = a.reasons;
      f.ready = true;
      noteFile(f.size, f.pages);
      f.state = `${f.pages}쪽 · 줄일 수 있는 사진 ${a.images}장${a.skipped ? ` · 그대로 둘 사진 ${a.skipped}장` : ''}`;
    }
    let webpOk = null;
    async function canEncode(type) {
      if (webpOk == null) {
        const c = makeCanvas(2, 2);
        webpOk = await new Promise((r) => c.toBlob((b) => r(!!b && b.type === type), type, 0.8));
      }
      return webpOk;
    }

    function render() {
      $('cmp-empty').hidden = files.length > 0;
      listEl.replaceChildren(...files.map((f) => {
        const res = f.result;
        const over = res && res.size > f.target;
        const li = h('li', { class: `cmp-file${res ? (over ? ' over' : ' done') : ''}`, 'data-id': f.id },
          h('span', { class: 'cf-icon', 'aria-hidden': 'true' }, icon(f.kind === 'pdf' ? 'filedown' : 'image')),
          h('span', { class: 'cf-name', title: f.name }, f.name),
          h('span', { class: 'cf-size' }, h('span', null, fmtMB(f.size)),
            res ? h('span', { class: 'cf-arrow' }, ' → ') : null,
            res ? h('b', null, fmtMB(res.size)) : null),
          h('span', { class: 'cf-state' }, f.error ? `${f.error.title.replace(/^"[^"]*": /, '')} ${f.error.fix || ''}` : res ? resultText(f) : f.state),
          f.note ? h('small', { class: 'cf-note' }, f.note) : null,
          h('button', { type: 'button', class: 'icon-btn cf-x', 'data-del': f.id, 'aria-label': `${f.name} 빼기`, title: '빼기' }, icon('x', 'ic sm')));
        if (f.locked) {
          const row = passwordRow({
            placeholder: '이 파일의 비밀번호',
            onSubmit: async (pw) => {
              const r = await withBusy('암호 푸는 중…', () => Core.decrypt(f.bytes, pw));
              f.bytes = r.bytes;
              f.pages = r.doc.getPageCount();
              f.locked = false;
              await withBusy('얼마까지 줄일 수 있는지 재는 중…', (p, signal) => analyzePdf(f, signal), { cancellable: true });
              render();
              setupTarget();
              toast(`"${f.name}" 암호를 풀었어요.`, '줄인 파일에는 암호가 없어요. 설정하고 저장에서 다시 걸 수 있어요.', 'ok');
            },
          });
          li.append(h('div', { class: 'cf-unlock' }, row.el));
        }
        return li;
      }));
    }
    function resultText(f) {
      const r = f.result;
      const head = `목표 ${fmtT(f.target)} · 결과 ${fmtT(r.size)} · 화질 ${r.quality || '원본 그대로'}`;
      const skip = r.skipped ? ` · 건너뛴 사진 ${r.skipped}장(${reasonText(r.reasons)})` : '';
      if (r.size <= f.target) return `✓ ${head}${skip}`;
      return `${head} — 목표보다 ${fmtT(r.size - f.target)} 커요${skip}`;
    }
    listEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-del]');
      if (!b || isBusy()) return;
      const f = files.find((x) => x.id === b.dataset.del);
      if (f && f.handle) Squeeze.codec().release(f.handle);
      files = files.filter((x) => x.id !== b.dataset.del);
      clearResults();
      render();
      setupTarget();
    });

    // ── 목표 용량 막대 ──
    // 한 칸 = 줄일 수 있는 폭의 약 1/100을 보기 좋은 값(0.01~1MB)으로 올림. 표시 자릿수도 맞춘다.
    let step = 0.1 * MB;
    let digits = 1;
    let locked = false;
    const fmtT = (v) => `${(v / MB).toFixed(digits)}MB`;
    const snapV = (v) => Math.round(v / step) * step;

    function computeRange() {
      const ready = readyFiles();
      if (!ready.length) return { min: 0, max: 0 };
      const onlyPhotos = ready.every((f) => f.kind === 'image');
      if (onlyPhotos && ready.length > 1 && basis() === 'total') {
        return { min: ready.reduce((s, f) => s + f.min, 0), max: ready.reduce((s, f) => s + f.size, 0) };
      }
      // 파일마다 같은 목표: 가장 큰 파일 기준
      const big = ready.reduce((a, b) => (b.size > a.size ? b : a));
      return { min: Math.min(big.min, big.size), max: big.size };
    }
    function setupTarget() {
      const ready = readyFiles();
      $('cmp-target').hidden = !ready.length;
      $('cmp-basis').hidden = !(ready.length > 1 && ready.every((f) => f.kind === 'image'));
      if (!ready.length) return;
      range = computeRange();
      const stepMB = Compress.niceStep(range.max - range.min);
      step = stepMB * MB;
      digits = stepMB < 0.1 ? 2 : stepMB < 1 ? 1 : 0;
      // 줄일 수 있는 폭이 원래의 5% 미만이면 막대를 잠근다(3단계는 여전히 쓸 수 있다)
      locked = range.max - range.min < range.max * 0.05;
      $('cmp-vol').classList.toggle('locked', locked);
      thumb.tabIndex = locked ? -1 : 0;
      thumb.setAttribute('aria-disabled', String(locked));
      $('cmp-step').textContent = `한 칸 ${stepMB}MB`;
      // 기본 목표: 10MB 넘으면 10MB, 아니면 원래의 70%
      const def = range.max > 10 * MB ? 10 * MB : range.max * 0.7;
      setTarget(Math.max(range.min, Math.min(range.max, snapV(def) || def)), false);
      // 눈금 칩: 원래 용량보다 작은 것만
      const ticks = TICKS.filter(([, v]) => v * MB < range.max);
      $('cmp-ticks').replaceChildren(...ticks.map(([label, v]) => {
        const p = frac(v * MB);
        return h('button', { type: 'button', class: `vol-tick${v * MB < range.min ? ' low' : ''}`, 'data-mb': String(v), style: `left:${p * 100}%`, title: v * MB < range.min ? `이 파일은 약 ${fmtT(range.min)}까지만 줄일 수 있어요` : `${v}MB 이하로`, disabled: locked }, label);
      }));
      $('cmp-min').textContent = `최소 약 ${fmtT(range.min)}`;
      $('cmp-max').textContent = `원래 ${fmtT(range.max)}`;
      const notes = [];
      const skipped = ready.filter((f) => f.skipped);
      if (skipped.length) notes.push(`그대로 둘 사진 ${skipped.reduce((s, f) => s + f.skipped, 0)}장(${reasonText(mergeReasons(skipped.map((f) => f.reasons)))})`);
      if (ready.length > 1 && !(ready.every((f) => f.kind === 'image') && basis() === 'total')) notes.push('목표는 파일마다 따로 적용돼요.');
      $('cmp-note').textContent = notes.join(' · ');
    }
    const frac = (v) => (range.max > range.min ? Math.max(0, Math.min(1, (v - range.min) / (range.max - range.min))) : 1);
    function setTarget(v, fromInput) {
      target = Math.max(1024, v);
      const p = frac(target);
      thumb.style.left = `${p * 100}%`;
      $('cmp-fill').style.width = `${p * 100}%`;
      const text = fmtT(target);
      $('cmp-bubble').textContent = text;
      thumb.setAttribute('aria-valuemin', (range.min / MB).toFixed(digits));
      thumb.setAttribute('aria-valuemax', (range.max / MB).toFixed(digits));
      thumb.setAttribute('aria-valuenow', (target / MB).toFixed(digits));
      thumb.setAttribute('aria-valuetext', `${text} 이하`);
      if (!fromInput) mbInput.value = (target / MB).toFixed(digits);
      const same = target >= range.max;
      const below = target < range.min;
      const q = same ? '원본 그대로' : below ? '3단계 필요' : `예상 화질: ${Compress.qualityLabel(p)}`;
      $('cmp-quality').textContent = q;
      $('cmp-quality').dataset.q = same ? 'same' : below ? 'low' : Compress.qualityLabel(p);
      const msg = $('cmp-msg');
      msg.className = 'cmp-msg';
      if (locked && !below && !(fromInput && same)) {
        msg.textContent = '이 파일은 더 줄일 여지가 거의 없어요(대부분 글꼴이거나 이미 압축된 사진이라서). 목표를 숫자로 적으면 쪽을 사진으로 바꾸는 3단계를 쓸 수 있어요.';
        msg.classList.add('low');
      } else if (same) {
        msg.textContent = `원본 그대로면 돼요. (원래 ${fmtT(range.max)})`;
        msg.classList.add('same');
      } else if (below) {
        msg.textContent = `최소 약 ${fmtT(range.min)}까지 줄일 수 있어요. 더 줄이려면 쪽을 사진으로 바꿔야 해요(3단계). [줄이기]를 누르면 물어봐요.`;
        msg.classList.add('low');
      } else if (locked) {
        msg.textContent = '이 파일은 더 줄일 여지가 거의 없어요(대부분 글꼴이거나 이미 압축된 사진이라서). 목표를 숫자로 적으면 쪽을 사진으로 바꾸는 3단계를 쓸 수 있어요.';
        msg.classList.add('low');
      } else msg.textContent = '';
      $('cmp-go').disabled = isBusy() || !readyFiles().length || same;
    }
    const fromX = (clientX) => {
      const r = track.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const v = range.min + p * (range.max - range.min);
      if (p <= 0) return range.min;
      if (p >= 1) return range.max;
      return Math.max(range.min, Math.min(range.max, snapV(v)));
    };
    let dragging = false;
    track.addEventListener('pointerdown', (e) => {
      if (locked || e.target.closest('.vol-tick')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
      thumb.classList.add('grabbing');
      setTarget(fromX(e.clientX));
      thumb.focus({ preventScroll: true });
    });
    track.addEventListener('pointermove', (e) => { if (dragging) setTarget(fromX(e.clientX)); });
    const endDrag = () => { dragging = false; thumb.classList.remove('grabbing'); };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('lostpointercapture', endDrag);
    thumb.addEventListener('keydown', (e) => {
      if (locked) return;
      let v = null;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = Math.max(range.min, snapV(target) - step);
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = Math.min(range.max, snapV(target) + step);
      if (e.key === 'Home') v = range.min;
      if (e.key === 'End') v = range.max;
      if (e.key === 'PageDown') v = Math.max(range.min, snapV(target) - step * 10);
      if (e.key === 'PageUp') v = Math.min(range.max, snapV(target) + step * 10);
      if (v == null) return;
      e.preventDefault();
      setTarget(v);
    });
    $('cmp-ticks').addEventListener('click', (e) => {
      const b = e.target.closest('.vol-tick');
      if (!b || locked) return;
      setTarget(Number(b.dataset.mb) * MB);
    });
    mbInput.addEventListener('input', () => {
      const v = Number(mbInput.value.replace(',', '.'));
      if (v > 0) setTarget(v * MB, true);
    });
    mbInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!$('cmp-go').disabled) go(); } });
    document.querySelectorAll('input[name="cmp-basis"]').forEach((r) => r.addEventListener('change', () => { clearResults(); setupTarget(); }));

    // ── 줄이기 ──
    function clearResults() {
      files.forEach((f) => { delete f.result; delete f.target; });
      $('cmp-result').hidden = true;
    }
    async function go() {
      const ready = readyFiles();
      if (!ready.length) return toast('줄일 파일을 먼저 넣어 주세요.', '');
      if (!(target > 0)) return mbInput.focus();
      clearResults();
      const total = ready.length > 1 && ready.every((f) => f.kind === 'image') && basis() === 'total';
      try {
        await withBusy('줄이는 중…', async (progress, signal) => {
          if (total) {
            await shrinkPhotosTotal(ready, target, progress, signal);
          } else {
            for (let i = 0; i < ready.length; i++) {
              const f = ready[i];
              f.target = target;
              const label = ready.length > 1 ? `${i + 1}/${ready.length} · ` : '';
              if (f.kind === 'pdf') {
                const r = await squeezePdf(f.bytes, target, progress, signal, { label });
                f.result = {
                  bytes: r.bytes, size: r.bytes.length, stage: r.result.stage, status: r.result.status, type: 'application/pdf',
                  quality: r.result.stage === 3 ? '쪽을 사진으로' : r.result.quality || '원본 그대로', skipped: r.result.skipped || 0, reasons: r.result.reasons || {},
                };
              } else {
                await progress(`${label}사진 줄이는 중 ${i + 1}/${ready.length}`, i, ready.length);
                const r = await Compress.compressImage(f.handle, f.size, target, Squeeze.codec(), { type: f.outType, signal });
                const keep = r.bytes.length >= f.size && f.outType === f.file.type;
                f.result = keep ? { bytes: f.bytes, size: f.size, stage: 1, type: f.file.type, quality: '원본 그대로' } : { bytes: r.bytes, size: r.bytes.length, stage: 2, type: r.type || f.outType, quality: r.quality };
              }
              render();
            }
          }
        }, { cancellable: true });
      } catch (e) {
        showError(e);
      }
      render();
      showResult();
    }
    // 사진 여러 장을 "전체 합쳐서" 목표에: 모든 사진에 같은 t를 쓰고 합계로 이진 탐색
    async function shrinkPhotosTotal(list, tgt, progress, signal) {
      const codec = Squeeze.codec();
      const memo = new Map();
      const encAll = async (t) => {
        if (memo.has(t)) return memo.get(t);
        const { scale, q } = Compress.params(t);
        const out = [];
        for (let i = 0; i < list.length; i++) {
          if (signal.aborted) throw abortError();
          await progress(`사진 줄이는 중 ${i + 1}/${list.length}`, i, list.length);
          out.push(await codec.encode(list[i].handle, scale, q, list[i].outType));
        }
        memo.set(t, out);
        return out;
      };
      const s = await Compress.searchT(async (t) => (await encAll(t)).reduce((a, r) => a + r.bytes.length, 0), tgt, { steps: 6, signal });
      const out = await encAll(s.t);
      list.forEach((f, i) => {
        f.target = (tgt * f.size) / list.reduce((a, x) => a + x.size, 0);
        f.result = { bytes: out[i].bytes, size: out[i].bytes.length, stage: 2, type: out[i].type || f.outType, quality: Compress.qualityLabel(s.t) };
      });
      list.totalTarget = tgt;
    }

    function showResult() {
      const done = files.filter((f) => f.result);
      if (!done.length) return;
      const before = done.reduce((s, f) => s + f.size, 0);
      const after = done.reduce((s, f) => s + f.result.size, 0);
      const totalMode = done.length > 1 && done.every((f) => f.kind === 'image') && basis() === 'total';
      const over = totalMode ? after > target : done.some((f) => f.result.size > f.target);
      const box = $('cmp-summary');
      box.className = `cmp-summary ${over ? 'over' : 'ok'}`;
      box.replaceChildren(
        h('span', null, fmtT(before)), ' → ', h('b', null, fmtT(after)), ' ',
        over
          ? h('span', { class: 'bad' }, totalMode ? `목표보다 ${fmtT(after - target)} 커요` : `${done.filter((f) => f.result.size > f.target).length}개 파일이 목표보다 커요`)
          : h('span', { class: 'good' }, `✓ 목표(${fmtT(target)}) 이하`),
        done.length === 1 ? h('small', { class: 'cmp-detail' }, `목표 ${fmtT(done[0].target || target)} · 결과 ${fmtT(done[0].result.size)} · 화질 ${done[0].result.quality || '원본 그대로'}`) : '',
        (() => {
          const sk = done.reduce((a, f) => a + (f.result.skipped || 0), 0);
          return sk ? h('small', { class: 'cmp-detail' }, `건너뛴 사진 ${sk}장 (${reasonText(mergeReasons(done.map((f) => f.result.reasons)))}) — 원본 그대로 두었어요`) : '';
        })());
      const advice = [];
      done.filter((f) => f.result.size > f.target).forEach((f) => {
        if (f.kind === 'pdf' && f.result.status === 'raster') {
          advice.push(h('p', null, `"${f.name}": 사진만 줄여서는 ${fmtT(f.result.size)}까지예요(목표보다 ${fmtT(f.result.size - f.target)} 커요). 쪽을 사진으로 바꾸면 더 줄일 수 있어요(글자 선택 불가). `,
            h('button', { type: 'button', class: 'btn sm', 'data-raster': f.id }, '쪽을 사진으로 바꿔 더 줄이기…')));
        } else if (f.kind === 'pdf' && f.result.status === 'cannot') {
          advice.push(h('p', null, `"${f.name}": 줄일 사진이 없어요. 이 파일은 약 ${fmtMB(f.result.size)}까지만 줄일 수 있어요(대부분 글꼴이라서). 쪽을 나눠 저장하는 방법도 있어요.`));
        } else {
          advice.push(h('p', null, `"${f.name}": 목표를 조금 올리거나(약 ${fmtMB(f.result.size)}), 사진 크기를 줄여 다시 넣어 보세요.`));
        }
      });
      $('cmp-advice').replaceChildren(...advice);
      $('cmp-result').hidden = false;
      $('cmp-save-opts').disabled = !done.some((f) => f.kind === 'pdf');
      $('cmp-save-opts').title = done.some((f) => f.kind === 'pdf') ? '쪽번호 · 워터마크 · 도장 · 암호 (Ctrl+Shift+S)' : '설정하고 저장은 PDF에만 쓸 수 있어요';
      $('cmp-result').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    $('cmp-advice').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-raster]');
      if (!b) return;
      const f = files.find((x) => x.id === b.dataset.raster);
      if (!f) return;
      const ok = await confirmBox({
        title: '쪽을 사진으로 바꿀까요?',
        body: '쪽 전체를 그림으로 바꾸면 더 줄어들지만, 글자를 선택하거나 검색할 수 없어요.',
        yes: '그래도 줄이기',
        no: '여기까지만',
      });
      if (!ok) return;
      try {
        const out = await withBusy('쪽을 사진으로 바꾸는 중…', (progress, signal) => rasterToTarget(f.result.bytes, f.target, progress, signal), { cancellable: true });
        if (out.length < f.result.size) f.result = { ...f.result, bytes: out, size: out.length, stage: 3, status: out.length <= f.target ? 'done' : 'raster', quality: '쪽을 사진으로' };
      } catch (err) { showError(err); }
      render();
      showResult();
    });
    $('cmp-go').addEventListener('click', go);

    $('cmp-compare').addEventListener('click', () => {
      const done = files.filter((f) => f.result);
      if (!done.length) return;
      Compare.open(done.map((f) => ({
        name: f.name,
        kind: f.kind,
        a: f.kind === 'pdf' ? f.bytes : new Blob([f.bytes], { type: f.file.type }),
        b: f.kind === 'pdf' ? f.result.bytes : new Blob([f.result.bytes], { type: f.result.type }),
        aSize: f.size,
        bSize: f.result.size,
      })));
    });

    const outName = (f, suffix = '_줄임') => {
      const ext = f.kind === 'pdf' ? 'pdf' : (IMG_TYPES[f.result.type] || 'jpg');
      return `${safeName(baseName(f.name))}${suffix}.${ext}`;
    };
    async function saveNow() {
      const done = files.filter((f) => f.result);
      if (!done.length) return toast('먼저 [줄이기]를 눌러 주세요.', '');
      if (done.length === 1) return download(done[0].result.bytes, outName(done[0]), done[0].result.type);
      try {
        const blob = await withBusy('zip으로 묶는 중…', async () => {
          const zip = new JSZip();
          done.forEach((f) => zip.file(outName(f), f.result.bytes));
          return zip.generateAsync({ type: 'blob', compression: 'STORE' });
        });
        download(blob, `용량줄이기_${ymd()}.zip`, 'application/zip');
      } catch (e) { showError(e); }
    }
    async function openDialog() {
      const done = files.filter((f) => f.result && f.kind === 'pdf');
      if (!done.length) return toast('설정하고 저장은 줄인 PDF에 쓸 수 있어요.', '먼저 [줄이기]를 눌러 주세요.', 'info');
      const first = done[0];
      const pdf = await openPdfjs(first.result.bytes);
      SaveDialog.open({
        name: done.length === 1 ? `${safeName(baseName(first.name))}_줄임` : `용량줄이기_${ymd()}`,
        meta: `${done.length}개 파일 · ${fmtMB(done.reduce((s, f) => s + f.result.size, 0))}`,
        source: { count: pdf.numPages, selected: [], getPage: async (i) => ({ page: await pdf.getPage(i + 1), rot: 0 }) },
        onClose: () => setTimeout(() => pdf.destroy(), 1000),
        run: async (o, name) => {
          try {
            const out = await withBusy('저장 준비 중…', async (progress, signal) => {
              const res = [];
              for (let i = 0; i < done.length; i++) {
                const f = done[i];
                const label = done.length > 1 ? `${i + 1}/${done.length} · ` : '';
                const doc = await PDFDocument.load(f.result.bytes.slice(), { updateMetadata: false });
                const r = await applyOptions(doc, o, progress, signal, { label });
                res.push({ name: done.length === 1 ? `${name}.pdf` : outName(f), bytes: r.bytes });
              }
              if (res.length === 1) return res[0];
              const zip = new JSZip();
              res.forEach((x) => zip.file(x.name, x.bytes));
              return { name: `${name}.zip`, blob: await zip.generateAsync({ type: 'blob', compression: 'STORE' }) };
            }, { cancellable: true });
            download(out.blob || out.bytes, out.name, out.blob ? 'application/zip' : 'application/pdf');
          } catch (e) { showError(e); }
        },
      });
    }
    $('cmp-save').addEventListener('click', saveNow);
    $('cmp-save-opts').addEventListener('click', openDialog);
    wireDrop($('cmp-drop'), $('cmp-input'), (list) => addFiles(list));
    document.addEventListener('busyend', () => { if (readyFiles().length) $('cmp-go').disabled = false; });

    function reset() {
      files.forEach((f) => f.handle && Squeeze.codec().release(f.handle));
      files = [];
      target = 0;
      render();
      $('cmp-target').hidden = true;
      $('cmp-result').hidden = true;
    }
    return {
      addFiles,
      reset,
      shortcutSave: (withOpts) => (withOpts ? openDialog() : saveNow()),
      state: () => ({ target, range, files: files.map((f) => ({ name: f.name, size: f.size, min: f.min, result: f.result && f.result.size, stage: f.result && f.result.stage })) }),
    };
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
    Decor.reset();
    Shrink.reset();
    SaveDialog.close();
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

  // ═══════════════════════════════════════════════════════════
  // 편집 도구 오른쪽 "이렇게 써요" 패널 (1280px 미만에서는 오른쪽 서랍)
  // ═══════════════════════════════════════════════════════════
  const Guide = (() => {
    const aside = $('edit-guide');
    const layout = aside.parentElement;
    const foldBtn = $('guide-fold');
    const rail = $('guide-rail');
    const backdrop = $('guide-backdrop');
    const wide = matchMedia('(min-width: 1280px)');
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    const KEY = 'pdfws.guideCollapsed';

    let collapsed = false;
    try { collapsed = localStorage.getItem(KEY) === '1'; } catch { /* 저장소를 못 써도 동작한다 */ }
    let drawer = false;
    let lastFocus = null;

    const saveCollapsed = () => {
      try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* 무시 */ }
    };

    // ── 움직이는 예시: DOM + CSS transition, 단계별 타임라인을 무한 반복 ──
    const CURSOR = '<svg viewBox="0 0 16 22" aria-hidden="true"><path d="M1.5 1.5v16.2l4.3-4.1 2.9 6.6 2.8-1.2-2.9-6.5h5.9z"/></svg>';
    function stageParts(stage) {
      const inner = h('div', { class: 'demo-inner' });
      const cursor = h('div', { class: 'demo-cursor' });
      cursor.innerHTML = CURSOR;
      const ripple = h('div', { class: 'demo-ripple' });
      stage.replaceChildren(inner);
      inner.append(ripple, cursor);
      const at = (el, x, y) => { el.style.transform = `translate(${x}px, ${y}px)`; };
      return {
        inner,
        moveCursor(x, y) { cursor.dataset.x = x; cursor.dataset.y = y; at(cursor, x, y); },
        click() {
          at(ripple, Number(cursor.dataset.x) - 14, Number(cursor.dataset.y) - 14);
          ripple.classList.remove('go');
          void ripple.offsetWidth; // 애니메이션을 처음부터 다시
          ripple.classList.add('go');
        },
        at,
      };
    }
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
    const PAGE_Y = 58;
    function minis(inner, n) {
      return Array.from({ length: n }, (_, k) => {
        const el = h('div', { class: 'mini' }, h('b', null, String(k + 1)));
        inner.append(el);
        return el;
      });
    }
    const center = (slot) => [SLOT(slot) + 15, PAGE_Y + 22];

    // ① 여러 쪽을 한꺼번에 옮기기
    function demoMove(stage) {
      const s = stageParts(stage);
      const ps = minis(s.inner, 5);
      const key = h('span', { class: 'demo-key' }, 'Ctrl');
      const status = h('span', { class: 'demo-status' });
      s.inner.append(key, status);
      const place = (order, lift = []) => order.forEach((no, slot) => {
        const el = ps[no - 1];
        el.classList.toggle('lift', lift.includes(no));
        s.at(el, SLOT(slot), PAGE_Y - (lift.includes(no) ? 8 : 0));
      });
      const reset = () => {
        ps.forEach((el) => el.classList.remove('sel', 'lift'));
        place([1, 2, 3, 4, 5]);
        key.classList.remove('pressed');
        status.classList.remove('show');
        s.moveCursor(200, 118);
      };
      return {
        reset,
        steps: [
          [500, () => s.moveCursor(...center(1))],
          [650, () => { s.click(); ps[1].classList.add('sel'); }],
          [450, () => key.classList.add('pressed')],
          [400, () => s.moveCursor(...center(3))],
          [650, () => { s.click(); ps[3].classList.add('sel'); status.textContent = '2쪽 선택됨'; status.classList.add('show'); }],
          [550, () => { key.classList.remove('pressed'); place([1, 2, 3, 4, 5], [2, 4]); }],
          [350, () => {
            // 두 장이 살짝 들린 채 커서를 따라 맨 앞으로
            s.moveCursor(SLOT(0) + 22, PAGE_Y + 10);
            s.at(ps[1], SLOT(0) - 4, PAGE_Y - 12);
            s.at(ps[3], SLOT(0) + 4, PAGE_Y - 6);
          }],
          [800, () => { s.click(); place([2, 4, 1, 3, 5]); status.textContent = '순서 2, 4, 1, 3, 5'; }],
          [2400, () => {}],
        ],
      };
    }

    // ② 이어진 쪽을 범위로 고르기
    function demoRange(stage) {
      const s = stageParts(stage);
      const ps = minis(s.inner, 5);
      const key = h('span', { class: 'demo-key' }, 'Shift');
      const del = h('b', { class: 'demo-del' }, '삭제');
      const count = h('span', null, '4쪽 선택됨 → ');
      const status = h('span', { class: 'demo-status' }, count, del);
      s.inner.append(key, status);
      const reset = () => {
        ps.forEach((el, k) => { el.classList.remove('sel', 'gone'); s.at(el, SLOT(k), PAGE_Y); });
        key.classList.remove('pressed');
        status.classList.remove('show');
        del.classList.remove('hit');
        s.moveCursor(200, 118);
      };
      return {
        reset,
        steps: [
          [500, () => s.moveCursor(...center(1))],
          [650, () => { s.click(); ps[1].classList.add('sel'); }],
          [450, () => key.classList.add('pressed')],
          [400, () => s.moveCursor(...center(4))],
          [650, () => s.click()],
          [120, () => ps[2].classList.add('sel')],
          [120, () => ps[3].classList.add('sel')],
          [120, () => { ps[4].classList.add('sel'); status.classList.add('show'); }],
          [500, () => { key.classList.remove('pressed'); s.moveCursor(del.offsetLeft + status.offsetLeft + 14, status.offsetTop + 12); }],
          [650, () => { s.click(); del.classList.add('hit'); }],
          [250, () => ps.slice(1).forEach((el) => el.classList.add('gone'))],
          [2400, () => {}],
        ],
      };
    }

    // ③ 돌리기는 90°씩
    function demoRotate(stage) {
      const s = stageParts(stage);
      const page = h('div', { class: 'mini big' }, h('b', null, 'A'));
      const left = h('span', { class: 'demo-btn' }, '↺');
      const right = h('span', { class: 'demo-btn' }, '↻');
      const deg = h('span', { class: 'demo-deg' }, '0°');
      s.inner.append(page, left, right, deg);
      s.at(page, 42, 26);
      s.at(left, 138, 36);
      s.at(right, 186, 36);
      s.at(deg, 138, 80);
      let turn = 0; // 누적 각도(부드럽게 돌도록), 보여 주는 숫자는 0/90/180/270
      const show = () => {
        page.style.transform = `translate(42px, 26px) rotate(${turn}deg)`;
        deg.textContent = `${Core.normAngle(turn)}°`;
      };
      const press = (btn, dir) => {
        s.click();
        btn.classList.remove('press');
        void btn.offsetWidth;
        btn.classList.add('press');
        turn += dir * 90;
        show();
      };
      const reset = () => {
        turn = 0;
        show();
        s.moveCursor(120, 118);
      };
      return {
        reset,
        steps: [
          [500, () => s.moveCursor(204, 52)],
          [650, () => press(right, 1)],
          [900, () => press(right, 1)],
          [900, () => s.moveCursor(156, 52)],
          [650, () => press(left, -1)],
          [900, () => press(left, -1)],
          [2200, () => {}],
        ],
      };
    }

    const demos = [
      timeline(aside.querySelector('#demo-move .demo-stage'), demoMove),
      timeline(aside.querySelector('#demo-range .demo-stage'), demoRange),
      timeline(aside.querySelector('#demo-rotate .demo-stage'), demoRotate),
    ];

    /** 패널이 실제로 보이는가 (접힘 · 서랍 닫힘 · 다른 도구 · 백그라운드 탭이면 아니다) */
    function isShown() {
      if (document.hidden || activeView !== 'work') return false;
      return wide.matches ? !collapsed : drawer;
    }
    function sync() {
      // 지금 도구의 사용법만 보인다. 움직이는 예시는 편집에만 있다.
      aside.querySelectorAll('.guide-sec').forEach((sec) => { sec.hidden = sec.dataset.guide !== activeTab; });
      if (still.matches) {
        demos.forEach((d) => d.showLast());
        return;
      }
      const on = isShown() && activeTab === 'edit';
      demos.forEach((d) => (on ? d.play() : d.pause()));
    }

    function apply() {
      const isWide = wide.matches;
      if (isWide) drawer = false;
      layout.classList.toggle('guide-collapsed', isWide && collapsed);
      aside.classList.toggle('collapsed', isWide && collapsed);
      aside.classList.toggle('open', !isWide && drawer);
      backdrop.hidden = isWide || !drawer;
      foldBtn.textContent = isWide ? '접기' : '닫기';
      foldBtn.setAttribute('aria-expanded', String(isWide ? !collapsed : drawer));
      rail.setAttribute('aria-expanded', String(isWide && !collapsed));
      document.querySelectorAll('.guide-open').forEach((b) => b.setAttribute('aria-expanded', String(!isWide && drawer)));
      if (!isWide) aside.setAttribute('aria-hidden', String(!drawer)); else aside.removeAttribute('aria-hidden');
      sync();
    }

    function openDrawer() {
      lastFocus = document.activeElement;
      drawer = true;
      apply();
      foldBtn.focus();
    }
    function closeDrawer() {
      if (!drawer) return;
      drawer = false;
      apply();
      if (lastFocus && lastFocus.isConnected) lastFocus.focus();
    }

    document.querySelectorAll('.guide-open').forEach((b) => b.addEventListener('click', openDrawer));
    backdrop.addEventListener('click', closeDrawer);
    foldBtn.addEventListener('click', () => {
      if (wide.matches) {
        collapsed = true;
        saveCollapsed();
        apply();
        rail.focus();
      } else closeDrawer();
    });
    rail.addEventListener('click', () => {
      collapsed = false;
      saveCollapsed();
      apply();
      foldBtn.focus();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer && !wide.matches) {
        e.preventDefault();
        closeDrawer();
      }
    }, true);
    wide.addEventListener('change', apply);
    still.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);

    apply();
    guideSync = sync;
    return {
      sync,
      state: () => ({ wide: wide.matches, collapsed, drawer, playing: demos.map((d) => d.playing) }),
    };
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

  // 저장 단축키: Ctrl+S = 바로 저장, Ctrl+Shift+S = 설정하고 저장… (브라우저의 "페이지 저장"은 막는다)
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    if (activeView !== 'work' || isBusy() || document.querySelector('dialog[open]')) return;
    const withOpts = e.shiftKey;
    const run = {
      edit: () => Edit.shortcutSave(withOpts),
      pdf2img: () => P2I.shortcutSave(withOpts),
      decorate: () => Decor.shortcutSave(withOpts),
      compress: () => Shrink.shortcutSave(withOpts),
      img2pdf: () => $('img-save').click(),
    }[activeTab];
    if (run) run();
    else toast('이 도구는 아래 버튼으로 저장해요.', '', 'info');
  });

  // 주소에 #도구 이름이 있으면 그 도구로 연다(예전 #lock, #number도).
  {
    const t = toolFromHash();
    if (t) openTool(t);
  }
  window.addEventListener('hashchange', () => {
    const t = toolFromHash();
    if (t && (t !== activeTab || activeView !== 'work')) openTool(t);
  });

  window.__pdfWorkshop = { version: 5, ready: true, guide: Guide.state, compress: Shrink.state, worker: Squeeze.inWorker, lastStage: () => errCtx.stage };
})();
