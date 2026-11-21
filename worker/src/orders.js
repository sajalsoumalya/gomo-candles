import { HttpError, json, newOrderNo, nowIso, readJson, readText, clientIp, STATUSES, STATUS_LABELS, PAYMENT_STATUSES } from './util.js';
import { priceCart } from './pricing.js';
import { loadCatalog } from './catalog.js';
import { getSettings, integrations } from './settings.js';
import { normalizePhone, validateOrderInput } from './validate.js';
import { notifyOrderEvent, paymentLabel } from './notify.js';
import { checkoutPayload, createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature } from './razorpay.js';
import { db, pushKey, rateLimit, safeKey, values } from './db.js';
import { requireCustomer, saveAddress } from './account.js';
import { otpChannels } from './otp.js';
import { evaluateCoupon, claimCoupon, releaseCoupon } from './coupons.js';
import { stockNeeds, reserveStock, releaseStock } from './stock.js';

const ORDER_LIMIT_PER_HOUR = 10;
const TRACK_LIMIT_PER_HOUR = 40;
const ADMIN_SCAN_LIMIT = 1000; // newest orders scanned for admin lists/stats

// Stored shape: orders/{order_no} = { ...flat order fields, items: [..], events: { <pushKey>: {...} } }
function split(rec) {
  if (!rec) return null;
  const { items, events, ...order } = rec;
  const evs = Object.entries(events || {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, e]) => ({ id, ...e }));
  return { order, items: values(items), events: evs };
}

export async function loadOrder(env, orderNo) {
  if (!/^GM-\d{6}-\d{4}$/.test(orderNo)) return null;
  return split(await db(env).get(`orders/${orderNo}`));
}

const event = (type, status, note, actor) => ({ created_at: nowIso(), type, status: status ?? null, note: note ?? null, actor: actor ?? null });

function publicSummary(order, items) {
  return {
    order_no: order.order_no,
    created_at: order.created_at,
    status: order.status,
    status_label: STATUS_LABELS[order.status],
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    payment_label: paymentLabel(order),
    subtotal: order.subtotal,
    savings: order.savings,
    shipping: order.shipping,
    discount: order.discount || 0,
    coupon_code: order.coupon_code || null,
    total: order.total,
    items: items.map((i) => ({ name: i.name, contents: i.contents ?? null, qty: i.qty, unit_price: i.unit_price, line_total: i.line_total })),
  };
}

const background = (ctx, p) => {
  const safe = p.catch((e) => console.error('background task failed', e));
  if (ctx?.waitUntil) ctx.waitUntil(safe);
  return safe;
};

// ------------------------------------------------------------------ public

/**
 * Which mobile number an order uses. A verified mobile is required once a code channel (WhatsApp / SMS) is configured;
 * until then the customer types it at checkout and the order is flagged phone_verified:false so the shop confirms it
 * before shipping.
 */
export function orderPhone(profile, typed, codesAvailable) {
  if (profile?.phone_verified && profile.phone) return { phone: profile.phone, verified: true };
  if (codesAvailable) throw new HttpError(403, 'Please verify your mobile number before placing an order.', { code: 'phone_unverified' });
  const phone = normalizePhone(typed);
  if (!phone) throw new HttpError(422, 'Please check the highlighted fields.', { fields: { phone: 'Enter a valid 10-digit mobile number.' } });
  return { phone, verified: false };
}


export async function createOrder(request, env, ctx) {
  const d = db(env);
  const { uid, profile } = await requireCustomer(request, env);
  if (!(await rateLimit(env, `order:${clientIp(request)}`, ORDER_LIMIT_PER_HOUR, 3600))
    || !(await rateLimit(env, `order:u:${uid}`, ORDER_LIMIT_PER_HOUR, 3600))) {
    throw new HttpError(429, 'Too many orders from this device. Please try again later or WhatsApp us.');
  }
  const raw = await readJson(request);
  const input = validateOrderInput(raw);

  const [settings, catalog] = await Promise.all([getSettings(env), loadCatalog(env)]);
  const { phone, verified: phoneVerified } = orderPhone(profile, raw.customer?.phone, otpChannels(env, settings).length > 0);

  const idemPath = input.idempotency_key ? `order_index/idem/${safeKey(uid + '_' + input.idempotency_key)}` : null;
  if (idemPath) {
    const existingNo = await d.get(idemPath);
    if (existingNo) {
      const found = await loadOrder(env, existingNo);
      if (found) return json({ order: publicSummary(found.order, found.items), duplicate: true });
    }
  }

  if (input.payment_method === 'cod' && !settings.payments.cod) throw new HttpError(422, 'Cash on Delivery is not available right now.');
  if (input.payment_method === 'razorpay' && !(settings.payments.razorpay && integrations(env).razorpay)) {
    throw new HttpError(422, 'Online payment is not available right now.');
  }

  const priced = priceCart(input.items, { products: catalog.productsById, offers: catalog.offersById }, settings.shipping);
  if (!priced.ok) throw new HttpError(409, priced.errors[0], { errors: priced.errors });

  // Coupon: re-checked on the server; the browser's discount is never trusted.
  let coupon = null;
  if (input.coupon) {
    const r = await evaluateCoupon(env, input.coupon, priced, { uid, phone, settings });
    if (!r.ok) throw new HttpError(422, r.error, { fields: { coupon: r.error }, code: 'coupon_invalid' });
    coupon = r;
    priced.discount = r.discount;
    priced.shipping = r.shipping;
    priced.total = r.total;
  }

  const c = { name: input.customer.name, phone, phone_verified: phoneVerified, email: profile.email_verified ? profile.email : null };
  const a = input.address;
  const now = nowIso();
  let orderNo = null, rzpOrder = null;
  for (let attempt = 0; attempt < 5 && !orderNo; attempt++) {
    const candidate = newOrderNo();
    const { value, etag } = await d.getWithEtag(`orders/${candidate}/order_no`);
    if (value) continue;
    // Claim the order number atomically before anything else.
    if (await d.putIfMatch(`orders/${candidate}/order_no`, candidate, etag)) orderNo = candidate;
  }
  if (!orderNo) throw new HttpError(503, 'Could not create the order, please try again.');
  const stock = stockNeeds(priced.lines, catalog);
  if (Object.keys(stock).length) {
    const r = await reserveStock(env, stock);
    if (!r.ok) {
      await d.remove(`orders/${orderNo}`);
      const name = catalog.productsById[r.failed]?.name || 'An item';
      throw new HttpError(409, `${name} just sold out. Please update your cart.`, { code: 'out_of_stock' });
    }
  }
  if (coupon && !(await claimCoupon(env, coupon.code, orderNo, { uid, phone, discount: coupon.discount }))) {
    await releaseStock(env, stock);
    await d.remove(`orders/${orderNo}`);
    throw new HttpError(409, 'This code has just been fully used. Please remove it and try again.', { fields: { coupon: 'Fully used.' }, code: 'coupon_invalid' });
  }

  if (input.payment_method === 'razorpay') {
    try {
      rzpOrder = await createRazorpayOrder(env, { amount: priced.total, receipt: orderNo, notes: { order_no: orderNo } });
    } catch (e) {
      if (coupon) await releaseCoupon(env, coupon.code, orderNo).catch(() => {});
      await releaseStock(env, stock).catch(() => {});
      await d.remove(`orders/${orderNo}`);
      throw e;
    }
  }

  const record = {
    order_no: orderNo, created_at: now, updated_at: now, status: 'placed', uid,
    customer_name: c.name, phone: c.phone, phone_verified: c.phone_verified, email: c.email, whatsapp_status: c.phone_verified ? (profile.whatsapp_status || 'unknown') : 'unknown',
    address_line1: a.line1, address_line2: a.line2, landmark: a.landmark, city: a.city, state: a.state, pincode: a.pincode,
    lat: a.lat ?? null, lng: a.lng ?? null, location_accuracy: a.accuracy ?? null,
    notes: input.notes,
    subtotal: priced.subtotal, compare_total: priced.compare_total, savings: priced.savings, shipping: priced.shipping, total: priced.total,
    discount: priced.discount || 0, coupon_code: coupon?.code || null,
    stock_held: Object.keys(stock).length ? stock : null,
    payment_method: input.payment_method, payment_status: 'pending',
    razorpay_order_id: rzpOrder?.id || null, razorpay_payment_id: null,
    courier: null, tracking_no: null, tracking_url: null,
    idempotency_key: input.idempotency_key,
    items: priced.lines,
    events: { [pushKey()]: event('status', 'placed', input.payment_method === 'cod' ? 'Cash on Delivery' : 'Awaiting online payment', 'customer') },
  };
  const updates = { [`orders/${orderNo}`]: record };
  if (idemPath) updates[idemPath] = orderNo;
  if (rzpOrder) updates[`order_index/rzp/${safeKey(rzpOrder.id)}`] = orderNo;
  updates[`user_orders/${uid}/${orderNo}`] = now;
  updates[`order_index/phone/${c.phone}/${orderNo}`] = now;
  if (!profile.name) updates[`users/${uid}/name`] = c.name;
  await d.patch('', updates);
  if (input.save_address) {
    try {
      const dup = Object.values(profile.addresses || {}).some((x) => String(x.line1).toLowerCase() === a.line1.toLowerCase() && x.pincode === a.pincode);
      if (!dup) await saveAddress(env, uid, profile, { ...a, name: c.name, label: input.address_label });
    } catch (e) {
      console.error('save address after order failed', e?.message || e); // order already placed; never fail it here
    }
  }

  const { order, items } = split(record);
  const body = { order: publicSummary(order, items) };
  if (rzpOrder) {
    body.razorpay = checkoutPayload(env, order, rzpOrder, settings.store.name);
  } else {
    background(ctx, notifyOrderEvent(env, order, items, 'order_placed', { admin: true }));
  }
  return json(body, 201);
}

/** Mark an online order paid exactly once (compare-and-set), then notify. */
async function markPaid(env, ctx, orderNo, paymentId, actor) {
  const d = db(env);
  const { value, etag } = await d.getWithEtag(`orders/${orderNo}/payment_status`);
  if (!value || value === 'paid') return false;
  if (!(await d.putIfMatch(`orders/${orderNo}/payment_status`, 'paid', etag))) return false;
  await d.patch(`orders/${orderNo}`, {
    razorpay_payment_id: paymentId, updated_at: nowIso(),
    [`events/${pushKey()}`]: event('payment', null, `Paid online (${paymentId})`, actor),
  });
  const fresh = await loadOrder(env, orderNo);
  background(ctx, notifyOrderEvent(env, fresh.order, fresh.items, 'order_placed', { admin: true }));
  return true;
}

export async function verifyPayment(request, env, ctx, orderNo) {
  const body = await readJson(request);
  const found = await loadOrder(env, orderNo);
  if (!found) throw new HttpError(404, 'Order not found.');
  const { order } = found;
  if (order.payment_method !== 'razorpay') throw new HttpError(400, 'This order is not an online payment.');
  if (body.razorpay_order_id !== order.razorpay_order_id) throw new HttpError(400, 'Payment does not match this order.');
  const ok = await verifyPaymentSignature({
    order_id: body.razorpay_order_id, payment_id: body.razorpay_payment_id, signature: body.razorpay_signature,
  }, env.RAZORPAY_KEY_SECRET);
  if (!ok) throw new HttpError(400, 'Payment verification failed. If money was deducted, please WhatsApp us with your order number.');
  await markPaid(env, ctx, orderNo, String(body.razorpay_payment_id).slice(0, 64), 'customer');
  const fresh = await loadOrder(env, orderNo);
  return json({ order: publicSummary(fresh.order, fresh.items) });
}

async function ownedOrder(env, orderNo, phone) {
  const found = await loadOrder(env, orderNo);
  if (!found || found.order.phone !== normalizePhone(phone)) throw new HttpError(404, 'Order not found. Check the order number and mobile number.');
  return found;
}

/** Start a fresh Razorpay attempt for an unpaid online order. */
export async function retryPayment(request, env, ctx, orderNo) {
  const body = await readJson(request);
  const { order } = await ownedOrder(env, orderNo, body.phone);
  if (order.payment_method !== 'razorpay' || order.payment_status === 'paid' || order.status === 'cancelled') {
    throw new HttpError(409, 'This order does not need payment.');
  }
  const settings = await getSettings(env);
  if (!(settings.payments.razorpay && integrations(env).razorpay)) throw new HttpError(422, 'Online payment is not available right now.');
  const rzp = await createRazorpayOrder(env, { amount: order.total, receipt: order.order_no, notes: { order_no: order.order_no } });
  await db(env).patch('', {
    [`orders/${orderNo}/razorpay_order_id`]: rzp.id,
    [`orders/${orderNo}/updated_at`]: nowIso(),
    [`order_index/rzp/${safeKey(rzp.id)}`]: orderNo,
  });
  return json({ razorpay: checkoutPayload(env, order, rzp, settings.store.name) });
}

/** Customer abandoned online payment and wants Cash on Delivery instead. */
export async function switchToCod(request, env, ctx, orderNo) {
  const body = await readJson(request);
  const { order } = await ownedOrder(env, orderNo, body.phone);
  if (order.payment_method !== 'razorpay' || order.payment_status === 'paid' || order.status === 'cancelled') {
    throw new HttpError(409, 'This order cannot be changed.');
  }
  const settings = await getSettings(env);
  if (!settings.payments.cod) throw new HttpError(422, 'Cash on Delivery is not available right now.');
  await db(env).patch(`orders/${orderNo}`, {
    payment_method: 'cod', payment_status: 'pending', updated_at: nowIso(),
    [`events/${pushKey()}`]: event('payment', null, 'Switched to Cash on Delivery', 'customer'),
  });
  const fresh = await loadOrder(env, orderNo);
  background(ctx, notifyOrderEvent(env, fresh.order, fresh.items, 'order_placed', { admin: true }));
  return json({ order: publicSummary(fresh.order, fresh.items) });
}

export async function razorpayWebhook(request, env, ctx) {
  const raw = await readText(request, 256 * 1024);
  const ok = await verifyWebhookSignature(raw, request.headers.get('x-razorpay-signature'), env.RAZORPAY_WEBHOOK_SECRET);
  if (!ok) throw new HttpError(401, 'Invalid signature');
  let evt;
  try { evt = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (evt.event === 'payment.captured' || evt.event === 'order.paid') {
    const pay = evt.payload?.payment?.entity;
    const rzpOrderId = pay?.order_id || evt.payload?.order?.entity?.id;
    if (rzpOrderId) {
      const orderNo = await db(env).get(`order_index/rzp/${safeKey(rzpOrderId)}`);
      if (orderNo) await markPaid(env, ctx, orderNo, String(pay?.id || 'webhook').slice(0, 64), 'razorpay');
    }
  }
  return json({ ok: true });
}

export async function trackOrder(request, env) {
  if (!(await rateLimit(env, `track:${clientIp(request)}`, TRACK_LIMIT_PER_HOUR, 3600))) {
    throw new HttpError(429, 'Too many lookups. Please try again later.');
  }
  const url = new URL(request.url);
  const orderNo = String(url.searchParams.get('order_no') || '').trim().toUpperCase();
  const { order, items, events } = await ownedOrder(env, orderNo, url.searchParams.get('phone'));
  return json({
    order: {
      ...publicSummary(order, items),
      city: order.city, state: order.state, pincode: order.pincode,
      courier: order.courier, tracking_no: order.tracking_no, tracking_url: order.tracking_url,
      timeline: events.filter((e) => e.type === 'status' || e.type === 'payment')
        .map((e) => ({ at: e.created_at, type: e.type, status: e.status, label: e.type === 'payment' ? 'Payment update' : STATUS_LABELS[e.status] || e.status })),
    },
  });
}

// ------------------------------------------------------------------ admin

/** Newest orders first (without events), scanning at most ADMIN_SCAN_LIMIT. */
async function recentOrders(env, sinceIso) {
  const query = sinceIso ? { orderBy: 'created_at', startAt: sinceIso } : { orderBy: 'created_at', limitToLast: ADMIN_SCAN_LIMIT };
  const map = (await db(env).get('orders', query)) || {};
  return Object.values(map)
    .filter((o) => o && o.order_no && o.created_at)
    .map(({ events, items, ...o }) => ({ ...o, item_count: values(items).length, items: values(items) }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** Apply the admin list filters (status, payment, q, from, to) — shared by the list and the CSV export. */
function filterOrders(rows, p) {
  const status = p('status');
  if (status && STATUSES.includes(status)) rows = rows.filter((o) => o.status === status);
  if (p('payment') === 'cod_due') rows = rows.filter((o) => o.payment_method === 'cod' && o.payment_status !== 'paid' && o.status !== 'cancelled');
  if (p('payment') === 'unpaid_online') rows = rows.filter((o) => o.payment_method === 'razorpay' && o.payment_status !== 'paid');
  const q = p('q').trim().toLowerCase().slice(0, 60);
  if (q) {
    const digits = q.replace(/\D/g, '');
    rows = rows.filter((o) => o.order_no.toLowerCase().includes(q) || String(o.customer_name).toLowerCase().includes(q)
      || String(o.email || '').toLowerCase().includes(q) || (digits.length >= 4 && String(o.phone).includes(digits)));
  }
  // Dates are IST calendar days.
  if (p('from') && !Number.isNaN(Date.parse(p('from')))) { const f = new Date(Date.parse(p('from') + 'T00:00:00+05:30')).toISOString(); rows = rows.filter((o) => o.created_at >= f); }
  if (p('to') && !Number.isNaN(Date.parse(p('to')))) { const t = new Date(Date.parse(p('to') + 'T00:00:00+05:30') + 86400000).toISOString(); rows = rows.filter((o) => o.created_at < t); }
  return rows;
}

export async function adminListOrders(request, env) {
  const url = new URL(request.url);
  const p = (k) => url.searchParams.get(k) || '';
  const rows = filterOrders(await recentOrders(env), p);

  const page = Math.max(1, Math.floor(Number(p('page')) || 1));
  const size = 20;
  return json({ orders: rows.slice((page - 1) * size, page * size).map(({ items, ...o }) => o), total: rows.length, page, page_size: size });
}

export async function adminGetOrder(env, orderNo) {
  const found = await loadOrder(env, orderNo);
  if (!found) throw new HttpError(404, 'Order not found.');
  const log = (await db(env).get('notifications', { orderBy: 'order_no', equalTo: orderNo })) || {};
  const notifications = Object.entries(log).map(([id, n]) => ({ id, ...n, html: undefined, body: undefined }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return json({ order: found.order, items: found.items, events: found.events, notifications, payment_label: paymentLabel(found.order) });
}

const LOCKED_FOR_CANCEL = ['shipped', 'out_for_delivery', 'delivered'];
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);

export async function adminUpdateOrder(request, env, ctx, orderNo, admin) {
  const body = await readJson(request);
  if (admin && !admin.areas?.includes('*') && !admin.areas?.includes('payments_edit') && 'payment_status' in body) throw new HttpError(403, 'You can update status and tracking, but not payments. Ask the owner.', { code: 'forbidden' });
  const found = await loadOrder(env, orderNo);
  if (!found) throw new HttpError(404, 'Order not found.');
  const { order } = found;
  const patch = {};
  const events = [];

  if (body.status && body.status !== order.status) {
    if (!STATUSES.includes(body.status)) throw new HttpError(422, 'Unknown status.');
    if (order.status === 'cancelled') throw new HttpError(409, 'This order is cancelled.');
    if (body.status === 'cancelled' && LOCKED_FOR_CANCEL.includes(order.status)) throw new HttpError(409, 'A shipped order cannot be cancelled.');
    // Orders only move forward (placed → confirmed → packed → shipped → out for delivery → delivered).
    const FLOW = STATUSES.filter((x) => x !== 'cancelled');
    if (body.status !== 'cancelled' && FLOW.indexOf(body.status) < FLOW.indexOf(order.status)) {
      throw new HttpError(409, `This order is already ${STATUS_LABELS[order.status] || order.status}. It can't be moved back to ${STATUS_LABELS[body.status] || body.status}.`, { fields: { status: 'Pick the current or a later step.' } });
    }
    patch.status = body.status;
    events.push(event('status', body.status, str(body.note, 500), admin.email));
  } else if (str(body.note, 500)) {
    events.push(event('note', null, str(body.note, 500), admin.email));
  }

  let trackingChanged = false;
  for (const k of ['courier', 'tracking_no']) {
    if (k in body && (body[k] ?? '') !== (order[k] ?? '')) { patch[k] = str(body[k], 80) || null; trackingChanged = true; }
  }
  if ('tracking_url' in body && (body.tracking_url ?? '') !== (order.tracking_url ?? '')) {
    const u = str(body.tracking_url, 300) || null;
    if (u && !/^https?:\/\//i.test(u)) throw new HttpError(422, 'Tracking link must start with https://', { fields: { tracking_url: 'Must start with https://' } });
    patch.tracking_url = u;
    trackingChanged = true;
  }
  if (trackingChanged) events.push(event('tracking', null, [body.courier, body.tracking_no].filter(Boolean).join(' · ') || 'Tracking updated', admin.email));

  if (body.payment_status && body.payment_status !== order.payment_status) {
    if (!PAYMENT_STATUSES.includes(body.payment_status)) throw new HttpError(422, 'Unknown payment status.');
    patch.payment_status = body.payment_status;
    events.push(event('payment', null, `Payment marked ${body.payment_status}`, admin.email));
  }

  if (!Object.keys(patch).length && !events.length) throw new HttpError(400, 'Nothing changed.');

  patch.updated_at = nowIso();
  const base = Date.now();
  events.forEach((e, i) => { patch[`events/${pushKey(base + i)}`] = e; });
  await db(env).patch(`orders/${orderNo}`, patch);
  if (patch.status === 'cancelled' && order.coupon_code) await releaseCoupon(env, order.coupon_code, orderNo).catch((e) => console.error('release coupon', e));
  if (patch.status === 'cancelled' && order.stock_held) {
    await releaseStock(env, order.stock_held).catch((e) => console.error('release stock', e));
    await db(env).patch(`orders/${orderNo}`, { stock_held: null });
  }

  const notify = body.notify || {};
  let sent = [];
  if (patch.status && (notify.whatsapp || notify.email)) {
    const fresh = await loadOrder(env, orderNo);
    // Wait here so the admin immediately sees whether messages went out.
    sent = await notifyOrderEvent(env, fresh.order, fresh.items, patch.status, { whatsapp: !!notify.whatsapp, email: !!notify.email });
  }
  const data = await (await adminGetOrder(env, orderNo)).json();
  return json({ ...data, sent });
}

export async function adminNotifyOrder(request, env, orderNo) {
  const body = await readJson(request);
  const found = await loadOrder(env, orderNo);
  if (!found) throw new HttpError(404, 'Order not found.');
  const ev = body.event || found.order.status;
  const sent = await notifyOrderEvent(env, found.order, found.items, ev === 'placed' ? 'order_placed' : ev, {
    whatsapp: body.whatsapp !== false, email: body.email !== false, admin: !!body.admin,
  });
  return json({ sent });
}

export async function adminStats(env) {
  const now = Date.now();
  const since7 = new Date(now - 7 * 86400000).toISOString();
  const since30 = new Date(now - 30 * 86400000).toISOString();
  const istMidnight = new Date(Math.floor((now + 5.5 * 3600e3) / 86400e3) * 86400e3 - 5.5 * 3600e3).toISOString();
  const [orders, notes] = await Promise.all([
    recentOrders(env),
    db(env).get('notifications', { orderBy: 'created_at', startAt: since7 }),
  ]);
  const by_status = {};
  for (const o of orders) by_status[o.status] = (by_status[o.status] || 0) + 1;
  const counted = orders.filter((o) => o.status !== 'cancelled' && (o.payment_method === 'cod' || o.payment_status === 'paid'));
  const sum = (list) => list.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const today = orders.filter((o) => o.created_at >= istMidnight);
  const cod = orders.filter((o) => o.payment_method === 'cod' && o.payment_status !== 'paid' && o.status !== 'cancelled');
  const cat = await loadCatalog(env);
  const low_stock = cat.products.filter((p) => p.stock != null && p.stock <= p.low_stock_at).map((p) => ({ id: p.id, name: p.name, stock: p.stock }));
  return json({
    by_status,
    low_stock,
    revenue_7d: sum(counted.filter((o) => o.created_at >= since7)),
    revenue_30d: sum(counted.filter((o) => o.created_at >= since30)),
    orders_30d: counted.filter((o) => o.created_at >= since30).length,
    today: { n: today.length, amount: sum(today) },
    cod_due: { n: cod.length, amount: sum(cod) },
    recent: orders.slice(0, 8).map(({ order_no, created_at, customer_name, total, status, payment_method, payment_status }) =>
      ({ order_no, created_at, customer_name, total, status, payment_method, payment_status })),
    failed_notifications_7d: values(notes).filter((n) => n.status === 'failed' && !n.dismissed_at).length,
  });
}


/** POST /api/coupons/check { code, items } — signed-in customers check a code before placing the order. */
export async function checkCoupon(request, env) {
  const { uid, profile } = await requireCustomer(request, env);
  const body = await readJson(request);
  const [settings, catalog] = await Promise.all([getSettings(env), loadCatalog(env)]);
  const priced = priceCart(body.items, { products: catalog.productsById, offers: catalog.offersById }, settings.shipping);
  if (!priced.ok) throw new HttpError(409, priced.errors[0]);
  const phone = profile.phone_verified ? profile.phone : normalizePhone(body.phone);
  const r = await evaluateCoupon(env, body.code, priced, { uid, phone, settings });
  if (!r.ok) throw new HttpError(422, r.error, { code: 'coupon_invalid' });
  return json({ coupon: { code: r.code, discount: r.discount, shipping: r.shipping, total: r.total, message: r.message, summary: r.summary } });
}


// ------------------------------------------------------------------ CSV export

const csvCell = (v) => {
  let t = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // stop spreadsheets running it as a formula
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const istDate = (iso) => new Date(Date.parse(iso) + 330 * 60000).toISOString().replace('T', ' ').slice(0, 16);

/** GET /api/admin/exports/orders.csv?status=&payment=&q=&from=&to= — one row per order (IST times). */
export async function adminExportOrders(request, env) {
  const url = new URL(request.url);
  const p = (k) => url.searchParams.get(k) || '';
  const rows = filterOrders(await recentOrders(env), p);
  const head = ['Order no', 'Date (IST)', 'Status', 'Customer', 'Mobile', 'Email', 'Address', 'City', 'State', 'Pincode', 'Items', 'Item count',
    'Subtotal', 'Coupon', 'Discount', 'Shipping', 'Total', 'Payment method', 'Payment status', 'Courier', 'Tracking no', 'Invoice no', 'Customer note'];
  const lines = [head.map(csvCell).join(',')];
  for (const o of rows) {
    const items = (o.items || []).map((i) => `${i.qty} x ${i.name}`).join('; ');
    const count = (o.items || []).reduce((n, i) => n + (Number(i.qty) || 0), 0);
    lines.push([o.order_no, istDate(o.created_at), STATUS_LABELS[o.status] || o.status, o.customer_name, o.phone, o.email || '',
      [o.address_line1, o.address_line2, o.landmark].filter(Boolean).join(', '), o.city, o.state, o.pincode, items, count,
      o.subtotal, o.coupon_code || '', o.discount || 0, o.shipping, o.total, o.payment_method === 'cod' ? 'Cash on Delivery' : 'Online',
      o.payment_status, o.courier || '', o.tracking_no || '', o.invoice?.number || '', o.notes || ''].map(csvCell).join(','));
  }
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  return new Response('\ufeff' + lines.join('\r\n') + '\r\n', { // BOM so Excel shows ₹ and Indian names correctly
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="gomo-orders-${stamp}.csv"`, 'cache-control': 'no-store' },
  });
}
