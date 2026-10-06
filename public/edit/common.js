/* EDIT 공통 — PDF 작업실(/pdf)과 도장 만들기(/stamp)가 같이 쓴다. 파일 · 도장은 이 브라우저 밖으로 나가지 않는다.
 *   entering  Xschool 입장권(#t=…)으로 막 들어오는 중이면 통행증을 지금 사람 것으로 새로 받는다(입장권은 주소에서 바로 지운다)
 *   Who       이 브라우저를 쓰는 사람: 가명 표(쿠키 pdf_who) · 빌려 쓰는 PC인지(pdf_pc=shared)
 *   Stamps    서명 · 도장 보관(IndexedDB 'pdf-workshop'의 stamps, 선생님마다 따로)
 *             빌려 쓰는 PC에서 새로 만든 것은 IndexedDB에 쓰지 않고 이 탭에만(sessionStorage) — 탭을 닫으면 지워진다.
 *             도장 만들기에서 [PDF에 찍기]로 PDF 작업실에 넘어가도 같은 탭이라 그대로 보인다.
 *   pending   도장 만들기 → PDF 작업실 꾸미기로 넘길 도장 하나(이 탭에만)
 */
(function (root) {
  'use strict';

  // ── Xschool 입장권으로 막 들어오는 중 ──
  // 무엇보다 먼저: 입장권을 주소에서 지우고(도구 이름은 #이름 으로 남긴다), 통행증을 지금 사람 것으로 새로 받는다.
  // 실패해도 지금 통행증으로 계속 쓴다(조용히). 서버가 늦어도 6초 뒤에는 계속.
  const entering = (() => {
    const hash = String(location.hash || '');
    const m = hash.match(/^#t=([^&]+)/);
    if (!m) return Promise.resolve();
    const tm = hash.match(/&tool=([a-z0-9-]{1,20})(?:&|$)/);
    const pc = /&pc=shared(?:&|$)/.test(hash) ? 'shared' : 'mine';
    try { history.replaceState(null, '', location.pathname + location.search + (tm ? `#${tm[1]}` : '')); } catch { /* 못 바꿔도 계속 */ }
    let ticket = m[1];
    try { ticket = decodeURIComponent(ticket); } catch { /* 그대로 */ }
    try {
      const sent = fetch('/api/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ t: ticket, pc }) }).then(() => {}, () => {});
      return Promise.race([sent, new Promise((r) => setTimeout(r, 6000))]);
    } catch { return Promise.resolve(); /* fetch가 없는 브라우저 */ }
  })();

  // ── IndexedDB 'pdf-workshop' (stamps: 서명 · 도장, session: PDF 작업 이어하기) ──
  let workshopDb = null;
  function openDb() {
    if (!workshopDb) {
      workshopDb = new Promise((resolve) => {
        try {
          const req = indexedDB.open('pdf-workshop', 2);
          req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains('stamps')) d.createObjectStore('stamps', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('session')) d.createObjectStore('session', { keyPath: 'id' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    return workshopDb;
  }
  /** store에 fn을 돌린다. 저장소를 못 쓰면 null */
  async function dbTx(store, mode, fn) {
    const d = await openDb();
    if (!d) return null;
    return new Promise((resolve) => {
      try {
        const t = d.transaction(store, mode);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => resolve(r ? r.result : null);
        t.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  // ── 이 브라우저를 쓰는 사람 ──
  // Xschool에서 막 들어오는 중이면(entering) 쿠키가 새 사람 것으로 바뀐 뒤에 읽는다.
  // 표가 없으면(점검 · 표가 생기기 전 통행증) 예전처럼 이 브라우저를 한 사람이 쓴다고 본다.
  const Who = (() => {
    let cached = null;
    const cookie = (name) => {
      try {
        const hit = String(document.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name}=`));
        return hit ? hit.slice(name.length + 1) : '';
      } catch { return ''; }
    };
    const read = () => {
      const who = cookie('pdf_who');
      return { owner: /^[0-9a-f]{16}$/.test(who) ? who : '', shared: cookie('pdf_pc') === 'shared' };
    };
    return {
      ready: async () => { if (!cached) { await entering; cached = read(); } return cached; },
      now: () => cached || read(),
    };
  })();

  // ── 이 탭에만 두는 것(sessionStorage): 빌려 쓰는 PC의 도장 · 넘길 도장 ──
  const session = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); return true; } catch { return false; } },
    del(key) { try { sessionStorage.removeItem(key); } catch { /* 없음 */ } },
  };
  const toB64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (text) => {
    const s = atob(String(text || ''));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
    return out;
  };

  /** 밝은(흰) 부분을 투명하게. 스캔한 도장용 */
  async function whiteToAlpha(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = document.createElement('canvas');
    c.width = Math.max(1, bmp.width);
    c.height = Math.max(1, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum >= 235) d[i + 3] = 0;
      else if (lum > 195) d[i + 3] = Math.round(d[i + 3] * ((235 - lum) / 40));
    }
    ctx.putImageData(img, 0, 0);
    return new Promise((resolve, reject) => c.toBlob(async (b) => {
      if (!b) { reject(new Error('png')); return; }
      resolve(new Uint8Array(await b.arrayBuffer()));
    }, 'image/png'));
  }

  // ── 서명 · 도장 보관 ──
  // 선생님마다 따로(owner). 빌려 쓰는 PC에서 새로 만든 것은 IndexedDB에 쓰지 않고 이 탭에만(temp).
  // 표가 생기기 전에 보관한 것(owner 없음)은 누구 것인지 몰라 숨기고, 이 PC 주인이 [내 것으로] · [지우기]를 고른다.
  const Stamps = (() => {
    let items = null;
    let loading = null;
    let me = { owner: '', shared: false };
    let legacy = [];
    const listeners = new Set();
    const tx = (mode, fn) => dbTx('stamps', mode, fn);
    const toItem = (r) => ({ ...r, bytes: new Uint8Array(r.bytes) });
    const row = (it) => ({ ...it, bytes: it.bytes.buffer.slice(0), processed: undefined, url: undefined, temp: undefined });
    const tempKey = () => `edit.stamps.temp.${me.owner || 'none'}`;
    function readTemp() {
      try {
        const list = JSON.parse(session.get(tempKey()) || '[]');
        return Array.isArray(list) ? list.map((r) => ({ ...r, bytes: fromB64(r.bytes), temp: true })) : [];
      } catch { return []; }
    }
    function writeTemp() {
      const list = (items || []).filter((x) => x.temp).map((it) => ({ ...it, bytes: toB64(it.bytes), processed: undefined, url: undefined }));
      // 탭 저장소가 꽉 차면 이번 화면에만 남는다(창을 닫으면 어차피 지워진다)
      if (list.length) session.set(tempKey(), JSON.stringify(list)); else session.del(tempKey());
    }
    async function load() {
      me = await Who.ready();
      const rows = (await tx('readonly', (st) => st.getAll())) || [];
      legacy = me.owner ? rows.filter((r) => !r.owner) : [];
      items = rows.filter((r) => (r.owner || '') === me.owner).map(toItem);
      if (me.shared) items = items.concat(readTemp());
      items.sort((a, b) => a.created - b.created);
      return items;
    }
    async function list() {
      if (items) return items;
      if (!loading) loading = load();
      return loading;
    }
    const notify = () => listeners.forEach((f) => f());
    async function add(item) {
      await list();
      const it = { id: `st${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, created: Date.now(), clearWhite: false, ...item, owner: me.owner };
      if (me.shared) it.temp = true;
      items.push(it);
      if (it.temp) writeTemp(); else await tx('readwrite', (st) => st.put(row(it)));
      notify();
      return it;
    }
    async function update(it) {
      delete it.processed;
      if (it.temp) writeTemp(); else await tx('readwrite', (st) => st.put(row(it)));
      if (it.url) { URL.revokeObjectURL(it.url); delete it.url; }
      notify();
    }
    async function remove(id) {
      await list();
      const it = items.find((x) => x.id === id);
      if (it && it.url) URL.revokeObjectURL(it.url);
      items = items.filter((x) => x.id !== id);
      if (it && it.temp) writeTemp(); else await tx('readwrite', (st) => st.delete(id));
      notify();
    }
    /** 숨겨 둔 예전 보관을 지금 선생님 것으로(이 PC 주인만: 빌려 쓰는 PC에서는 부르지 않는다) */
    async function claimLegacy() {
      await list();
      if (me.shared || !me.owner) return 0;
      const n = legacy.length;
      for (const r of legacy) {
        const it = { ...toItem(r), owner: me.owner };
        await tx('readwrite', (st) => st.put(row(it)));
        items.push(it);
      }
      items.sort((a, b) => a.created - b.created);
      legacy = [];
      notify();
      return n;
    }
    async function dropLegacy() {
      await list();
      if (me.shared) return 0;
      const n = legacy.length;
      for (const r of legacy) await tx('readwrite', (st) => st.delete(r.id));
      legacy = [];
      notify();
      return n;
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
    /** 이 브라우저에 보관한 서명 · 도장을 모두 지운다(설정 → 모두 지우기: 다른 선생님 것까지) */
    async function clearAll() {
      (items || []).forEach((it) => it.url && URL.revokeObjectURL(it.url));
      items = [];
      legacy = [];
      writeTemp();
      await tx('readwrite', (st) => st.clear());
      notify();
    }
    return {
      list, add, update, remove, pngOf, urlOf, byId, clearAll, claimLegacy, dropLegacy,
      onChange: (f) => listeners.add(f),
      shared: () => me.shared,
      legacyCount: () => legacy.length,
      state: async () => { await list(); return { owner: me.owner ? 'set' : '', shared: me.shared, count: items.length, temp: items.filter((x) => x.temp).length, legacy: legacy.length }; },
    };
  })();

  // ── 도장 만들기 → PDF 작업실 꾸미기로 넘길 도장 하나 ──
  const PENDING_KEY = 'edit.useStamp';
  const setPendingStamp = (id) => session.set(PENDING_KEY, String(id || ''));
  function takePendingStamp() {
    const id = session.get(PENDING_KEY);
    session.del(PENDING_KEY);
    return /^st[0-9a-z]{4,24}$/.test(String(id || '')) || /^[A-Za-z0-9_-]{1,64}$/.test(String(id || '')) ? id : '';
  }

  root.EditCommon = { entering, dbTx, Who, Stamps, setPendingStamp, takePendingStamp };
})(self);
