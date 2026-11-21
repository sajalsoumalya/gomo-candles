// One-time codes for mobile sign-in and for verifying mobile / WhatsApp / email.
// Codes are 6 digits, stored only as HMAC-SHA256(OTP_SECRET, purpose|target|code), single-use, 5 tries.
// Delivery for phones: WhatsApp (OpenWA) first, bulk SMS as fallback — see settings.otp / settings.sms.

import { HttpError, hmacSha256Hex, timingSafeEqual, escapeHtml } from './util.js';
import { db, rateLimit, safeKey } from './db.js';
import { checkWhatsAppNumber, deliver, render } from './notify.js';
import { getSettings, integrations } from './settings.js';
import { smsReady } from './sms.js';
import { codeEmail } from './email.js';

export const PURPOSES = ['login', 'login_email', 'verify_phone', 'verify_whatsapp', 'verify_email'];
const PHONE_TTL = 5 * 60_000;
const EMAIL_TTL = 10 * 60_000;
const RESEND_AFTER = 30_000;
const MAX_ATTEMPTS = 5;
const LOCKOUT = 15 * 60_000;

/** Uniform random 6-digit code (rejection sampling, no modulo bias). */
export function generateCode() {
  const out = [];
  const buf = new Uint8Array(16);
  while (out.length < 6) {
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 250 && out.length < 6) out.push(b % 10);
  }
  return out.join('');
}

export const maskPhone = (p) => `+91 ${String(p).slice(0, 2)}•••••${String(p).slice(-3)}`;
export function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return '';
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}`;
}

const otpPath = (purpose, target) => `otp/${purpose}/${safeKey(target)}`;

async function codeHash(env, purpose, target, code) {
  if (!env.OTP_SECRET) throw new HttpError(500, 'OTP_SECRET is not configured on the Worker.');
  return hmacSha256Hex(env.OTP_SECRET, `${purpose}|${target}|${code}`);
}

/** Local development only: return the code in the API response (wrangler dev --var DEV_OTP_ECHO:1). */
export function devEcho(request, env) {
  if (env.DEV_OTP_ECHO !== '1') return false;
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

export async function verifyTurnstile(env, token, ip, fetchImpl = fetch) {
  const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token || ''), remoteip: ip }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

/** Which delivery channels exist right now (used by the shop to decide what to offer). */
export function otpChannels(env, settings) {
  const ch = [];
  if (env.OPENWA_URL) ch.push('whatsapp');
  if (settings.otp.sms_fallback && smsReady(env, settings.sms)) ch.push('sms');
  if (env.DEV_OTP_ECHO === '1' && !ch.length) ch.push('dev'); // local wrangler dev only (codes are echoed on localhost)
  return ch;
}

function otpText(settings, code, minutes) {
  return render(settings.otp.message, { code, store_name: settings.store.name, minutes });
}
// SMS and email have no WhatsApp bold/italic marks and many SMS routes reject emoji: send a plain, one-line version.
const plainText = (t) => String(t).replace(/[*_~]/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

/**
 * Send a code. opts: { purpose, target (10-digit phone or email), channel: auto|sms|whatsapp, uid?, ip, request, turnstile? }
 * Returns { channel, masked, resend_in, expires_in, whatsapp: true|false|null, dev_code? }.
 */
export async function startOtp(env, opts, fetchImpl = fetch) {
  const { purpose, target, uid = null, ip = 'unknown', request } = opts;
  const channel = ['sms', 'whatsapp'].includes(opts.channel) ? opts.channel : 'auto';
  if (!PURPOSES.includes(purpose)) throw new HttpError(400, 'Unknown code purpose.');
  const isEmail = purpose === 'verify_email' || purpose === 'login_email';
  const settings = await getSettings(env);
  const d = db(env);
  const now = Date.now();

  if (env.TURNSTILE_ENFORCE === '1' && settings.otp.turnstile_site_key && env.TURNSTILE_SECRET && (purpose === 'login' || purpose === 'login_email')) {
    if (!(await verifyTurnstile(env, opts.turnstile, ip, fetchImpl))) {
      throw new HttpError(403, 'Please complete the security check and try again.', { code: 'turnstile_failed' });
    }
  }

  const path = otpPath(purpose, target);
  const prev = await d.get(path);
  if (prev?.locked_until > now) {
    throw new HttpError(429, 'Too many wrong attempts. Please try again in a few minutes.', { code: 'locked', retry_in: Math.ceil((prev.locked_until - now) / 1000) });
  }
  if (prev?.created_at && now - prev.created_at < RESEND_AFTER) {
    throw new HttpError(429, 'Please wait a few seconds before asking for another code.', { code: 'cooldown', resend_in: Math.ceil((RESEND_AFTER - (now - prev.created_at)) / 1000) });
  }

  const t = safeKey(target);
  const limits = isEmail
    ? [[`otp:e:${t}:h`, 5, 3600], [`otp:ip:${ip}:h`, 40, 3600]]
    : [[`otp:p:${t}:h`, 5, 3600], [`otp:p:${t}:d`, 10, 86400], [`otp:ip:${ip}:h`, 40, 3600], [`otp:ip:${ip}:d`, 150, 86400]];
  for (const [key, limit, win] of limits) {
    if (!(await rateLimit(env, key, limit, win))) throw new HttpError(429, 'Too many codes requested. Please try again later.', { code: 'rate_limited' });
  }

  const code = generateCode();
  const ttl = isEmail ? EMAIL_TTL : PHONE_TTL;
  const minutes = Math.round(ttl / 60_000);
  const text = otpText(settings, code, minutes);
  const logText = text.replace(code, '******');
  const event = `otp_${purpose}`;
  let used = null, whatsapp = null, lastError = '';

  if (isEmail) {
    if (!integrations(env).postal) {
      if (!devEcho(request, env)) throw new HttpError(503, 'Email confirmation is not available yet. Please try again later.', { code: 'email_unavailable' });
      used = 'dev';
    } else {
      const html = codeEmail({ settings, code, minutes, purpose });
      const r = await deliver(env, {
        channel: 'email', to: target, subject: `${code} is your ${settings.store.name} ${purpose === 'login_email' ? 'sign-in' : 'verification'} code`, text: plainText(text), html, event,
        logText,
      }, fetchImpl);
      if (r.status === 'sent') used = 'email';
      else lastError = r.error;
    }
  } else {
    let order;
    if (channel === 'whatsapp') order = ['whatsapp'];
    else if (channel === 'sms') order = ['sms'];
    else order = settings.otp.whatsapp_first ? ['whatsapp', 'sms'] : ['sms', 'whatsapp'];
    for (const ch of order) {
      if (ch === 'whatsapp') {
        if (!env.OPENWA_URL) continue;
        whatsapp = await checkWhatsAppNumber(env, `91${target}`, fetchImpl);
        if (whatsapp === false) { lastError = 'This number is not on WhatsApp.'; continue; }
        const r = await deliver(env, { channel: 'whatsapp', to: `91${target}`, text, event, logText }, fetchImpl);
        if (r.status === 'sent') { used = 'whatsapp'; break; }
        lastError = r.error;
      } else {
        if (channel !== 'sms' && !settings.otp.sms_fallback) continue;
        if (!smsReady(env, settings.sms)) continue;
        if (!(await rateLimit(env, 'otp:sms:global:d', settings.otp.daily_sms_cap, 86400))) {
          console.error('daily SMS cap reached');
          lastError = 'SMS limit reached for today.';
          continue;
        }
        const r = await deliver(env, { channel: 'sms', to: `91${target}`, text: plainText(text), code, sms: settings.sms, event, logText: plainText(logText) }, fetchImpl);
        if (r.status === 'sent') { used = 'sms'; break; }
        lastError = r.error;
      }
    }
    if (!used && devEcho(request, env)) used = 'dev';
    if (!used) {
      const msg = channel === 'whatsapp' && whatsapp === false
        ? 'This number is not on WhatsApp.'
        : 'We could not send a code right now. Please try again shortly or contact us on WhatsApp.';
      throw new HttpError(channel === 'whatsapp' && whatsapp === false ? 409 : 503, msg, {
        code: channel === 'whatsapp' && whatsapp === false ? 'not_on_whatsapp' : 'otp_unavailable', whatsapp,
      });
    }
  }

  await d.put(path, { hmac: await codeHash(env, purpose, target, code), exp: now + ttl, attempts: 0, channel: used, uid, created_at: now, whatsapp });
  const out = {
    channel: used, masked: isEmail ? maskEmail(target) : maskPhone(target),
    resend_in: Math.round(RESEND_AFTER / 1000), expires_in: Math.round(ttl / 1000), whatsapp,
  };
  if (devEcho(request, env)) out.dev_code = code;
  if (lastError && used !== 'dev') out.note = lastError;
  return out;
}

/** Check a code. Returns { channel, whatsapp } on success, throws HttpError otherwise. Single use. */
export async function verifyOtp(env, { purpose, target, code, uid = null }) {
  const d = db(env);
  const path = otpPath(purpose, target);
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const { value: rec, etag } = await d.getWithEtag(path);
    if (!rec || !rec.hmac) {
      if (rec?.locked_until > now) throw new HttpError(429, 'Too many wrong attempts. Please request a new code in a few minutes.', { code: 'locked' });
      throw new HttpError(400, 'This code has expired. Please request a new one.', { code: 'code_expired' });
    }
    if (rec.exp < now) {
      await d.putIfMatch(path, null, etag);
      throw new HttpError(400, 'This code has expired. Please request a new one.', { code: 'code_expired' });
    }
    const clean = String(code || '').replace(/\D/g, '');
    const good = clean.length === 6 && (rec.uid || null) === (uid || null)
      && timingSafeEqual(rec.hmac, await codeHash(env, purpose, target, clean));
    if (good) {
      if (!(await d.putIfMatch(path, null, etag))) continue; // raced with another attempt; re-read
      return { channel: rec.channel, whatsapp: rec.whatsapp ?? null };
    }
    const attempts = (rec.attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      if (!(await d.putIfMatch(path, { locked_until: now + LOCKOUT, created_at: rec.created_at }, etag))) continue;
      throw new HttpError(429, 'Too many wrong attempts. Please request a new code in a few minutes.', { code: 'locked' });
    }
    if (!(await d.putIfMatch(path, { ...rec, attempts }, etag))) continue;
    const left = MAX_ATTEMPTS - attempts;
    throw new HttpError(400, `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, { code: 'wrong_code', tries_left: left });
  }
  throw new HttpError(409, 'Please try again.');
}
