import crypto from 'node:crypto';

const COOKIE = 'fm_auth';

export function authEnabled(config) {
  return Boolean(config.accessCode);
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function tokenFor(code) {
  return crypto.createHmac('sha256', 'family-media-v1').update(String(code)).digest('hex');
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function isAuthed(req, config) {
  if (!authEnabled(config)) return true;
  const cookies = parseCookies(req.headers.cookie);
  return safeEqual(cookies[COOKIE] || '', tokenFor(config.accessCode));
}

export function cookieHeader(code) {
  return `${COOKIE}=${tokenFor(code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}
