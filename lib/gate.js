'use strict';

/*
 * Xschool 입장권 (도구 연결 규칙 v1). 의존성 없이 node:crypto만 쓴다.
 *
 * Xschool 도구함의 [열기]가 2분짜리 입장권을 주소 뒤 #t= 에 붙여 보낸다. 안내 화면이 그것을
 * POST /api/enter 로 보내면 여기서 확인하고, 8시간짜리 통행증 쿠키(pdf_pass)를 준다.
 *
 *   입장권 = base64url(머리) "." base64url(몸) "." base64url(Ed25519 서명)
 *   머리   = { alg: "EdDSA", kid }
 *   몸     = { aud: "pdf", sub, sch, iat, exp, jti }   sub · sch 는 Xschool이 만든 가명 번호
 *
 * 통행증 = base64url(JSON { sub, sch, exp }) "." HMAC-SHA256(서버가 시작할 때 만든 비밀)
 * 서버 파일 · DB에는 아무것도 남기지 않는다. 메모리에는 한 번 쓴 입장권 번호(jti)만 3분 둔다.
 */
const crypto = require('crypto');

const AUD = 'pdf';
const SKEW_SECONDS = 30;
const JTI_KEEP_MS = 3 * 60 * 1000;
const PASS_SECONDS = 8 * 60 * 60;
const PUBKEY_TTL_MS = 60 * 60 * 1000;
const COOKIE = 'pdf_pass';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (text) => Buffer.from(String(text), 'base64url');

/** 입장권 확인에 실패한 까닭: 화면 문장과 로그에 쓰는 종류 이름 */
const REASONS = {
  format: '입장권 모양이 맞지 않아요.',
  alg: '입장권이 맞지 않아요.',
  kid: '입장권이 맞지 않아요.',
  signature: '입장권이 맞지 않아요.',
  aud: '이 도구의 입장권이 아니에요.',
  expired: '입장권이 만료됐어요(2분).',
  future: '입장권 시각이 맞지 않아요. 컴퓨터 시계를 확인해 주세요.',
  used: '이미 쓴 입장권이에요.',
};

/** 공개 키 { kid, key(base64url 32바이트) } 로 입장권을 확인한다. 한 번 쓴 jti는 jtis가 막는다. */
function checkTicket(ticket, publicKey, { now = Date.now(), jtis } = {}) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'format' };
  let head;
  let body;
  try {
    head = JSON.parse(unb64(parts[0]).toString('utf8'));
    body = JSON.parse(unb64(parts[1]).toString('utf8'));
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (!head || !body || typeof head !== 'object' || typeof body !== 'object') return { ok: false, reason: 'format' };
  if (head.alg !== 'EdDSA') return { ok: false, reason: 'alg' };
  if (head.kid !== publicKey.kid) return { ok: false, reason: 'kid' };
  let good = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey.key }, format: 'jwk' });
    good = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, unb64(parts[2]));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'signature' };
  const seconds = Math.floor(now / 1000);
  if (body.aud !== AUD) return { ok: false, reason: 'aud' };
  if (!(Number(body.exp) > seconds - SKEW_SECONDS)) return { ok: false, reason: 'expired' };
  if (!(Number(body.iat) < seconds + SKEW_SECONDS)) return { ok: false, reason: 'future' };
  if (typeof body.sub !== 'string' || typeof body.sch !== 'string' || typeof body.jti !== 'string' || !body.jti) return { ok: false, reason: 'format' };
  if (jtis && !jtis.take(body.jti, now)) return { ok: false, reason: 'used' };
  return { ok: true, body };
}

/** 한 번 쓴 입장권 번호. 3분 뒤 비운다(입장권은 2분짜리라 그 뒤에는 어차피 만료). */
function createJtiStore(keepMs = JTI_KEEP_MS) {
  const seen = new Map();
  return {
    take(jti, now = Date.now()) {
      for (const [k, until] of seen) if (until <= now) seen.delete(k);
      if (seen.has(jti)) return false;
      seen.set(jti, now + keepMs);
      return true;
    },
    size: () => seen.size,
  };
}

/** 통행증: 가명 번호와 끝나는 시각만, 서버 비밀로 서명 */
function makePass(secret, { sub, sch }, now = Date.now()) {
  const payload = b64(JSON.stringify({ sub, sch, exp: Math.floor(now / 1000) + PASS_SECONDS }));
  const sig = b64(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

function readPass(secret, value, now = Date.now()) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  const given = unb64(parts[1]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const pass = JSON.parse(unb64(parts[0]).toString('utf8'));
    if (!(Number(pass.exp) > Math.floor(now / 1000))) return null;
    return pass;
  } catch {
    return null;
  }
}

function cookieOf(req, name = COOKIE) {
  const header = String(req.headers.cookie || '');
  for (const piece of header.split(';')) {
    const at = piece.indexOf('=');
    if (at > 0 && piece.slice(0, at).trim() === name) return piece.slice(at + 1).trim();
  }
  return '';
}

/** shared: 빌려 쓰는 PC(Xschool에서 "내 교실 PC"로 정하지 않은 PC) → 브라우저를 닫으면 사라지는 쿠키 */
function passCookie(value, { shared = false } = {}) {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/${shared ? '' : `; Max-Age=${PASS_SECONDS}`}`;
}

/**
 * 같은 브라우저를 여러 선생님이 쓸 때 서명 · 도장을 나눠 보관하는 짧은 표(16자리 16진수).
 * Xschool 가명 번호(sub)에서 만들어 재배포해도 같다. 이름 · 이메일과 이어지지 않고, 화면이 읽는 쿠키라 서버는 쓰지 않는다.
 */
function ownerTag(sub) {
  return crypto.createHash('sha256').update(`pdfws-owner:${String(sub || '')}`).digest('hex').slice(0, 16);
}

/** 들어올 때 함께 주는 쿠키: 통행증(HttpOnly) + 화면이 읽는 표 둘(pdf_who · pdf_pc) */
function enterCookies(pass, sub, { shared = false } = {}) {
  const life = shared ? '' : `; Max-Age=${PASS_SECONDS}`;
  return [
    passCookie(pass, { shared }),
    `pdf_who=${ownerTag(sub)}; Secure; SameSite=Lax; Path=/${life}`,
    shared ? 'pdf_pc=shared; Secure; SameSite=Lax; Path=/' : 'pdf_pc=; Secure; SameSite=Lax; Path=/; Max-Age=0',
  ];
}

/**
 * Xschool 공개 키: 1시간 캐시. 받지 못하면 마지막으로 받은 키를 쓰고, 한 번도 못 받았으면 null.
 */
function createPubkeyCache(schoolUrl, { fetchImpl = globalThis.fetch, ttlMs = PUBKEY_TTL_MS, timeoutMs = 5000 } = {}) {
  let last = null;
  let at = 0;
  return {
    async get(now = Date.now()) {
      if (last && now - at < ttlMs) return last;
      try {
        const res = await fetchImpl(`${schoolUrl.replace(/\/+$/, '')}/api/tools/pubkey`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(String(res.status));
        const json = await res.json();
        if (json && json.alg === 'EdDSA' && typeof json.kid === 'string' && typeof json.key === 'string' && unb64(json.key).length === 32) {
          last = { kid: json.kid, key: json.key };
          at = now;
        }
      } catch {
        // Xschool이 잠깐 안 닿으면 마지막 키를 그대로 쓴다
      }
      return last;
    },
  };
}

/** IP(X-Real-IP)당 1분에 max번 */
function createRateLimit(max = 20, windowMs = 60 * 1000) {
  const hits = new Map();
  return (ip, now = Date.now()) => {
    const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return list.length <= max;
  };
}

function clientIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  return real || (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = {
  AUD, COOKIE, PASS_SECONDS, REASONS,
  checkTicket, createJtiStore, makePass, readPass, cookieOf, passCookie, ownerTag, enterCookies, createPubkeyCache, createRateLimit, clientIp,
};
