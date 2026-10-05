/*
 * 도장 만들기 핵심 (화면 없이 계산만).
 * 브라우저에서는 전역 StampCore로, 검증 스크립트(node)에서는 require로 같은 코드를 쓴다.
 * 도장 한 개 = 200 높이 좌표계(타원은 폭 150, 나머지 200) 위의 도형 · 글자 목록(design) → 캔버스에 그린다(render).
 * 이름은 이 화면 안에서만 그린다(서버로 보내는 코드 없음).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StampCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 글꼴: 모두 Fontsource(SIL OFL 1.1), 우리 서버에서 받는다(scripts/vendor-stamp-fonts.mjs)
  const FONTS = [
    { id: 'serif', g: '단정', name: '굵은 명조', w: 900, hanja: true },
    { id: 'nanum', g: '단정', name: '나눔명조', w: 800, boost: 1 }, // Fontsource 판에는 한자가 없다
    { id: 'gothic', g: '단정', name: '굵은 고딕', w: 900, hanja: true },
    { id: 'gowun', g: '단정', name: '고운바탕', w: 700, boost: 2 },
    { id: 'hahm', g: '단정', name: '함렛', w: 900 },
    { id: 'song', g: '옛 활자 · 붓', name: '옛 활자', w: 400, boost: 2 },
    { id: 'yeon', g: '옛 활자 · 붓', name: '연성', w: 400 },
    { id: 'brush', g: '옛 활자 · 붓', name: '붓글씨', w: 400 },
    { id: 'kai', g: '옛 활자 · 붓', name: '해서(한자)', w: 700, hanja: true, hanjaOnly: true },
    { id: 'black', g: '굵은 새김', name: '검은 새김', w: 400, heavy: true },
    { id: 'gasoek', g: '굵은 새김', name: '가석', w: 400, heavy: true },
    { id: 'dohyeon', g: '굵은 새김', name: '도현', w: 400, heavy: true },
    { id: 'gugi', g: '개성', name: '구기', w: 400 },
    { id: 'dokdo', g: '개성', name: '동해 독도', w: 400, boost: 2 },
    { id: 'bagel', g: '개성', name: '베이글', w: 400, heavy: true },
    { id: 'diph', g: '개성', name: '디필레이아', w: 400, boost: 4 },
    { id: 'grand', g: '개성', name: '그랜디플로라', w: 400, boost: 4 },
    { id: 'moirai', g: '개성', name: '모이라이', w: 400, boost: 2 },
  ];
  const family = (id) => `stamp-${id}`;
  /** 캔버스 글꼴 문자열: 고른 글꼴 → 없는 글자는 굵은 명조 → 브라우저 명조 */
  const fontCss = (f) => `${f.w} 100px "${family(f.id)}", "${family('serif')}", serif`;

  const SHAPES = [{ id: 'circle', name: '원형' }, { id: 'oval', name: '타원' }, { id: 'square', name: '네모' }, { id: 'round', name: '둥근 네모' }];
  const BORDERS = [{ id: 'single', name: '한 줄' }, { id: 'double', name: '두 줄' }];
  const STYLES = [{ id: 'yang', name: '양각' }, { id: 'eum', name: '음각(낙관)' }];
  const WEIGHTS = [{ id: 0, name: '보통' }, { id: 1, name: '굵게' }, { id: 2, name: '아주 굵게' }];
  const SPACES = [{ id: -1, name: '좁게' }, { id: 0, name: '보통' }, { id: 1, name: '넓게' }];
  const SIZES = [{ id: 10, name: '10' }, { id: 12, name: '12' }, { id: 15, name: '15' }, { id: 18, name: '18' }, { id: 21, name: '21' }];
  const BWS = [{ id: 2.5, name: '가늘게' }, { id: 'auto', name: '보통' }, { id: 5, name: '굵게' }];
  const DPIS = [{ id: 300, name: '300dpi' }, { id: 600, name: '600dpi' }];
  const FINISH = [{ id: 'clean', name: '반듯하게' }, { id: 'stamp', name: '찍은 느낌' }];
  const INKS = [{ id: 'red', name: '인주 빨강', c: '#c3161d' }, { id: 'ver', name: '주홍', c: '#d9461b' }, { id: 'black', name: '검정', c: '#24211d' }, { id: 'blue', name: '파랑', c: '#1f3d9e' }];
  // 추천 모음: [모양, 새김, 글꼴, 테두리]
  const PICKS = [
    ['circle', 'yang', 'serif', 'single'], ['square', 'yang', 'black', 'single'], ['oval', 'yang', 'song', 'single'], ['round', 'yang', 'hahm', 'double'],
    ['circle', 'yang', 'gasoek', 'double'], ['square', 'yang', 'nanum', 'double'], ['oval', 'yang', 'yeon', 'double'], ['circle', 'yang', 'diph', 'single'],
    ['square', 'eum', 'serif', 'single'], ['round', 'yang', 'gugi', 'single'], ['circle', 'eum', 'black', 'double'], ['square', 'yang', 'brush', 'single'],
  ];
  // 이름에 자주 쓰는 한자 (목록에 없으면 화면에서 [한자] 키로 직접 넣는다)
  const HJ = {
    '김': [['金', '쇠 금 · 성 김']], '이': [['李', '오얏 리'], ['伊', '저 이']], '리': [['李', '오얏 리']], '박': [['朴', '순박할 박']],
    '최': [['崔', '높을 최']], '정': [['鄭', '나라 정'], ['丁', '고무래 정'], ['正', '바를 정'], ['貞', '곧을 정'], ['晶', '맑을 정']],
    '강': [['姜', '성 강'], ['康', '편안 강'], ['江', '강 강']], '조': [['趙', '나라 조'], ['曺', '성 조']], '윤': [['尹', '성 윤'], ['允', '맏 윤'], ['潤', '윤택할 윤']],
    '장': [['張', '베풀 장'], ['章', '글 장']], '임': [['林', '수풀 림'], ['任', '맡길 임']], '한': [['韓', '나라 한'], ['漢', '한수 한']], '오': [['吳', '성 오']],
    '서': [['徐', '천천할 서'], ['瑞', '상서 서'], ['書', '글 서']], '신': [['申', '납 신'], ['辛', '매울 신'], ['信', '믿을 신']], '권': [['權', '권세 권']],
    '황': [['黃', '누를 황']], '안': [['安', '편안 안']], '송': [['宋', '송나라 송'], ['松', '소나무 송']], '류': [['柳', '버들 류'], ['劉', '성 류']],
    '유': [['柳', '버들 류'], ['兪', '성 유'], ['裕', '넉넉할 유']], '전': [['全', '온전 전'], ['田', '밭 전']], '홍': [['洪', '넓을 홍'], ['弘', '클 홍']],
    '고': [['高', '높을 고']], '문': [['文', '글월 문']], '양': [['梁', '들보 량'], ['楊', '버들 양']], '손': [['孫', '손자 손']], '배': [['裵', '성 배']],
    '백': [['白', '흰 백']], '허': [['許', '허락할 허']], '남': [['南', '남녘 남']], '심': [['沈', '성 심']], '노': [['盧', '성 노']],
    '하': [['河', '물 하'], ['夏', '여름 하'], ['荷', '연꽃 하']], '곽': [['郭', '성곽 곽']], '성': [['成', '이룰 성'], ['聖', '성인 성'], ['星', '별 성']],
    '차': [['車', '수레 차']], '주': [['朱', '붉을 주'], ['周', '두루 주'], ['珠', '구슬 주']], '우': [['禹', '성 우'], ['宇', '집 우'], ['祐', '복 우']],
    '구': [['具', '갖출 구']], '민': [['敏', '민첩할 민'], ['民', '백성 민']], '수': [['秀', '빼어날 수'], ['洙', '물가 수'], ['壽', '목숨 수'], ['守', '지킬 수']],
    '지': [['智', '슬기 지'], ['志', '뜻 지'], ['知', '알 지'], ['芝', '지초 지']], '영': [['英', '꽃부리 영'], ['永', '길 영'], ['榮', '영화 영'], ['映', '비칠 영']],
    '현': [['賢', '어질 현'], ['炫', '밝을 현'], ['玄', '검을 현'], ['鉉', '솥귀 현']], '준': [['俊', '준걸 준'], ['準', '준할 준'], ['峻', '높을 준']],
    '진': [['眞', '참 진'], ['鎭', '진압할 진'], ['珍', '보배 진']], '호': [['浩', '넓을 호'], ['虎', '범 호'], ['昊', '하늘 호']],
    '은': [['恩', '은혜 은'], ['銀', '은 은']], '희': [['喜', '기쁠 희'], ['熙', '빛날 희'], ['姬', '계집 희']], '연': [['姸', '고울 연'], ['延', '늘일 연'], ['然', '그럴 연']],
    '동': [['東', '동녘 동']], '철': [['哲', '밝을 철'], ['鐵', '쇠 철']], '상': [['相', '서로 상'], ['祥', '상서 상'], ['尙', '오히려 상']],
    '혜': [['惠', '은혜 혜'], ['慧', '슬기로울 혜']], '원': [['元', '으뜸 원'], ['源', '근원 원'], ['媛', '여자 원']], '경': [['京', '서울 경'], ['慶', '경사 경'], ['景', '볕 경'], ['敬', '공경 경']],
    '미': [['美', '아름다울 미']], '재': [['在', '있을 재'], ['載', '실을 재'], ['宰', '재상 재'], ['才', '재주 재']], '석': [['石', '돌 석'], ['錫', '주석 석'], ['碩', '클 석']],
    '태': [['泰', '클 태'], ['太', '클 태']], '훈': [['勳', '공 훈'], ['薰', '향풀 훈']], '승': [['承', '이을 승'], ['昇', '오를 승'], ['勝', '이길 승']],
    '용': [['容', '얼굴 용'], ['勇', '날랠 용'], ['龍', '용 룡']], '아': [['雅', '맑을 아'], ['娥', '예쁠 아']], '예': [['藝', '재주 예']], '소': [['素', '본디 소'], ['昭', '밝을 소']],
    '선': [['善', '착할 선'], ['仙', '신선 선'], ['宣', '베풀 선']], '명': [['明', '밝을 명']], '규': [['奎', '별 규'], ['圭', '홀 규']], '근': [['根', '뿌리 근'], ['槿', '무궁화 근']],
    '기': [['基', '터 기'], ['起', '일어날 기'], ['琪', '옥 기']], '혁': [['赫', '빛날 혁']], '빈': [['彬', '빛날 빈']], '완': [['完', '완전할 완']],
    '찬': [['燦', '빛날 찬'], ['贊', '도울 찬']], '도': [['道', '길 도']], '건': [['建', '세울 건'], ['健', '굳셀 건']], '형': [['亨', '형통할 형'], ['炯', '빛날 형']],
    '환': [['煥', '빛날 환']], '일': [['一', '한 일'], ['日', '날 일']], '인': [['仁', '어질 인'], ['寅', '범 인']], '보': [['寶', '보배 보'], ['普', '넓을 보']],
    '나': [['那', '어찌 나']], '라': [['羅', '벌일 라']], '린': [['麟', '기린 린']], '범': [['範', '법 범']], '율': [['律', '법칙 률']],
  };

  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const dotDate = (d) => `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  /** 처음 상태 (이름 · 부서는 비워 둔다: 예시는 화면의 placeholder로만) */
  function defaultState(today) {
    return {
      kind: 'name', name: '', mode: 'hangul', picks: {}, seal: false, sq3: 'in',
      shape: 'circle', style: 'yang', font: 'serif', border: 'single', weight: 0, space: 0,
      ink: 'red', inkHex: '#a0522d', size: 15, bwPct: 'auto', dpi: 600,
      finish: 'clean', rough: 0.4, tilt: 1, restamp: 0,
      dTop: '', dBottom: '', dDate: dotDate(today || new Date()),
    };
  }
  // 보관 · 불러오기에 쓰는 값만 (화면 상태는 빼고)
  const SAVE_KEYS = ['kind', 'name', 'mode', 'picks', 'seal', 'sq3', 'shape', 'style', 'font', 'border', 'weight', 'space', 'ink', 'inkHex', 'size', 'bwPct', 'dpi', 'finish', 'rough', 'tilt', 'restamp', 'dTop', 'dBottom', 'dDate'];
  function pickState(st) {
    const o = {};
    for (const k of SAVE_KEYS) o[k] = k === 'picks' ? { ...(st.picks || {}) } : st[k];
    return o;
  }
  /** 보관한 값을 믿지 않고 하나씩 확인해 되살린다(모르는 값은 처음 값으로) */
  function restoreState(saved, today) {
    const st = defaultState(today);
    if (!saved || typeof saved !== 'object') return st;
    const oneOf = (list, v) => list.some((x) => x.id === v);
    const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
    if (saved.kind === 'name' || saved.kind === 'date') st.kind = saved.kind;
    if (saved.mode === 'hangul' || saved.mode === 'hanja') st.mode = saved.mode;
    if (str(saved.name, 12) != null) st.name = str(saved.name, 12);
    if (saved.picks && typeof saved.picks === 'object') {
      for (const [k, v] of Object.entries(saved.picks)) if (/^\d[가-힣]$/.test(k) && (v === null || (typeof v === 'string' && v.length <= 2))) st.picks[k] = v;
    }
    st.seal = saved.seal === true;
    if (saved.sq3 === 'in' || saved.sq3 === 'long') st.sq3 = saved.sq3;
    for (const [k, list] of [['shape', SHAPES], ['style', STYLES], ['border', BORDERS], ['finish', FINISH]]) if (oneOf(list, saved[k])) st[k] = saved[k];
    if (FONTS.some((f) => f.id === saved.font)) st.font = saved.font;
    if (oneOf(INKS, saved.ink) || saved.ink === 'custom') st.ink = saved.ink;
    if (typeof saved.inkHex === 'string' && /^#[0-9a-f]{6}$/i.test(saved.inkHex)) st.inkHex = saved.inkHex;
    const pairs = [['weight', 0, 5], ['space', -3, 5], ['size', 5, 60], ['dpi', 150, 1200], ['rough', 0, 1], ['tilt', 0, 3], ['restamp', 0, 1e6]];
    for (const [k, lo, hi] of pairs) { const v = num(saved[k], lo, hi); if (v != null) st[k] = v; }
    st.bwPct = saved.bwPct === 'auto' ? 'auto' : num(saved.bwPct, 1, 8) ?? 'auto';
    for (const k of ['dTop', 'dBottom', 'dDate']) if (str(saved[k], 12) != null) st[k] = str(saved[k], 12);
    return st;
  }

  const fontById = (id) => FONTS.find((f) => f.id === id) || FONTS[0];
  const nameOf = (list, id) => (list.find((x) => x.id === id) || {}).name || '';
  /** 지금 종류 · 글자에 맞는 글꼴 */
  const fontsFor = (st) => FONTS.filter((f) => (st.mode === 'hangul' || st.kind === 'date' ? !f.hanjaOnly : f.hanja));
  const inkOf = (st) => (st.ink === 'custom' ? st.inkHex : (INKS.find((x) => x.id === st.ink) || INKS[0]).c);
  /** 도장에 새길 한글 음절(1~4자) */
  const syllables = (st) => Array.from(String(st.name || '').replace(/[^가-힣]/g, '')).slice(0, 4);
  /** 실제로 새기는 글자(한자 고르기 · '인' 붙이기 반영) */
  function glyphs(st) {
    const out = syllables(st).map((c, i) => {
      if (st.mode !== 'hanja') return c;
      let p = st.picks[i + c];
      if (p === undefined) p = HJ[c] ? HJ[c][0][0] : null;
      return p || c;
    });
    if (st.seal && out.length > 0 && out.length < 4) out.push(st.mode === 'hanja' ? '印' : '인');
    return out;
  }
  /** 네모 · 둥근 네모에서 세 글자는 '인'을 붙여 네 칸(또는 성을 길게) */
  function cellGlyphs(st, shape) {
    const gl = glyphs(st).slice();
    const boxy = shape === 'square' || shape === 'round';
    let long = false;
    if (boxy && gl.length === 3 && !st.seal) {
      if (st.sq3 === 'in') gl.push(st.mode === 'hanja' ? '印' : '인');
      else long = true;
    }
    return { gl, long };
  }
  /** 도장 이름표(파일 이름 · 보관 이름) */
  function labelOf(st) {
    if (st.kind === 'date') return [st.dTop, st.dDate, st.dBottom].filter(Boolean).join(' ').trim() || '날짜 도장';
    return glyphs(st).join('') || '도장';
  }
  const describe = (o) => `${nameOf(SHAPES, o.shape)} · ${nameOf(BORDERS, o.border)} · ${nameOf(STYLES, o.style).replace(/\(.*\)/, '')} · ${fontById(o.font).name}`;

  // ── 모양 계산 ────────────────────────────────────────────────
  function rng(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Math.abs(h) || 7;
  }
  // 모양마다 글자가 들어가는 안쪽 칸
  function innerBox(shape, shrink) {
    const b = shape === 'oval' ? { x: 39, y: 25, w: 72, h: 150 } : shape === 'circle' ? { x: 39, y: 39, w: 122, h: 122 } : { x: 26, y: 26, w: 148, h: 148 };
    return { x: b.x + shrink, y: b.y + shrink, w: b.w - 2 * shrink, h: b.h - 2 * shrink };
  }
  /** 글자 수에 따라 칸 나누기. 네 칸은 오른쪽 위부터 세로로(도장 읽는 순서) */
  function cellsFor(shape, n, long, shrink, g) {
    const I = innerBox(shape, shrink);
    const vstack = (b, k) => {
      const hh = (b.h - g * (k - 1)) / k;
      const a = [];
      for (let i = 0; i < k; i++) a.push({ x: b.x, y: b.y + i * (hh + g), w: b.w, h: hh });
      return a;
    };
    if (shape === 'oval') return vstack(I, n);
    if (n === 1) return [I];
    if (n === 2) return shape === 'circle' ? vstack({ x: I.x + 11, y: I.y - 5, w: I.w - 22, h: I.h + 10 }, 2) : vstack(I, 2);
    const cw = (I.w - g) / 2;
    const ch = (I.h - g) / 2;
    const rx = I.x + cw + g;
    if (n === 3 && shape === 'circle') return [{ x: 100 - cw / 2, y: I.y, w: cw, h: ch }, { x: I.x, y: I.y + ch + g, w: cw, h: ch }, { x: rx, y: I.y + ch + g, w: cw, h: ch }];
    if (n === 3 && long) return [{ x: rx, y: I.y, w: cw, h: I.h }, { x: I.x, y: I.y, w: cw, h: ch }, { x: I.x, y: I.y + ch + g, w: cw, h: ch }];
    return [{ x: rx, y: I.y, w: cw, h: ch }, { x: rx, y: I.y + ch + g, w: cw, h: ch }, { x: I.x, y: I.y, w: cw, h: ch }, { x: I.x, y: I.y + ch + g, w: cw, h: ch }];
  }
  /** 테두리 도형 (inset만큼 안으로) */
  function shapeAt(shape, inset) {
    if (shape === 'circle') return { t: 'circle', cx: 100, cy: 100, r: 96 - inset };
    if (shape === 'oval') return { t: 'ellipse', cx: 75, cy: 100, rx: 71 - inset, ry: 96 - inset };
    return { t: 'rect', x: 4 + inset, y: 4 + inset, w: 192 - 2 * inset, h: 192 - 2 * inset, rx: shape === 'square' ? 3 : Math.max(8, 30 - inset * 0.6) };
  }

  /**
   * 도장 하나의 그림 목록.
   * st: 상태, o: {shape, style, font, border, key}, measure(font, 글자) → {w, h, cx, cy} (100px 기준 글자 상자)
   * paper: true면 종이색(= 투명하게 파냄, 음각)
   */
  function design(st, o, measure) {
    const f = fontById(o.font);
    const dbl = o.border === 'double';
    const bw = st.bwPct === 'auto' ? (f.w >= 800 || f.heavy ? 7.5 : 6) + st.weight * 0.9 : st.bwPct * 2;
    const outer = 2 + bw / 2;
    const bwi = Math.max(2, bw * 0.42);
    const innerIn = outer + bw / 2 + 3.2 + bwi / 2;
    const items = [];
    if (o.style === 'yang') {
      items.push({ ...shapeAt(o.shape, outer), stroke: bw });
      if (dbl) items.push({ ...shapeAt(o.shape, innerIn), stroke: bwi });
    } else {
      items.push({ ...shapeAt(o.shape, 2), fill: true });
      if (dbl) items.push({ ...shapeAt(o.shape, 2 + bw * 0.75), stroke: bwi, paper: true });
    }
    const paper = o.style !== 'yang';
    const sw = st.weight * 3 + (f.boost || 0);
    const W = o.shape === 'oval' ? 150 : 200;
    const text = (s, tx, ty, sx, sy, swk) => ({ t: 'text', s, tx, ty, sx, sy, font: f.id, sw: swk, paper });
    function fitLine(s, box, maxStretch, swk) {
      const m = measure(f, s);
      let sy = box.h / m.h;
      const sx = Math.min(box.w / m.w, sy * maxStretch);
      if (sx < sy * 0.55) sy = sx / 0.55;
      return text(s, box.x + box.w / 2 - m.cx * sx, box.y + box.h / 2 - m.cy * sy, sx, sy, swk);
    }
    let label;
    if (st.kind === 'date') {
      const R = 96 - outer - bw / 2 - (dbl ? bw / 2 + 3.2 + bwi : 0) - 3;
      const lw = Math.max(1.6, bw * 0.45);
      const y1 = 100 - R * 0.27;
      const y2 = 100 + R * 0.27;
      for (const y of [y1, y2]) {
        const c = Math.sqrt(Math.max(0, R * R - (y - 100) * (y - 100)));
        items.push({ t: 'line', x1: 100 - c, y1: y, x2: 100 + c, y2: y, stroke: lw, paper });
      }
      const band = (top, bot, s) => {
        const mid = (top + bot) / 2;
        const far = Math.max(Math.abs(top - 100), Math.abs(bot - 100));
        const c = Math.sqrt(Math.max(0, R * R - ((far + Math.abs(mid - 100)) / 2) ** 2)) * 0.86;
        return fitLine(s, { x: 100 - c, y: top, w: 2 * c, h: bot - top }, 1.25, sw * 0.7);
      };
      const gap = 5;
      items.push(band(100 - R + 14, y1 - gap, st.dTop || ' '));
      items.push(band(y1 + gap + 1, y2 - gap - 1, st.dDate || ' '));
      items.push(band(y2 + gap, 100 + R - 14, st.dBottom || ' '));
      label = labelOf(st);
    } else {
      const { gl, long } = cellGlyphs(st, o.shape);
      const g = 6 + st.space * 4;
      const shrink = (dbl ? bw / 2 + 4 : 0) - st.space * 2;
      const cells = cellsFor(o.shape, Math.max(1, gl.length), long, shrink, g);
      const padc = 3;
      const ms = gl.map((ch) => measure(f, ch));
      let sx = Infinity;
      let sy = Infinity;
      ms.forEach((m, i) => {
        const c = cells[i];
        if (!c) return;
        sx = Math.min(sx, (c.w - padc * 2) / m.w);
        if (!(long && i === 0)) sy = Math.min(sy, (c.h - padc * 2) / m.h);
      });
      if (!Number.isFinite(sy)) sy = sx;
      const q = sx / sy;
      if (q > 1.3) sx = sy * 1.3;
      else if (q < 0.77) sy = sx / 0.77;
      gl.forEach((ch, i) => {
        const c = cells[i];
        const m = ms[i];
        if (!c) return;
        const gsy = long && i === 0 ? Math.min((c.h - padc * 2) / m.h, sx * 1.9) : sy;
        items.push(text(ch, c.x + c.w / 2 - m.cx * sx, c.y + c.h / 2 - m.cy * gsy, sx, gsy, sw));
      });
      label = gl.join('');
    }
    let tilt = 0;
    let texture = null;
    if (st.finish === 'stamp') {
      const rnd = rng(hash(`${o.key || ''}|${st.restamp}`));
      tilt = Math.round((rnd() - 0.5) * 2 * st.tilt * 100) / 100;
      texture = { seed: Math.floor(rnd() * 2147483000) + 1, r: st.rough };
    }
    return { W, H: 200, items, tilt, texture, label, ink: inkOf(st) };
  }

  // ── 그리기 (캔버스) ──────────────────────────────────────────
  function pathOf(ctx, it) {
    ctx.beginPath();
    if (it.t === 'circle') ctx.arc(it.cx, it.cy, Math.max(0, it.r), 0, Math.PI * 2);
    else if (it.t === 'ellipse') ctx.ellipse(it.cx, it.cy, Math.max(0, it.rx), Math.max(0, it.ry), 0, 0, Math.PI * 2);
    else if (it.t === 'line') { ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); }
    else if (it.t === 'rect') {
      const r = Math.max(0, Math.min(it.rx || 0, it.w / 2, it.h / 2));
      const { x, y, w, h } = it;
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.arcTo(x + w, y, x + w, y + r, r);
      ctx.lineTo(x + w, y + h - r);
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.closePath();
    }
  }
  function drawItem(ctx, it) {
    ctx.save();
    if (it.t === 'text') {
      ctx.translate(it.tx, it.ty);
      ctx.scale(it.sx, it.sy);
      ctx.font = fontCss(fontById(it.font));
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'start';
      if (it.sw > 0) { ctx.lineWidth = it.sw; ctx.lineJoin = 'round'; ctx.strokeText(it.s, 0, 0); }
      ctx.fillText(it.s, 0, 0);
    } else {
      pathOf(ctx, it);
      if (it.fill) ctx.fill();
      if (it.stroke) { ctx.lineWidth = it.stroke; ctx.stroke(); }
    }
    ctx.restore();
  }
  /** 캔버스(폭 W*k, 높이 200*k)에 도장을 그린다. 음각의 흰 부분은 투명하게 파낸다. */
  function render(ctx, d, k) {
    ctx.save();
    ctx.scale(k, k);
    if (d.tilt) {
      ctx.translate(d.W / 2, d.H / 2);
      ctx.rotate((d.tilt * Math.PI) / 180);
      ctx.translate(-d.W / 2, -d.H / 2);
    }
    ctx.fillStyle = d.ink;
    ctx.strokeStyle = d.ink;
    ctx.globalCompositeOperation = 'source-over';
    for (const it of d.items) if (!it.paper) drawItem(ctx, it);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    for (const it of d.items) if (it.paper) drawItem(ctx, it);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    if (d.texture) {
      const w = ctx.canvas.width;
      const h = ctx.canvas.height;
      const img = ctx.getImageData(0, 0, w, h);
      inkTexture(img.data, w, h, k, d.texture);
      ctx.putImageData(img, 0, 0);
    }
  }

  // 찍은 느낌: 큰 얼룩(인주가 덜 묻은 곳) × 작은 티(종이 결). 도장 좌표(200 높이) 기준이라 크기와 상관없이 같은 모양.
  function valueNoise(seed, cell) {
    const r = rng(seed);
    const N = 64;
    const grid = new Float32Array(N * N);
    for (let i = 0; i < grid.length; i++) grid[i] = r();
    const sm = (t) => t * t * (3 - 2 * t);
    return (x, y) => {
      const gx = x / cell;
      const gy = y / cell;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = sm(gx - x0);
      const ty = sm(gy - y0);
      const at = (i, j) => grid[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
      return a + (b - a) * ty;
    };
  }
  function inkTexture(data, w, h, k, tex) {
    const r = Math.max(0, Math.min(1, tex.r));
    if (!r) return;
    const blot1 = valueNoise(tex.seed, 25);
    const blot2 = valueNoise(tex.seed + 17, 12);
    const grain = valueNoise(tex.seed + 31, 1.1);
    const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    for (let py = 0; py < h; py++) {
      const y = (py + 0.5) / k;
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4 + 3;
        if (!data[i]) continue;
        const x = (px + 0.5) / k;
        const n1 = 0.5 + ((blot1(x, y) + 0.5 * blot2(x, y)) / 1.5 - 0.5) * 0.9;
        const n2 = 0.5 + (grain(x, y) - 0.5) * 0.75;
        const m1 = clamp(1 + 0.55 * r - 1.6 * r * n1);
        const m2 = clamp(1 - 1.9 * r + (6 * r + 0.01) * n2);
        data[i] = Math.round(data[i] * m1 * m2);
      }
    }
  }

  // ── 글꼴 조각 (public/stamp/fonts.json) ──────────────────────
  /** "ac00-ac01,ac05" → [[0xac00,0xac01],[0xac05,0xac05]] */
  function parseRanges(s) {
    return String(s || '').split(',').filter(Boolean).map((p) => {
      const [a, b] = p.trim().split('-');
      const lo = parseInt(a, 16);
      return [lo, b ? parseInt(b, 16) : lo];
    });
  }
  /** FontFace로 등록할 목록: [{family, url, weight, range}] */
  function fontFaces(data, base) {
    const out = [];
    for (const f of FONTS) {
      const d = data.fonts[f.id];
      if (!d) continue;
      for (const [slice, k] of d.files) {
        out.push({
          family: family(f.id),
          url: `${base}/${d.dir}/${d.dir}-${slice}-${d.weight}-normal.woff2`,
          weight: String(d.weight),
          range: k >= 0 ? data.ranges[k].split(',').map((p) => `U+${p}`).join(',') : undefined,
        });
      }
    }
    return out;
  }
  /** 글꼴마다 글자가 있는지 (조각 범위로 판단, 브라우저에 묻지 않아도 됨) */
  function coverage(data) {
    const cache = {};
    const spans = (id) => {
      if (cache[id]) return cache[id];
      const d = data.fonts[id];
      const list = [];
      if (d) for (const [, k] of d.files) if (k >= 0) list.push(...parseRanges(data.ranges[k]));
      list.sort((a, b) => a[0] - b[0]);
      return (cache[id] = list);
    };
    return function has(id, text) {
      const list = spans(id);
      for (const ch of Array.from(String(text || ''))) {
        const c = ch.codePointAt(0);
        if (c <= 0x20) continue;
        let lo = 0;
        let hi = list.length - 1;
        let found = false;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (c < list[mid][0]) hi = mid - 1;
          else if (c > list[mid][1]) lo = mid + 1;
          else { found = true; break; }
        }
        if (!found) return false;
      }
      return true;
    };
  }

  // ── PNG에 실제 크기 적기 (pHYs: 1미터당 화소 수) ──────────────
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  /** PNG 바이트에 dpi를 적는다(이미 있으면 바꾼다). 한글 · 워드가 붙일 때 이 크기를 읽는다. */
  function pngWithDpi(png, dpi) {
    const u = png instanceof Uint8Array ? png : new Uint8Array(png);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (u.length < 33 || sig.some((b, i) => u[i] !== b)) throw new Error('PNG가 아니에요');
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
    dv.setUint32(8, ppm);
    dv.setUint32(12, ppm);
    chunk[16] = 1; // 단위: 미터
    dv.setUint32(17, crc32(chunk.subarray(4, 17)));
    // 기존 pHYs는 빼고, IHDR 바로 뒤에 넣는다
    const parts = [u.subarray(0, 8)];
    let p = 8;
    let inserted = false;
    const view = new DataView(u.buffer, u.byteOffset, u.byteLength);
    while (p + 8 <= u.length) {
      const len = view.getUint32(p);
      const type = String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
      const end = p + 12 + len;
      if (end > u.length) throw new Error('PNG가 잘렸어요');
      if (type !== 'pHYs') parts.push(u.subarray(p, end));
      if (type === 'IHDR' && !inserted) { parts.push(chunk); inserted = true; }
      p = end;
      if (type === 'IEND') break;
    }
    const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  }
  /** PNG의 dpi 읽기(검사용) */
  function pngDpi(png) {
    const u = png instanceof Uint8Array ? png : new Uint8Array(png);
    const view = new DataView(u.buffer, u.byteOffset, u.byteLength);
    let p = 8;
    while (p + 8 <= u.length) {
      const len = view.getUint32(p);
      const type = String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
      if (type === 'pHYs') return u[p + 16] === 1 ? Math.round(view.getUint32(p + 8) * 0.0254) : null;
      p += 12 + len;
    }
    return null;
  }
  /** 저장할 그림 크기: 높이 size mm를 dpi로 */
  function pixelSize(st, W) {
    const h = Math.max(32, Math.round((st.size / 25.4) * st.dpi));
    return { w: Math.round((W / 200) * h), h, wMm: (st.size * W) / 200, hMm: st.size };
  }
  /**
   * [한자 더 보기]: 이 음절의 한자(public/stamp/hanja.json — libhangul, 많이 쓰는 순)에서
   * 위에 이미 보인 것(skip)을 빼고, 뜻으로 찾기(query — 띄어쓰기 무시, 한자 그대로도 됨)
   */
  function moreHanja(data, syllable, skip = [], query = '') {
    const list = (data && data.syllables && data.syllables[syllable]) || [];
    const q = String(query || '').replace(/\s+/g, '');
    return list.filter(([c, m]) => !skip.includes(c) && (!q || c === q || String(m || '').replace(/\s+/g, '').includes(q)));
  }

  /** 파일 이름에 쓸 수 없는 글자 빼기 */
  const fileSafe = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || '도장';

  return {
    FONTS, SHAPES, BORDERS, STYLES, WEIGHTS, SPACES, SIZES, BWS, DPIS, FINISH, INKS, PICKS, HJ,
    family, fontCss, fontById, nameOf, fontsFor, inkOf, syllables, glyphs, cellGlyphs, labelOf, describe,
    defaultState, pickState, restoreState, dotDate,
    cellsFor, design, render, inkTexture,
    parseRanges, fontFaces, coverage,
    crc32, pngWithDpi, pngDpi, pixelSize, fileSafe, moreHanja,
  };
});
