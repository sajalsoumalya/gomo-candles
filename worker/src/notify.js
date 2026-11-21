import { escapeHtml, inr, STATUS_LABELS } from './util.js';
import { DEFAULT_TEMPLATES, getSettings } from './settings.js';
import { db, pushKey } from './db.js';
import { sendSms, smsReady } from './sms.js';
import { orderEmail } from './email.js';

// ------------------------------------------------------------------ templating

export function render(tpl, vars) {
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

export function paymentLabel(order) {
  if (order.payment_status === 'paid') return order.payment_method === 'cod' ? 'Paid (Cash on Delivery)' : 'Paid online';
  if (order.payment_status === 'refunded') return 'Refunded';
  return order.payment_method === 'cod' ? 'Cash on Delivery' : 'Online payment pending';
}

export function orderVars(order, items, settings) {
  const shopUrl = (settings.store.shop_url || '').replace(/\/+$/, '');
  const first = String(order.customer_name || '').split(' ')[0] || 'there';
  return {
    name: first,
    full_name: order.customer_name,
    phone: order.phone,
    order_no: order.order_no,
    items: items.map((i) => `▫️ ${i.qty} × ${i.name} — *${inr(i.line_total)}*`).join('\n'),
    subtotal: inr(order.subtotal),
    savings: order.savings ? inr(order.savings) : '',
    discount: order.discount ? inr(order.discount) : '',
    coupon_code: order.coupon_code || '',
    discount_line: order.discount ? `🏷️ Coupon ${order.coupon_code}: −${inr(order.discount)}\n` : '',
    shipping: order.shipping ? inr(order.shipping) : 'Free',
    total: inr(order.total),
    payment: paymentLabel(order),
    status: STATUS_LABELS[order.status] || order.status,
    courier: order.courier || '',
    tracking_no: order.tracking_no || '',
    tracking_url: order.tracking_url || '',
    shipping_info: [order.courier && `🚚 Courier: *${order.courier}*`, order.tracking_no && `🔢 Tracking no: *${order.tracking_no}*`, order.tracking_url && `🔗 ${order.tracking_url}`]
      .filter(Boolean).join('\n'),
    cod_note: order.payment_method === 'cod' && order.payment_status !== 'paid' ? `💵 Please keep *${inr(order.total)}* ready (Cash on Delivery).` : '',
    track_link: shopUrl ? `${shopUrl}/#track/${order.order_no}` : order.order_no,
    address: [order.address_line1, order.address_line2, order.landmark, `${order.city}, ${order.state} ${order.pincode}`].filter(Boolean).join(', '),
    store_name: settings.store.name,
    store_whatsapp: settings.store.whatsapp ? '+' + settings.store.whatsapp : '',
  };
}

/** Kept for callers/tests: the branded order email (see email.js). */
export function emailHtml({ intro, order, items, vars, settings, event = 'order_placed', admin = false }) {
  return orderEmail({ intro, order, items, vars, settings, event, admin });
}

// ------------------------------------------------------------------ providers

export async function sendEmailPostal(env, { to, subject, text, html }, fetchImpl = fetch) {
  const base = String(env.POSTAL_URL).replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/api/v1/send/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-server-api-key': env.POSTAL_API_KEY },
    body: JSON.stringify({ to: [to], from: env.MAIL_FROM, reply_to: env.MAIL_REPLY_TO || undefined, subject, plain_body: text, html_body: html }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status !== 'success') throw new Error(`Postal ${res.status}: ${JSON.stringify(data.data || data).slice(0, 200)}`);
  return data.data?.message_id || '';
}

/**
 * OpenWA server (github.com/rmyndharis/OpenWA, v0.2x) — REST API with sessions, auth header X-API-Key.
 *   send:   POST {OPENWA_URL}/api/sessions/{sessionId}/messages/send-text   { chatId: "919876543210@c.us", text }
 *   check:  GET  {OPENWA_URL}/api/sessions/{sessionId}/contacts/check/{number} → { exists }
 *   status: GET  {OPENWA_URL}/api/sessions/{sessionId} → { status: "ready" | "qr_ready" | ... }
 * The session is picked by OPENWA_SESSION (its name or id); if unset, the first "ready" session is used.
 */
const waBase = (env) => String(env.OPENWA_URL || '').replace(/\/+$/, '');
const waHeaders = (env) => ({ 'content-type': 'application/json', 'x-api-key': env.OPENWA_API_KEY || '' });
const waChatId = (to) => `${String(to).replace(/\D/g, '')}@c.us`;
let waSessionCache = null; // { id, at } per isolate

/** Resolve the session id to use. Returns { id, name, status } or throws. */
export async function openwaSession(env, fetchImpl = fetch, { fresh = false } = {}) {
  const want = String(env.OPENWA_SESSION || '').trim();
  if (!fresh && waSessionCache && Date.now() - waSessionCache.at < 10 * 60_000 && waSessionCache.want === want) return waSessionCache.s;
  const res = await fetchImpl(`${waBase(env)}/api/sessions`, { headers: waHeaders(env) });
  if (res.status === 401 || res.status === 403) throw new Error(`OpenWA rejected the API key (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`OpenWA HTTP ${res.status} listing sessions`);
  const body = await res.json().catch(() => null);
  const list = Array.isArray(body) ? body : (body?.data || body?.sessions || body?.items || []);
  const s = want
    ? list.find((x) => x.id === want || x.name === want)
    : list.find((x) => x.status === 'ready') || list[0];
  if (!s) throw new Error(want ? `OpenWA session "${want}" not found` : 'OpenWA has no sessions — create one and scan the QR code');
  const out = { id: s.id, name: s.name, status: s.status, phone: s.phone || null };
  waSessionCache = { s: out, at: Date.now(), want };
  return out;
}

export async function sendWhatsAppOpenWA(env, { to, text }, fetchImpl = fetch) {
  const send = async (s) => fetchImpl(`${waBase(env)}/api/sessions/${encodeURIComponent(s.id)}/messages/send-text`, {
    method: 'POST', headers: waHeaders(env), body: JSON.stringify({ chatId: waChatId(to), text }),
  });
  let s = await openwaSession(env, fetchImpl);
  let res = await send(s);
  if (res.status === 404) { s = await openwaSession(env, fetchImpl, { fresh: true }); res = await send(s); } // session recreated
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenWA ${res.status}: ${String(data.message || data.error || JSON.stringify(data)).slice(0, 200)}`);
  return data.messageId || data.id || '';
}

/** Is this number on WhatsApp? true / false, or null when unknown (OpenWA down, session not ready, timeout). */
export async function checkWhatsAppNumber(env, to, fetchImpl = fetch) {
  if (!env.OPENWA_URL) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const s = await openwaSession(env, fetchImpl);
    const res = await fetchImpl(`${waBase(env)}/api/sessions/${encodeURIComponent(s.id)}/contacts/check/${String(to).replace(/\D/g, '')}`, {
      headers: waHeaders(env), signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data && typeof data.exists === 'boolean' ? data.exists : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function providerMissing(env, channel, msg) {
  if (channel === 'email' && !(env.POSTAL_URL && env.POSTAL_API_KEY && env.MAIL_FROM)) return 'Postal not configured (dry run)';
  if (channel === 'whatsapp' && !env.OPENWA_URL) return 'OpenWA not configured (dry run)';
  if (channel === 'sms' && !smsReady(env, msg.sms)) return 'SMS provider not configured (dry run)';
  return null;
}

/**
 * Send one message and record it in the notifications log. Never throws.
 * msg.logText (optional) is stored instead of msg.text — used to keep OTP codes out of the log.
 * SMS messages need msg.sms (settings.sms) and msg.code.
 */
export async function deliver(env, msg, fetchImpl = fetch) {
  const { channel, to, subject = null, text, html = null, event, order_no = null, logId = null, logText } = msg;
  let status = 'sent', error = null, provider_id = null;
  const missing = providerMissing(env, channel, msg);
  if (missing) {
    status = 'skipped';
    error = missing;
  } else {
    try {
      if (channel === 'email') provider_id = await sendEmailPostal(env, { to, subject, text, html }, fetchImpl);
      else if (channel === 'sms') provider_id = (await sendSms(env, msg.sms, { phone: String(to).replace(/\D/g, '').slice(-10), code: msg.code, text }, fetchImpl)).provider_id;
      else provider_id = await sendWhatsAppOpenWA(env, { to, text }, fetchImpl);
    } catch (e) {
      status = 'failed';
      error = String(e.message || e).slice(0, 500);
      console.error('notify failed', channel, to, error);
    }
  }
  const storedText = logText ?? text;
  const storedHtml = logText !== undefined ? null : html;
  try {
    const d = db(env);
    if (logId) {
      const prev = await d.get(`notifications/${logId}/attempts`);
      await d.patch(`notifications/${logId}`, { status, error, provider_id, attempts: (Number(prev) || 1) + 1, updated_at: new Date().toISOString() });
    } else {
      await d.put(`notifications/${pushKey()}`, {
        created_at: new Date().toISOString(), order_no, event, channel, recipient: to, subject, body: storedText, html: storedHtml, status, error, provider_id, attempts: 1,
        retryable: logText === undefined,
      });
    }
  } catch (e) {
    console.error('notification log write failed', e);
  }
  return { channel, to, status, error };
}

// ------------------------------------------------------------------ order events

/**
 * Send notifications for an order event.
 * opts: { whatsapp=true, email=true, admin=false }
 */
export async function notifyOrderEvent(env, order, items, event, opts = {}, fetchImpl = fetch) {
  const { whatsapp = true, email = true, admin = false } = opts;
  const settings = await getSettings(env);
  const vars = orderVars(order, items, settings);
  const sends = [];

  const tpl = settings.templates[event] || DEFAULT_TEMPLATES[event];
  if (tpl && event !== 'admin_new_order') {
    if (whatsapp && settings.notify.customer_whatsapp && order.phone && order.whatsapp_status !== 'unavailable') {
      sends.push({ channel: 'whatsapp', to: '91' + order.phone, text: render(tpl.whatsapp, vars) });
    }
    if (email && settings.notify.customer_email && order.email) {
      const intro = render(tpl.email_intro, vars);
      sends.push({
        channel: 'email', to: order.email, subject: render(tpl.email_subject, vars),
        text: `${intro}\n\n${vars.items}\nTotal: ${vars.total} (${vars.payment})\n\nTrack: ${vars.track_link}`,
        html: emailHtml({ intro, order, items, vars, settings, event }),
      });
    }
  }

  if (admin) {
    const at = settings.templates.admin_new_order || DEFAULT_TEMPLATES.admin_new_order;
    for (const to of settings.notify.admin_whatsapp) sends.push({ channel: 'whatsapp', to, text: render(at.whatsapp, vars), event: 'admin_new_order' });
    const intro = render(at.email_intro, vars);
    // Nobody set in Settings → Notifications? Alert the super admins (ADMIN_EMAILS) so no order goes unnoticed.
    const adminTo = settings.notify.admin_emails.length || settings.notify.admin_whatsapp.length ? settings.notify.admin_emails
      : String(env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    for (const to of adminTo) {
      sends.push({
        channel: 'email', to, subject: render(at.email_subject, vars), event: 'admin_new_order',
        text: `${intro}\n\n${vars.items}\nTotal: ${vars.total} (${vars.payment})\n${vars.address}`,
        html: emailHtml({ intro, order, items, vars, settings, event, admin: true }),
      });
    }
  }

  const results = [];
  for (const s of sends) results.push(await deliver(env, { event, order_no: order.order_no, ...s }, fetchImpl));
  return results;
}
