import { HttpError, json, readJson, nowIso, clientIp, STATUS_LABELS } from './util.js';
import { getSettings, integrations, saveSettings, validateSettingsInput, DEFAULT_TEMPLATES, EVENTS } from './settings.js';
import { deliver, render, paymentLabel } from './notify.js';
import { isValidEmail, normalizePhone } from './validate.js';
import { adminEmails } from './auth.js';
import { SETTINGS_AREA } from './staff.js';
import { db, values } from './db.js';
import { startOtp, otpChannels } from './otp.js';
import { publicProfile } from './account.js';
import { authAdmin } from './google.js';
import { smsReady } from './sms.js';

export async function adminGetSettings(env) {
  const settings = await getSettings(env);
  return json({
    settings,
    integrations: { ...integrations(env), sms: smsReady(env, settings.sms) },
    otp_channels: otpChannels(env, settings),
    defaults: { templates: DEFAULT_TEMPLATES },
    events: EVENTS,
    admin_emails: adminEmails(env),
    placeholders: ['name', 'full_name', 'phone', 'order_no', 'items', 'subtotal', 'savings', 'shipping', 'total', 'payment', 'status',
      'courier', 'tracking_no', 'tracking_url', 'shipping_info', 'cod_note', 'track_link', 'address', 'store_name', 'store_whatsapp'],
  });
}

export async function adminPutSettings(request, env, admin) {
  const body = await readJson(request, 128 * 1024);
  if (admin && !admin.areas?.includes('*')) {
    const blocked = Object.keys(body).filter((k) => !admin.areas.includes(SETTINGS_AREA[k]));
    if (blocked.length) throw new HttpError(403, `You can't change these settings: ${blocked.join(', ')}.`, { code: 'forbidden' });
  }
  const current = await getSettings(env);
  const values = validateSettingsInput(body, env, current);
  await saveSettings(env, values);
  return adminGetSettings(env);
}

export async function adminTestNotification(request, env) {
  const body = await readJson(request);
  const settings = await getSettings(env);
  const channel = body.channel === 'email' ? 'email' : 'whatsapp';
  let to = String(body.to || '').trim();
  if (channel === 'email') {
    if (!isValidEmail(to)) throw new HttpError(422, 'Enter a valid email address.');
  } else {
    const ten = normalizePhone(to);
    to = ten ? '91' + ten : to.replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(to)) throw new HttpError(422, 'Enter a WhatsApp number with country code.');
  }
  const text = render('This is a test message from {{store_name}} admin. If you can read this, {{channel}} notifications are working.', {
    store_name: settings.store.name, channel: channel === 'email' ? 'email' : 'WhatsApp',
  });
  const result = await deliver(env, {
    channel, to, event: 'test', text,
    subject: `${settings.store.name}: test email`,
    html: channel === 'email' ? `<p style="font-family:Helvetica,Arial,sans-serif;font-size:15px">${text}</p>` : null,
  });
  return json({ result });
}

export async function adminListNotifications(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
  const size = 30;
  const map = (await db(env).get('notifications', { orderBy: 'created_at', limitToLast: 1000 })) || {};
  let rows = Object.entries(map).map(([id, n]) => ({ id, created_at: n.created_at, order_no: n.order_no || null, event: n.event, channel: n.channel,
    recipient: n.recipient, subject: n.subject || null, status: n.status, error: n.error || null, attempts: n.attempts || 1, retryable: n.retryable !== false,
    dismissed: !!n.dismissed_at, is_code: String(n.event || '').startsWith('otp_') }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (status === 'failed') rows = rows.filter((n) => n.status === 'failed' && !n.dismissed);
  else if (['sent', 'skipped'].includes(status)) rows = rows.filter((n) => n.status === status);
  return json({ notifications: rows.slice((page - 1) * size, page * size), total: rows.length, page, page_size: size });
}

export async function adminRetryNotification(env, id) {
  const row = await db(env).get(`notifications/${id}`);
  if (!row) throw new HttpError(404, 'Notification not found.');
  if (row.status === 'sent') throw new HttpError(409, 'Already sent.');
  if (row.retryable === false) throw new HttpError(409, 'Verification codes cannot be resent from here — the customer can request a new one.');
  const result = await deliver(env, {
    channel: row.channel, to: row.recipient, subject: row.subject, text: row.body, html: row.html,
    event: row.event, order_no: row.order_no, logId: id,
  });
  return json({ result });
}

/** Mark failed messages as dealt with, so they stop showing in the dashboard warning. ids = list, or 'all_failed'. */
export async function adminDismissNotifications(request, env, admin) {
  const body = await readJson(request);
  const d = db(env);
  let ids = Array.isArray(body.ids) ? body.ids.filter((x) => /^[a-z0-9]{10,24}$/.test(String(x))).slice(0, 500) : [];
  if (body.all_failed) {
    const map = (await d.get('notifications', { orderBy: 'created_at', limitToLast: 1000 })) || {};
    ids = Object.entries(map).filter(([, n]) => n.status === 'failed' && !n.dismissed_at).map(([id]) => id);
  }
  const at = nowIso();
  const up = {};
  for (const id of ids) { up[`notifications/${id}/dismissed_at`] = at; up[`notifications/${id}/dismissed_by`] = admin?.email || null; }
  if (ids.length) await d.patch('', up);
  return json({ dismissed: ids.length });
}

// --------------------------------------------------------------------------- OTP test

export async function adminTestOtp(request, env, admin) {
  const body = await readJson(request);
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(422, 'Enter a 10-digit Indian mobile number.', { fields: { phone: 'Enter a 10-digit mobile number.' } });
  const channel = ['sms', 'whatsapp'].includes(body.channel) ? body.channel : 'auto';
  // A real code is sent (and immediately discarded) so delivery can be checked end to end.
  const out = await startOtp(env, { purpose: 'verify_phone', target: phone, channel, uid: `admin_${admin.uid}`, ip: clientIp(request), request });
  await db(env).remove(`otp/verify_phone/${phone}`);
  return json({ result: out });
}

// --------------------------------------------------------------------------- customers

const CUSTOMER_SCAN = 2000;

export async function adminListCustomers(request, env) {
  const url = new URL(request.url);
  const p = (k) => url.searchParams.get(k) || '';
  const map = (await db(env).get('users', { orderBy: 'created_at', limitToLast: CUSTOMER_SCAN })) || {};
  let rows = Object.values(map).filter((u) => u?.uid && !u.merged_into)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const q = p('q').trim().toLowerCase().slice(0, 60);
  if (q) {
    const digits = q.replace(/\D/g, '');
    rows = rows.filter((u) => String(u.name || '').toLowerCase().includes(q) || String(u.email || '').includes(q)
      || (digits.length >= 4 && String(u.phone || '').includes(digits)) || u.uid === q);
  }
  const f = p('filter');
  if (f === 'phone_unverified') rows = rows.filter((u) => !u.phone_verified);
  if (f === 'email_unverified') rows = rows.filter((u) => u.email && !u.email_verified);
  if (f === 'no_email') rows = rows.filter((u) => !u.email);
  if (f === 'whatsapp_pending') rows = rows.filter((u) => u.phone_verified && !['verified', 'unavailable'].includes(u.whatsapp_status));
  if (f === 'disabled') rows = rows.filter((u) => u.disabled);
  if (['phone', 'password', 'google'].includes(p('via'))) rows = rows.filter((u) => u.created_via === p('via'));
  const page = Math.max(1, Math.floor(Number(p('page')) || 1));
  const size = 25;
  const counts = await db(env).get('user_orders', { shallow: true }).catch(() => null);
  return json({
    customers: rows.slice((page - 1) * size, page * size).map((u) => ({
      uid: u.uid, name: u.name || '', email: u.email || null, email_verified: !!u.email_verified, phone: u.phone || null,
      phone_verified: !!u.phone_verified, whatsapp_status: u.whatsapp_status || 'unknown', created_via: u.created_via,
      created_at: u.created_at, last_login_at: u.last_login_at || null, disabled: !!u.disabled, has_orders: !!counts?.[u.uid],
    })),
    total: rows.length, page, page_size: size,
  });
}

async function customerOr404(env, uid) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new HttpError(404, 'Customer not found.');
  const u = await db(env).get(`users/${uid}`);
  if (!u) throw new HttpError(404, 'Customer not found.');
  return u;
}

export async function adminGetCustomer(env, uid) {
  const u = await customerOr404(env, uid);
  const d = db(env);
  const idx = (await d.get(`user_orders/${uid}`)) || {};
  const nos = Object.keys(idx).sort((a, b) => String(idx[b]).localeCompare(String(idx[a]))).slice(0, 100);
  const orders = (await Promise.all(nos.map((no) => d.get(`orders/${no}`)))).filter(Boolean).map((o) => ({
    order_no: o.order_no, created_at: o.created_at, total: o.total, status: o.status, status_label: STATUS_LABELS[o.status],
    payment_label: paymentLabel(o),
  }));
  const auditRows = Object.values((await d.get('audit', { orderBy: 'uid', equalTo: uid })) || {})
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50);
  const orphaned = await d.get(`orphaned_orders/${uid}`);
  const merged_from = await Promise.all(Object.keys(u.merged_from || {}).map(async (from) => ({ uid: from, at: u.merged_from[from] })));
  return json({
    customer: u.merged_into ? { uid: u.uid, merged_into: u.merged_into, merged_at: u.merged_at } : { ...publicProfile(u), disabled: !!u.disabled, last_login_at: u.last_login_at || null },
    orders, audit: auditRows, merged_from, orphaned_orders: orphaned ? Object.keys(orphaned.orders || {}) : [],
  });
}

export async function adminSetCustomerDisabled(env, uid, disabled, admin) {
  const u = await customerOr404(env, uid);
  if (u.merged_into) throw new HttpError(409, 'This account was merged into another one.');
  try { await authAdmin(env).update(uid, { disabled }); } catch (e) {
    console.error('disable user failed', e?.code || e);
    throw new HttpError(503, 'Could not update the sign-in account in Firebase. Please try again.');
  }
  await db(env).patch(`users/${uid}`, { disabled, updated_at: nowIso() });
  await db(env).put(`audit/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, { at: nowIso(), uid, action: disabled ? 'disabled' : 'enabled', detail: admin.email });
  return adminGetCustomer(env, uid);
}
