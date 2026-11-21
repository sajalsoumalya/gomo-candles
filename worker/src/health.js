// Live integration checks for Admin → Settings → Integrations. Each check is read-only: no message is sent,
// nothing is written. Results: { ok: true|false|null, detail }  (null = not configured, so not checked).

import { json } from './util.js';
import { db } from './db.js';
import { s3, s3Configured } from './s3.js';
import { getSettings, integrations } from './settings.js';
import { smsReady } from './sms.js';
import { openwaSession } from './notify.js';

const TIMEOUT = 8000;
const short = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 160);

async function timed(fn) {
  const t = Date.now();
  try {
    const r = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('No reply within 8 seconds')), TIMEOUT))]);
    return { ...r, ms: Date.now() - t };
  } catch (e) {
    const code = e?.cause?.code || '';
    return { ok: false, detail: short(code === 'ENOTFOUND' ? 'Address not found — check the URL' : e?.message || e), ms: Date.now() - t };
  }
}

export const CHECKS = {
  /** Firebase Realtime Database through the service account. */
  async database(env) {
    await db(env).get('settings/store/name');
    return { ok: true, detail: 'Read from the database' };
  },

  /** Postal: look up a message id that cannot exist. A valid key gets "not found"; a bad key gets an auth error. */
  async postal(env) {
    const base = String(env.POSTAL_URL).replace(/\/+$/, '');
    const res = await fetch(`${base}/api/v1/messages/message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-server-api-key': env.POSTAL_API_KEY }, body: JSON.stringify({ id: 1 }),
    });
    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, detail: `Postal replied HTTP ${res.status} without JSON — check POSTAL_URL` };
    const code = data.data?.code || '';
    if (/InvalidServerAPIKey|AccessDenied|ServerSuspended/i.test(code)) return { ok: false, detail: `Postal rejected the API key (${code})` };
    if (data.status === 'success' || /MessageNotFound/i.test(code)) return { ok: true, detail: `API key accepted · sending as ${env.MAIL_FROM}` };
    return { ok: false, detail: short(`Postal: ${code || data.status} ${data.data?.message || ''}`) };
  },

  /** OpenWA: find the session and report whether WhatsApp is linked. */
  async openwa(env) {
    const sess = await openwaSession(env, fetch, { fresh: true });
    if (sess.status === 'ready') return { ok: true, detail: `Session "${sess.name}" is connected${sess.phone ? ` (+${String(sess.phone).slice(0, 2)}•••${String(sess.phone).slice(-3)})` : ''}` };
    return { ok: false, detail: `Session "${sess.name}" is ${sess.status} — open the OpenWA dashboard and scan the QR code` };
  },

  /** Razorpay: list one order with the keys (read-only). */
  async razorpay(env) {
    const res = await fetch('https://api.razorpay.com/v1/orders?count=1', {
      headers: { authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) },
    });
    if (res.status === 401) return { ok: false, detail: 'Razorpay rejected the key id / secret' };
    if (!res.ok) return { ok: false, detail: `Razorpay replied HTTP ${res.status}` };
    return { ok: true, detail: `Keys accepted · ${String(env.RAZORPAY_KEY_ID).startsWith('rzp_live_') ? 'LIVE mode' : 'TEST mode'}` };
  },

  /** RustFS / S3: list one object under gomo/. */
  async s3(env) {
    await s3(env).listObjects('gomo/');
    return { ok: true, detail: `Bucket "${env.S3_BUCKET}" reachable with these keys` };
  },
};

export async function adminCheckIntegrations(env) {
  const ig = integrations(env);
  const settings = await getSettings(env);
  const want = {
    database: true,
    postal: ig.postal,
    openwa: ig.openwa,
    razorpay: ig.razorpay,
    s3: s3Configured(env),
  };
  const entries = await Promise.all(Object.entries(want).map(async ([k, on]) => [k, on ? await timed(() => CHECKS[k](env)) : { ok: null, detail: 'Not set' }]));
  const results = Object.fromEntries(entries);
  // Not callable without side effects, so only configuration is reported for these.
  results.razorpay_webhook = { ok: null, detail: ig.razorpay_webhook ? 'Secret set — verified when Razorpay sends the first event' : 'Not set', set: ig.razorpay_webhook };
  results.sms = { ok: null, detail: smsReady(env, settings.sms) ? 'Set — use “Send a test code” to check delivery' : 'Not set', set: smsReady(env, settings.sms) };
  results.otp_secret = { ok: ig.otp_secret ? true : null, detail: ig.otp_secret ? 'Set' : 'Not set' };
  return json({ checked_at: new Date().toISOString(), results });
}
