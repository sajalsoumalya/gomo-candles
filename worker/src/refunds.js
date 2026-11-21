// Online payments that need a second look, and refunds.
//
// Payment check: the customer's browser is not the only proof of payment. Before an unpaid online order is
// auto-cancelled, before a new payment attempt is started, and when anyone presses "Check payment", the
// server asks Razorpay directly (every Razorpay order this order ever had) and records a captured payment.
//
// Refunds: cancelling a paid online order never moves money by itself. The order gets
//   refund.status = 'review'      "Refund: awaiting review"   (nothing sent yet)
// and only an admin with the payments permission pressing "Process refund" starts it at Razorpay:
//   refund.status = 'processing'  "Refund initiated"          (Razorpay accepted it)
//   refund.status = 'processed'   "Refunded"                  (Razorpay confirmed: webhook, refresh or cron)
//   refund.status = 'failed'      "Refund failed"             (can be tried again)

import { HttpError, json, nowIso, readJson, clientIp } from './util.js';
import { db, pushKey, rateLimit, safeKey, values } from './db.js';
import { razorpayConfigured, fetchOrderPayments, createRefund, fetchRefund } from './razorpay.js';
import { loadOrder, markPaid, publicSummaryOf } from './orders.js';
import { normalizePhone } from './validate.js';

const OPEN_REFUNDS = 'order_index/refunds_open'; // {order_no: true} refunds waiting for Razorpay to finish
const event = (type, status, note, actor) => ({ created_at: nowIso(), type, status: status ?? null, note: note ?? null, actor: actor ?? null });
const rupees = (paise) => Math.round(Number(paise) || 0) / 100;

/** Fields that put a paid online order into "Refund: awaiting review". */
export function refundReviewFields(order, reason) {
  if (order.payment_method !== 'razorpay' || order.payment_status !== 'paid') return {};
  if (order.refund && ['processing', 'processed'].includes(order.refund.status)) return {};
  return {
    refund_due: true,
    refund: { status: 'review', amount: Number(order.total) || 0, reason: String(reason || '').slice(0, 200), requested_at: nowIso(), attempt: order.refund?.attempt || 1 },
  };
}

// ------------------------------------------------------------------ payment check

/** Razorpay order ids this order has used (one per payment attempt). */
export function razorpayOrderIds(order) {
  const ids = new Set(values(order.razorpay_order_ids).filter(Boolean));
  if (order.razorpay_order_id) ids.add(order.razorpay_order_id);
  return [...ids];
}

/**
 * Ask Razorpay whether this order was actually paid. Records a captured payment (once) and returns
 * { paid, payment_id, state } where state is 'paid' | 'authorized' | 'not_paid' | 'unknown'.
 */
export async function reconcilePayment(env, ctx, orderNo, actor = 'system', f = fetch) {
  if (!razorpayConfigured(env)) return { paid: false, state: 'not_configured' };
  const found = await loadOrder(env, orderNo);
  if (!found) throw new HttpError(404, 'Order not found.');
  const { order } = found;
  if (order.payment_method !== 'razorpay' && !razorpayOrderIds(order).length) return { paid: false, state: 'not_online' };
  if (order.payment_status === 'paid' || order.payment_status === 'refunded') return { paid: true, state: 'paid', payment_id: order.razorpay_payment_id || null, already: true };
  let authorized = false;
  for (const id of razorpayOrderIds(order)) {
    const payments = await fetchOrderPayments(env, id, f);
    const captured = payments.find((p) => p.status === 'captured' || (p.captured === true && p.status !== 'refunded'));
    if (captured) {
      await markPaid(env, ctx, orderNo, String(captured.id).slice(0, 64), actor, { amount: rupees(captured.amount), source: 'Razorpay check' });
      return { paid: true, state: 'paid', payment_id: captured.id };
    }
    if (payments.some((p) => p.status === 'authorized')) authorized = true;
  }
  // "authorized" = the bank approved it but Razorpay hasn't captured it yet (it does so automatically, or
  // returns the money to the customer by itself if it is never captured).
  return { paid: false, state: authorized ? 'authorized' : 'not_paid' };
}

/** Customer: "Already paid? Check payment" on the payment-pending screen. */
export async function checkPayment(request, env, ctx, orderNo) {
  if (!(await rateLimit(env, `paycheck:${clientIp(request)}`, 20, 3600))) throw new HttpError(429, 'Too many checks. Please try again in a while.');
  const body = await readJson(request);
  const found = await loadOrder(env, orderNo);
  if (!found || found.order.phone !== normalizePhone(body.phone)) throw new HttpError(404, 'Order not found. Check the order number and mobile number.');
  const r = await reconcilePayment(env, ctx, orderNo, 'customer');
  const fresh = await loadOrder(env, orderNo);
  return json({ ...r, order: publicSummaryOf(fresh.order, fresh.items) });
}

/** Admin: "Check payment with Razorpay". */
export async function adminCheckPayment(env, ctx, orderNo, admin) {
  const r = await reconcilePayment(env, ctx, orderNo, admin?.email || 'admin');
  return json(r);
}

// ------------------------------------------------------------------ refunds

const STALE_CLAIM_MS = 2 * 60 * 1000;
// 'processing' with no Razorpay refund id and an old claim = the request died half-way (database or Worker error).
// Pressing again is safe: the same attempt reuses the same idempotency key, so Razorpay never refunds twice.
const canRefundAgain = (rf, now = Date.now()) => !rf?.status || rf.status === 'review' || rf.status === 'failed'
  || (rf.status === 'processing' && !rf.refund_id && (!rf.claimed_at || now - Date.parse(rf.claimed_at) > STALE_CLAIM_MS));

/** Admin: "Process refund". Body: { amount?, note? } (amount in whole rupees, defaults to the full total). */
export async function adminProcessRefund(request, env, orderNo, admin, f = fetch) {
  const body = await readJson(request).catch(() => ({}));
  const d = db(env);
  const found = await loadOrder(env, orderNo);
  if (!found) throw new HttpError(404, 'Order not found.');
  const { order } = found;
  if (order.payment_method !== 'razorpay' && !order.razorpay_payment_id) throw new HttpError(409, 'This is a Cash on Delivery order: there is no online payment to refund.');
  if (order.payment_status === 'refunded') throw new HttpError(409, 'This order is already refunded.');
  if (order.payment_status !== 'paid' || !order.razorpay_payment_id) throw new HttpError(409, 'No captured online payment is recorded for this order. Press "Check payment with Razorpay" first.');
  if (order.status !== 'cancelled' && order.refund?.status !== 'review') throw new HttpError(409, 'Cancel the order first, then process the refund.');
  if (!razorpayConfigured(env)) throw new HttpError(503, 'Razorpay is not connected on the server.');

  const total = Number(order.total) || 0;
  const amount = body.amount === undefined || body.amount === '' || body.amount === null ? total : Number(body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > total) {
    throw new HttpError(422, `Refund amount must be whole rupees from ₹1 to ₹${total}.`, { fields: { amount: `₹1 – ₹${total}` } });
  }

  // Claim the refund exactly once (two admins, double click): review/failed → processing.
  const refundPath = `orders/${orderNo}/refund`;
  const { value: current, etag } = await d.getWithEtag(refundPath);
  if (!canRefundAgain(current)) throw new HttpError(409, current?.status === 'processed' ? 'This order is already refunded.' : 'A refund for this order has already been started.');
  if (!(await d.putIfMatch(refundPath, { ...(current || {}), status: 'processing', claimed_at: nowIso() }, etag))) throw new HttpError(409, 'Someone else just started this refund. Refresh the page.');

  const prev = current || {};
  const attempt = prev.attempt || 1;
  // Same key for the same attempt: a retry after a timeout can never create a second refund.
  const idempotencyKey = `gomo-${orderNo}-refund-${attempt}`;
  const base = { ...prev, status: 'processing', claimed_at: null, amount, attempt, initiated_at: nowIso(), initiated_by: admin?.email || null, error: null };
  let r;
  try {
    r = await createRefund(env, order.razorpay_payment_id, { amount, idempotencyKey, receipt: `${orderNo}-R${attempt}`, notes: { order_no: orderNo, reason: String(body.note || prev.reason || '').slice(0, 200) } }, f);
  } catch (e) {
    // No answer from Razorpay: back to review with the same attempt number, so pressing again reuses the key.
    await d.patch(`orders/${orderNo}`, { refund: { ...base, status: prev.status === 'failed' ? 'failed' : 'review', error: 'Razorpay did not answer. Press Process refund again (it will not refund twice).' }, updated_at: nowIso() });
    throw new HttpError(502, 'Razorpay did not answer. Press Process refund again — it will not refund twice.');
  }
  const definite = r.status >= 400 && r.status < 500 && r.status !== 409 && r.status !== 429;
  if (!r.ok && !definite) {
    await d.patch(`orders/${orderNo}`, { refund: { ...base, status: prev.status === 'failed' ? 'failed' : 'review', error: `Razorpay was not sure (${r.message}). Press Process refund again (it will not refund twice).` }, updated_at: nowIso() });
    throw new HttpError(502, `Razorpay was not sure: ${r.message}. Press Process refund again — it will not refund twice.`);
  }
  if (!r.ok) {
    await d.patch(`orders/${orderNo}`, {
      refund: { ...base, status: 'failed', error: r.message, attempt: attempt + 1 }, updated_at: nowIso(),
      [`events/${pushKey()}`]: event('payment', null, `Refund failed: ${r.message}`, admin?.email || null),
    });
    throw new HttpError(502, `Razorpay refused the refund: ${r.message}`);
  }
  const done = r.data.status === 'processed';
  const patch = {
    refund: { ...base, status: done ? 'processed' : 'processing', refund_id: r.data.id, razorpay_status: r.data.status || null, ...(done ? { processed_at: nowIso() } : {}) },
    updated_at: nowIso(),
    [`events/${pushKey()}`]: event('payment', null, `Refund of ₹${amount} ${done ? 'processed' : 'initiated'} at Razorpay (${r.data.id})${body.note ? ` · ${String(body.note).slice(0, 200)}` : ''}`, admin?.email || null),
  };
  if (done) Object.assign(patch, { payment_status: 'refunded', refund_due: null, payment_attention: null });
  await d.patch(`orders/${orderNo}`, patch);
  if (!done) await d.patch(OPEN_REFUNDS, { [orderNo]: true }).catch(() => {});
  return json({ refund: patch.refund });
}

/** Apply Razorpay's refund state (from the webhook, the refresh button or the cron). */
export async function applyRefundState(env, orderNo, entity, actor = 'razorpay') {
  const found = await loadOrder(env, orderNo);
  if (!found) return null;
  const { order } = found;
  const rf = order.refund || {};
  if (!entity?.id || (rf.refund_id && rf.refund_id !== entity.id)) return rf;
  const state = entity.status; // pending | processed | failed
  if (state === 'processed' && rf.status !== 'processed') {
    const next = { ...rf, refund_id: entity.id, status: 'processed', razorpay_status: state, processed_at: nowIso(), arn: entity.acquirer_data?.arn || entity.acquirer_data?.rrn || rf.arn || null };
    await db(env).patch(`orders/${orderNo}`, {
      refund: next, payment_status: 'refunded', refund_due: null, payment_attention: null, updated_at: nowIso(),
      [`events/${pushKey()}`]: event('payment', null, `Refund of ₹${rupees(entity.amount) || rf.amount} completed by Razorpay${next.arn ? ` (bank ref ${next.arn})` : ''}`, actor),
    });
    await db(env).remove(`${OPEN_REFUNDS}/${orderNo}`).catch(() => {});
    return next;
  }
  if (state === 'failed' && rf.status !== 'failed') {
    const next = { ...rf, refund_id: entity.id, status: 'failed', razorpay_status: state, error: 'Razorpay could not complete the refund.', attempt: (rf.attempt || 1) + 1 };
    await db(env).patch(`orders/${orderNo}`, { refund: next, updated_at: nowIso(), [`events/${pushKey()}`]: event('payment', null, 'Refund failed at Razorpay', actor) });
    await db(env).remove(`${OPEN_REFUNDS}/${orderNo}`).catch(() => {});
    return next;
  }
  return rf;
}

/** Admin: "Refresh refund status". */
export async function adminRefreshRefund(env, orderNo, admin, f = fetch) {
  const found = await loadOrder(env, orderNo);
  if (!found) throw new HttpError(404, 'Order not found.');
  const { order } = found;
  if (!order.refund?.refund_id || !order.razorpay_payment_id) throw new HttpError(409, 'No refund has been started for this order.');
  const entity = await fetchRefund(env, order.razorpay_payment_id, order.refund.refund_id, f);
  const refund = await applyRefundState(env, orderNo, entity, admin?.email || 'razorpay');
  return json({ refund });
}

/** Cron: finish refunds Razorpay has completed (in case the webhook isn't set up). */
export async function pollRefunds(env, { max = 10 } = {}) {
  if (!razorpayConfigured(env)) return { checked: 0, done: [] };
  const open = Object.keys((await db(env).get(OPEN_REFUNDS)) || {});
  const done = [];
  for (const orderNo of open.slice(0, max)) {
    const found = await loadOrder(env, orderNo).catch(() => null);
    const rf = found?.order.refund;
    if (!rf?.refund_id || rf.status !== 'processing') { await db(env).remove(`${OPEN_REFUNDS}/${orderNo}`).catch(() => {}); continue; }
    const entity = await fetchRefund(env, found.order.razorpay_payment_id, rf.refund_id).catch(() => null);
    const next = entity && (await applyRefundState(env, orderNo, entity));
    if (next && next.status !== 'processing') done.push(`${orderNo}:${next.status}`);
  }
  return { checked: Math.min(open.length, max), done };
}

/** Razorpay webhook refund.* events: the refund notes carry our order number. */
export async function refundWebhook(env, evt) {
  const entity = evt.payload?.refund?.entity;
  const orderNo = entity?.notes?.order_no;
  if (!entity || typeof orderNo !== 'string' || !/^GM-\d{6}-\d{4}$/.test(orderNo)) return;
  await applyRefundState(env, orderNo, entity, 'razorpay');
}

export const _test = { safeKey };
