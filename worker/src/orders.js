import { HttpError, json, newOrderNo, nowIso, readJson, readText, clientIp, STATUSES, STATUS_LABELS, PAYMENT_STATUSES } from './util.js';
import { priceCart, shippingFor, shippingRuleFor } from './pricing.js';
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
import { refundReviewFields, reconcilePayment, refundWebhook } from './refunds.js';
import { shiprocketReady, cancelShipmentForCancelledOrder } from './shiprocket.js';

const ORDER_LIMIT_PER_HOUR = 10;      // per signed-in account
const ORDER_IP_LIMIT_PER_HOUR = 60;   // per IP: mobile networks put many customers behind one address
const PAY_RETRY_LIMIT_PER_HOUR = 30;  // retry-payment / switch-to-COD per IP
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

export const publicSummaryOf = (order, items) => publicSummary(order, items);

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
  if (!(await rateLimit(env, `order:${clientIp(request)}`, ORDER_IP_LIMIT_PER_HOUR, 3600))
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

  const shipRule = shippingRuleFor(settings.shipping, input.payment_method);
  const priced = priceCart(input.items, { products: catalog.productsById, offers: catalog.offersById }, shipRule);
  if (!priced.ok) throw new HttpError(409, priced.errors[0], { errors: priced.errors });

  // Coupon: re-checked on the server; the browser's discount is never trusted.
  let coupon = null;
  if (input.coupon) {
    const r = await evaluateCoupon(env, input.coupon, priced, { uid, phone, settings: { ...settings, shipping: shipRule } });
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
    razorpay_order_ids: rzpOrder ? { [safeKey(rzpOrder.id)]: rzpOrder.id } : null,
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

// ------------------------------------------------------------------ unpaid online orders
// An online order takes its stock and coupon use when it is placed. If the customer never pays,
// the scheduled job cancels it after UNPAID_HOLD_MIN minutes and gives both back.
export const UNPAID_HOLD_MIN = 30;

/** Give an order's held stock back exactly once (compare-and-set on stock_held). Returns what was released. */
export async function releaseHeldStock(env, orderNo) {
  const d = db(env);
  for (let i = 0; i < 5; i++) {
    const { value, etag } = await d.getWithEtag(`orders/${orderNo}/stock_held`);
    if (!value) return null;
    if (await d.putIfMatch(`orders/${orderNo}/stock_held`, null, etag)) { await releaseStock(env, value); return value; }
  }
  return null;
}

export async function expireUnpaidOrders(env, { now = Date.now(), minutes = UNPAID_HOLD_MIN, ctx = null } = {}) {
  const d = db(env);
  const cutoff = new Date(now - minutes * 60000).toISOString();
  const since = new Date(now - 14 * 86400000).toISOString();
  const map = (await d.get('orders', { orderBy: 'created_at', startAt: since, endAt: cutoff })) || {};
  const out = { checked: 0, expired: [] };
  for (const o of Object.values(map)) {
    if (!o?.order_no || o.payment_method !== 'razorpay' || o.payment_status !== 'pending' || o.status !== 'placed') continue;
    out.checked++;
    if ((o.updated_at || o.created_at) > cutoff) continue; // a payment retry started recently
    const no = o.order_no;
    // Money may have left the customer's account even though the browser never reported back: ask Razorpay first.
    const check = await reconcilePayment(env, ctx, no, 'system').catch((e) => ({ state: 'unknown', error: e?.message }));
    if (check.paid) { out.paid = [...(out.paid || []), no]; continue; }
    // Bank approved but not captured yet, or Razorpay unreachable: wait (up to 6 hours), then expire as usual.
    // A payment that turns up later is still recorded and the order goes to "Refund: awaiting review".
    if ((check.state === 'authorized' || check.state === 'unknown') && now - Date.parse(o.created_at) < 6 * 3600e3) continue;
    // cancel exactly once, and never one that was just paid
    const { value: status, etag } = await d.getWithEtag(`orders/${no}/status`);
    if (status !== 'placed') continue;
    if ((await d.get(`orders/${no}/payment_status`)) !== 'pending') continue;
    if ((await d.get(`orders/${no}/payment_method`)) !== 'razorpay') continue; // switched to Cash on Delivery meanwhile
    if (!(await d.putIfMatch(`orders/${no}/status`, 'cancelled', etag))) continue;
    const released = await releaseHeldStock(env, no);
    if (o.coupon_code) await releaseCoupon(env, o.coupon_code, no).catch((e) => console.error('release coupon', e));
    await d.patch(`orders/${no}`, {
      expired_unpaid: true, stock_released: released || null, updated_at: nowIso(),
      [`events/${pushKey()}`]: event('status', 'cancelled', `Online payment not completed within ${minutes} minutes. Stock released.`, 'system'),
    });
    // A payment may have landed between our check and the cancel (markPaid then saw the order still "placed").
    if ((await d.get(`orders/${no}/payment_status`)) === 'paid') {
      await restorePaidAfterCancel(env, ctx, no, 'system');
      out.restored = [...(out.restored || []), no];
      continue;
    }
    out.expired.push(no);
  }
  return out;
}

/** Mark an online order paid exactly once (compare-and-set), then notify. */
/**
 * A paid order that is cancelled. If it only expired for being unpaid and the stock is still there, it comes back;
 * otherwise it goes to "Refund: awaiting review". Either way the admin is told.
 */
async function restorePaidAfterCancel(env, ctx, orderNo, actor) {
  const d = db(env);
  const { order } = await loadOrder(env, orderNo);
  if (order.status !== 'cancelled') return false;
  const need = order.stock_released;
  const back = order.expired_unpaid && (!need || (await reserveStock(env, need)).ok);
  await d.patch(`orders/${orderNo}`, back
    ? { status: 'placed', stock_held: need || null, stock_released: null, expired_unpaid: null, updated_at: nowIso(),
        [`events/${pushKey()}`]: event('status', 'placed', 'Payment arrived after the order had expired, so it was restored.', actor) }
    : { payment_attention: true, updated_at: nowIso(), ...refundReviewFields(order, 'Paid after the order was cancelled'),
        [`events/${pushKey()}`]: event('note', null, 'Paid after the order was cancelled. Refund awaiting review.', actor) });
  const fresh = await loadOrder(env, orderNo);
  background(ctx, back
    ? notifyOrderEvent(env, fresh.order, fresh.items, 'order_placed', { admin: true })
    : notifyOrderEvent(env, fresh.order, fresh.items, 'cancelled', { whatsapp: false, email: false, admin: true, adminNote: 'was paid online after it had been cancelled' }));
  return back;
}

export async function markPaid(env, ctx, orderNo, paymentId, actor, { amount, source } = {}) {
  const d = db(env);
  const { value, etag } = await d.getWithEtag(`orders/${orderNo}/payment_status`);
  if (value === 'paid' || value === 'refunded') {
    // Already paid. A different captured payment = the customer was charged twice: record it once and flag it.
    const known = await d.get(`orders/${orderNo}/razorpay_payment_id`);
    if (paymentId && known && paymentId !== known && paymentId !== 'webhook' && !(await d.get(`orders/${orderNo}/extra_payments/${safeKey(paymentId)}`))) {
      await d.patch(`orders/${orderNo}`, {
        [`extra_payments/${safeKey(paymentId)}`]: { at: nowIso(), amount: amount ?? null, source: source || actor || null }, payment_attention: true, updated_at: nowIso(),
        [`events/${pushKey()}`]: event('payment', null, `Second online payment captured (${paymentId}${amount != null ? `, ₹${amount}` : ''}). The customer paid twice: refund this one from the Razorpay dashboard.`, actor),
      });
    }
    return false;
  }
  if (!value) return false;
  if (!(await d.putIfMatch(`orders/${orderNo}/payment_status`, 'paid', etag))) return false;
  const total = await d.get(`orders/${orderNo}/total`);
  const short = amount != null && Number(amount) !== Number(total);
  await d.patch(`orders/${orderNo}`, {
    razorpay_payment_id: paymentId, updated_at: nowIso(),
    ...(short ? { payment_attention: true } : {}),
    [`events/${pushKey()}`]: event('payment', null, `Paid online (${paymentId})${source ? ` · found by ${source}` : ''}${short ? ` · amount ₹${amount} differs from the order total ₹${total}` : ''}`, actor),
  });
  let fresh = await loadOrder(env, orderNo);
  if (fresh.order.payment_method === 'cod') {
    // Paid online after switching to Cash on Delivery: make it a prepaid order again so nobody collects cash.
    await d.patch(`orders/${orderNo}`, { payment_method: 'razorpay', payment_attention: true, updated_at: nowIso(),
      [`events/${pushKey()}`]: event('payment', null, `Paid online after switching to Cash on Delivery. Do NOT collect cash. Order total is ₹${fresh.order.total}; check the paid amount and refund any difference.`, actor) });
    fresh = await loadOrder(env, orderNo);
  }
  if (fresh.order.status === 'cancelled') { await restorePaidAfterCancel(env, ctx, orderNo, actor); return true; }
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

async function ownedOrder(env, orderNo, phone, request = null) {
  if (request && (!(await rateLimit(env, `payretry:${clientIp(request)}`, PAY_RETRY_LIMIT_PER_HOUR, 3600))
    || !(await rateLimit(env, `payretry:o:${orderNo}`, 10, 3600)))) {
    throw new HttpError(429, 'Too many attempts. Please try again later or WhatsApp us.');
  }
  const found = await loadOrder(env, orderNo);
  if (!found || found.order.phone !== normalizePhone(phone)) throw new HttpError(404, 'Order not found. Check the order number and mobile number.');
  return found;
}

/** Start a fresh Razorpay attempt for an unpaid online order. */
export async function retryPayment(request, env, ctx, orderNo) {
  const body = await readJson(request);
  const { order } = await ownedOrder(env, orderNo, body.phone, request);
  if (order.expired_unpaid && order.status === 'cancelled') throw new HttpError(409, `This order expired because payment wasn't completed within ${UNPAID_HOLD_MIN} minutes. Please place it again.`, { code: 'expired' });
  if (order.payment_method !== 'razorpay' || order.payment_status === 'paid' || order.status === 'cancelled') {
    throw new HttpError(409, 'This order does not need payment.');
  }
  const settings = await getSettings(env);
  if (!(settings.payments.razorpay && integrations(env).razorpay)) throw new HttpError(422, 'Online payment is not available right now.');
  // Never charge twice: if an earlier attempt was paid after all, show the order as paid instead.
  const check = await reconcilePayment(env, ctx, orderNo, 'customer').catch(() => ({ state: 'unknown' }));
  if (check.paid) {
    const fresh = await loadOrder(env, orderNo);
    return json({ already_paid: true, order: publicSummary(fresh.order, fresh.items) });
  }
  if (check.state === 'authorized') {
    throw new HttpError(409, 'Your bank has approved a payment for this order and it is being confirmed. Please wait a few minutes and press "Check payment" instead of paying again.', { code: 'payment_authorized' });
  }
  const rzp = await createRazorpayOrder(env, { amount: order.total, receipt: order.order_no, notes: { order_no: order.order_no } });
  await db(env).patch('', {
    [`orders/${orderNo}/razorpay_order_id`]: rzp.id,
    [`orders/${orderNo}/razorpay_order_ids/${safeKey(rzp.id)}`]: rzp.id,
    [`orders/${orderNo}/updated_at`]: nowIso(),
    [`order_index/rzp/${safeKey(rzp.id)}`]: orderNo,
  });
  return json({ razorpay: checkoutPayload(env, order, rzp, settings.store.name) });
}

/** Customer abandoned online payment and wants Cash on Delivery instead. */
export async function switchToCod(request, env, ctx, orderNo) {
  const body = await readJson(request);
  const { order } = await ownedOrder(env, orderNo, body.phone, request);
  if (order.expired_unpaid && order.status === 'cancelled') throw new HttpError(409, `This order expired because payment wasn't completed within ${UNPAID_HOLD_MIN} minutes. Please place it again.`, { code: 'expired' });
  if (order.payment_method !== 'razorpay' || order.payment_status === 'paid' || order.status === 'cancelled') {
    throw new HttpError(409, 'This order cannot be changed.');
  }
  const settings = await getSettings(env);
  if (!settings.payments.cod) throw new HttpError(422, 'Cash on Delivery is not available right now.');
  // The payment may have gone through even though the browser never said so: never let a paid customer pay cash too.
  const check = await reconcilePayment(env, ctx, orderNo, 'customer').catch(() => ({ state: 'unknown' }));
  if (check.paid) {
    const paid = await loadOrder(env, orderNo);
    return json({ order: publicSummary(paid.order, paid.items), already_paid: true });
  }
  if (check.state === 'authorized') throw new HttpError(409, 'Your bank has approved a payment for this order. Please wait a few minutes; it will be confirmed automatically.', { code: 'payment_authorized' });
  // free / cheaper prepaid delivery no longer applies: charge the Cash on Delivery fee
  let shipping = order.shipping || 0;
  const couponType = order.coupon_code ? (await db(env).get(`coupons/${order.coupon_code}/type`)) : null;
  if (couponType !== 'free_shipping') shipping = shippingFor((order.subtotal || 0) - (order.discount || 0), settings.shipping);
  const total = (order.total || 0) - (order.shipping || 0) + shipping;
  // Claim the switch atomically on payment_method: if the payment is marked paid meanwhile, markPaid sees "cod"
  // and turns it back to prepaid (no cash collected); if markPaid already ran, payment_status is "paid" and we stop.
  const d = db(env);
  const { value: method, etag } = await d.getWithEtag(`orders/${orderNo}/payment_method`);
  if (method !== 'razorpay' || !(await d.putIfMatch(`orders/${orderNo}/payment_method`, 'cod', etag))) throw new HttpError(409, 'This order cannot be changed.');
  if ((await d.get(`orders/${orderNo}/payment_status`)) === 'paid') {
    await d.put(`orders/${orderNo}/payment_method`, 'razorpay');
    const paid = await loadOrder(env, orderNo);
    return json({ order: publicSummary(paid.order, paid.items), already_paid: true });
  }
  await d.patch(`orders/${orderNo}`, {
    shipping, total, updated_at: nowIso(),
    [`events/${pushKey()}`]: event('payment', null, 'Switched to Cash on Delivery' + (shipping !== (order.shipping || 0) ? ` · delivery ${shipping ? '₹' + shipping : 'free'}` : ''), 'customer'),
  });
  const fresh = await loadOrder(env, orderNo);
  background(ctx, notifyOrderEvent(env, fresh.order, fresh.items, 'order_placed', { admin: true }));
  return json({ order: publicSummary(fresh.order, fresh.items) });
}

/** Signed-in customer cancels their own order. Only before it ships. */
export const CUSTOMER_CANCELLABLE = ['placed', 'confirmed', 'packed'];
export async function customerCancelOrder(request, env, ctx, orderNo) {
  const { uid } = await requireCustomer(request, env);
  const body = await readJson(request).catch(() => ({}));
  const d = db(env);
  const found = await loadOrder(env, orderNo);
  if (!found || found.order.uid !== uid) throw new HttpError(404, 'Order not found.');
  const { order } = found;
  if (order.status === 'cancelled') throw new HttpError(409, 'This order is already cancelled.');
  if (!CUSTOMER_CANCELLABLE.includes(order.status)) throw new HttpError(409, 'This order has already shipped, so it can no longer be cancelled.', { code: 'shipped' });
  // cancel exactly once, and only if it hasn't moved on meanwhile
  const { value: status, etag } = await d.getWithEtag(`orders/${orderNo}/status`);
  if (!CUSTOMER_CANCELLABLE.includes(status) || !(await d.putIfMatch(`orders/${orderNo}/status`, 'cancelled', etag))) {
    throw new HttpError(409, 'This order has already shipped, so it can no longer be cancelled.', { code: 'shipped' });
  }
  if (order.stock_held) await releaseHeldStock(env, orderNo).catch((e) => console.error('release stock', e));
  if (order.coupon_code) await releaseCoupon(env, order.coupon_code, orderNo).catch((e) => console.error('release coupon', e));
  const paid = order.payment_status === 'paid';
  const reason = str(body.reason, 300);
  await d.patch(`orders/${orderNo}`, {
    cancelled_by: 'customer', updated_at: nowIso(), ...(paid ? { refund_due: true, payment_attention: true, ...refundReviewFields(order, 'Cancelled by the customer') } : {}),
    [`events/${pushKey()}`]: event('status', 'cancelled', ['Cancelled by the customer', reason, paid ? 'Paid online: refund awaiting review' : ''].filter(Boolean).join(' · '), 'customer'),
  });
  await cancelShipmentForCancelledOrder(env, orderNo, 'customer');
  const fresh = await loadOrder(env, orderNo);
  background(ctx, notifyOrderEvent(env, fresh.order, fresh.items, 'cancelled', { admin: true }));
  return json({ order: publicSummary(fresh.order, fresh.items), refund_due: paid });
}

export async function razorpayWebhook(request, env, ctx) {
  const raw = await readText(request, 256 * 1024);
  const ok = await verifyWebhookSignature(raw, request.headers.get('x-razorpay-signature'), env.RAZORPAY_WEBHOOK_SECRET);
  if (!ok) throw new HttpError(401, 'Invalid signature');
  let evt;
  try { evt = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (/^refund\./.test(evt.event || '')) {
    await refundWebhook(env, evt);
    return json({ ok: true });
  }
  if (evt.event === 'payment.captured' || evt.event === 'order.paid') {
    const pay = evt.payload?.payment?.entity;
    const rzpOrderId = pay?.order_id || evt.payload?.order?.entity?.id;
    if (rzpOrderId) {
      const orderNo = await db(env).get(`order_index/rzp/${safeKey(rzpOrderId)}`);
      if (orderNo) await markPaid(env, ctx, orderNo, String(pay?.id || 'webhook').slice(0, 64), 'razorpay', { amount: pay?.amount != null ? Math.round(Number(pay.amount)) / 100 : undefined });
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

/**
 * Orders the admin list should look at. Normally the newest ADMIN_SCAN_LIMIT; with a "from" date, every order since
 * that day; and an exact order number or 10-digit phone is looked up directly, however old the order is.
 */
async function adminScope(env, p) {
  const f = String(p('from') || '').slice(0, 10);
  const since = /^\d{4}-\d{2}-\d{2}$/.test(f) ? new Date(Date.parse(f + 'T00:00:00+05:30')).toISOString() : null;
  const rows = await recentOrders(env, since);
  const q = String(p('q') || '').trim().toUpperCase(), digits = q.replace(/\D/g, '');
  let extra = [];
  if (/^GM-\d{6}-\d{4}$/.test(q)) extra = [q];
  else if (digits.length === 10 || (digits.length === 12 && digits.startsWith('91'))) {
    extra = Object.keys((await db(env).get(`order_index/phone/${digits.slice(-10)}`, { shallow: true })) || {});
  }
  const have = new Set(rows.map((o) => o.order_no));
  const more = await Promise.all(extra.filter((no) => !have.has(no)).slice(0, 50).map((no) => db(env).get(`orders/${no}`)));
  for (const o of more) if (o && o.order_no) { const { events, items, ...r } = o; rows.push({ ...r, item_count: values(items).length, items: values(items) }); }
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** A paid online order whose money should go back: cancelled, or a refund waiting / failed. */
const needsRefund = (o) => o.payment_status === 'paid' && o.payment_method === 'razorpay'
  && (o.status === 'cancelled' || o.refund_due || ['review', 'failed'].includes(o.refund?.status)) && o.refund?.status !== 'processed';

/** Apply the admin list filters (status, payment, q, from, to) — shared by the list and the CSV export. */
function filterOrders(rows, p) {
  const status = p('status');
  if (status && STATUSES.includes(status)) rows = rows.filter((o) => o.status === status);
  if (p('payment') === 'cod_due') rows = rows.filter((o) => o.payment_method === 'cod' && o.payment_status !== 'paid' && o.status !== 'cancelled');
  if (p('payment') === 'unpaid_online') rows = rows.filter((o) => o.payment_method === 'razorpay' && o.payment_status !== 'paid' && o.status !== 'cancelled');
  if (p('payment') === 'refund_due') rows = rows.filter(needsRefund);
  if (p('payment') === 'attention') rows = rows.filter((o) => o.payment_attention && o.payment_status !== 'refunded');
  const q = p('q').trim().toLowerCase().slice(0, 60);
  if (q) {
    const digits = q.replace(/\D/g, '');
    rows = rows.filter((o) => o.order_no.toLowerCase().includes(q) || String(o.customer_name).toLowerCase().includes(q)
      || String(o.email || '').toLowerCase().includes(q) || (digits.length >= 4 && String(o.phone).includes(digits)));
  }
  // Dates are IST calendar days.
  // Only the YYYY-MM-DD part is used, so a value with a time can't turn into an invalid date (500).
  const day = (k) => { const v = String(p(k) || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00+05:30')) ? Date.parse(v + 'T00:00:00+05:30') : null; };
  const from = day('from'), to = day('to');
  if (from != null) { const f = new Date(from).toISOString(); rows = rows.filter((o) => o.created_at >= f); }
  if (to != null) { const t = new Date(to + 86400000).toISOString(); rows = rows.filter((o) => o.created_at < t); }
  return rows;
}

export async function adminListOrders(request, env) {
  const url = new URL(request.url);
  const p = (k) => url.searchParams.get(k) || '';
  const rows = filterOrders(await adminScope(env, p), p);

  const page = Math.max(1, Math.floor(Number(p('page')) || 1));
  const size = 20;
  // value of the orders matched by the filters; cancelled orders only count when that is what was asked for
  const amount = rows.filter((o) => o.status !== 'cancelled' || p('status') === 'cancelled').reduce((s, o) => s + (Number(o.total) || 0), 0);
  return json({ orders: rows.slice((page - 1) * size, page * size).map(({ items, ...o }) => o), total: rows.length, amount, page, page_size: size });
}

/** Per customer account (uid): orders placed and money received, over the newest ADMIN_SCAN_LIMIT orders. */
export async function spendByCustomer(env) {
  const out = {};
  for (const o of await recentOrders(env)) {
    if (!o.uid || o.status === 'cancelled') continue;
    const c = (out[o.uid] ||= { n: 0, spent: 0, last_at: null });
    c.n++;
    if (o.payment_status === 'paid') c.spent += Number(o.total) || 0;
    if (!c.last_at || o.created_at > c.last_at) c.last_at = o.created_at;
  }
  return out;
}

export async function adminGetOrder(env, orderNo) {
  const found = await loadOrder(env, orderNo);
  if (!found) throw new HttpError(404, 'Order not found.');
  const log = (await db(env).get('notifications', { orderBy: 'order_no', equalTo: orderNo })) || {};
  const notifications = Object.entries(log).map(([id, n]) => ({ id, ...n, html: undefined, body: undefined }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  // Shiprocket card on the order page: is it connected, and the default parcel (staff may not open Settings)
  const sr = (await getSettings(env)).shiprocket;
  const shipping = { ready: shiprocketReady(env), parcel: { weight_kg: sr.weight_kg, length_cm: sr.length_cm, breadth_cm: sr.breadth_cm, height_cm: sr.height_cm } };
  return json({ order: found.order, items: found.items, events: found.events, notifications, payment_label: paymentLabel(found.order), shipping });
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
    if (body.status === 'cancelled') Object.assign(patch, refundReviewFields(order, 'Cancelled by the store'));
    events.push(event('status', body.status, [str(body.note, 500), patch.refund ? 'Paid online: refund awaiting review' : ''].filter(Boolean).join(' · ') || null, admin.email));
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
  if (patch.status === 'cancelled' && order.stock_held) await releaseHeldStock(env, orderNo).catch((e) => console.error('release stock', e));
  if (patch.status === 'cancelled') await cancelShipmentForCancelledOrder(env, orderNo, admin?.email || 'admin');

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
  const by_status = {}, amount_by_status = {};
  for (const o of orders) { by_status[o.status] = (by_status[o.status] || 0) + 1; amount_by_status[o.status] = (amount_by_status[o.status] || 0) + (Number(o.total) || 0); }
  const counted = orders.filter((o) => o.status !== 'cancelled' && (o.payment_method === 'cod' || o.payment_status === 'paid'));
  const sum = (list) => list.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const today = orders.filter((o) => o.created_at >= istMidnight);
  const cod = orders.filter((o) => o.payment_method === 'cod' && o.payment_status !== 'paid' && o.status !== 'cancelled');
  const refunds = orders.filter(needsRefund);
  const cat = await loadCatalog(env);
  const low_stock = cat.products.filter((p) => p.stock != null && p.stock <= p.low_stock_at).map((p) => ({ id: p.id, name: p.name, stock: p.stock }));
  return json({
    by_status,
    amount_by_status,
    low_stock,
    revenue_7d: sum(counted.filter((o) => o.created_at >= since7)),
    revenue_30d: sum(counted.filter((o) => o.created_at >= since30)),
    orders_30d: counted.filter((o) => o.created_at >= since30).length,
    today: { n: today.length, amount: sum(today) },
    cod_due: { n: cod.length, amount: sum(cod) },
    refund_due: { n: refunds.length, amount: sum(refunds) },
    attention: orders.filter((o) => o.payment_attention && o.payment_status !== 'refunded').length,
    recent: orders.slice(0, 8).map(({ order_no, created_at, customer_name, total, status, payment_method, payment_status, refund }) =>
      ({ order_no, created_at, customer_name, total, status, payment_method, payment_status, refund: refund ? { status: refund.status } : null })),
    failed_notifications_7d: values(notes).filter((n) => n.status === 'failed' && !n.dismissed_at).length,
  });
}


/** POST /api/coupons/check { code, items } — signed-in customers check a code before placing the order. */
export async function checkCoupon(request, env) {
  const { uid, profile } = await requireCustomer(request, env);
  const body = await readJson(request);
  const [settings, catalog] = await Promise.all([getSettings(env), loadCatalog(env)]);
  const shipRule = shippingRuleFor(settings.shipping, body.payment_method === 'razorpay' ? 'razorpay' : 'cod');
  const priced = priceCart(body.items, { products: catalog.productsById, offers: catalog.offersById }, shipRule);
  if (!priced.ok) throw new HttpError(409, priced.errors[0]);
  const phone = profile.phone_verified ? profile.phone : normalizePhone(body.phone);
  const r = await evaluateCoupon(env, body.code, priced, { uid, phone, settings: { ...settings, shipping: shipRule } });
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
  const rows = filterOrders(await adminScope(env, p), p);
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
