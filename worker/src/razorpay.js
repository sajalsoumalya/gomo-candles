import { HttpError, hmacSha256Hex, timingSafeEqual } from './util.js';

const API = 'https://api.razorpay.com/v1';

// Every Razorpay call gives up after 15 s, so a slow Razorpay never leaves a request (or a refund) hanging.
const timeout = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined);

export function razorpayConfigured(env) {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

/** Create a Razorpay order. Amount is in whole rupees; Razorpay wants paise. */
export async function createRazorpayOrder(env, { amount, receipt, notes }, fetchImpl = fetch) {
  if (!razorpayConfigured(env)) throw new HttpError(503, 'Online payment is not available right now.');
  const res = await fetchImpl(`${API}/orders`, {
    method: 'POST',
    signal: timeout(),
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
    },
    body: JSON.stringify({ amount: Math.round(amount * 100), currency: 'INR', receipt, notes }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    console.error('razorpay order failed', res.status, JSON.stringify(data).slice(0, 300));
    throw new HttpError(502, 'Could not start online payment. Please try again or choose Cash on Delivery.');
  }
  return data; // { id, amount, currency, ... }
}

/** Checkout signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret) */
export async function verifyPaymentSignature({ order_id, payment_id, signature }, secret) {
  if (!order_id || !payment_id || !signature || !secret) return false;
  const expected = await hmacSha256Hex(secret, `${order_id}|${payment_id}`);
  return timingSafeEqual(expected, signature);
}

/** Webhook signature: HMAC_SHA256(raw_body, webhook_secret) */
export async function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqual(expected, signature);
}

export function checkoutPayload(env, order, rzpOrder, storeName) {
  return {
    key_id: env.RAZORPAY_KEY_ID,
    order_id: rzpOrder.id,
    amount: rzpOrder.amount,
    currency: 'INR',
    name: storeName,
    description: `Order ${order.order_no}`,
    prefill: { name: order.customer_name, contact: '+91' + order.phone, email: order.email || '' },
  };
}

const basicAuth = (env) => 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
const rzpMessage = (data, status) => String(data?.error?.description || data?.error?.reason || `Razorpay replied HTTP ${status}`).slice(0, 300);

/** All payment attempts on a Razorpay order (GET /orders/:id/payments). Throws if Razorpay can't be reached. */
export async function fetchOrderPayments(env, rzpOrderId, fetchImpl = fetch) {
  if (!razorpayConfigured(env)) throw new HttpError(503, 'Razorpay is not connected.');
  const res = await fetchImpl(`${API}/orders/${encodeURIComponent(rzpOrderId)}/payments`, { headers: { authorization: basicAuth(env) }, signal: timeout() });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(502, `Couldn't check the payment with Razorpay: ${rzpMessage(data, res.status)}`);
  return Array.isArray(data?.items) ? data.items : [];
}

/**
 * Refund a captured payment (POST /payments/:id/refund). Amount in whole rupees. The idempotency key makes a
 * retry after a timeout safe: Razorpay creates the refund only once for the same key and body.
 * Returns { ok, status, data, message }; never throws for Razorpay's own errors (network errors do throw).
 */
export async function createRefund(env, paymentId, { amount, idempotencyKey, notes, receipt }, fetchImpl = fetch) {
  if (!razorpayConfigured(env)) throw new HttpError(503, 'Razorpay is not connected.');
  const res = await fetchImpl(`${API}/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: basicAuth(env), 'x-refund-idempotency': idempotencyKey },
    signal: timeout(),
    body: JSON.stringify({ amount: Math.round(amount * 100), speed: 'normal', notes, receipt }),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && data?.entity === 'refund', status: res.status, data, message: res.ok ? null : rzpMessage(data, res.status) };
}

/** Current state of a refund: pending | processed | failed. */
export async function fetchRefund(env, paymentId, refundId, fetchImpl = fetch) {
  if (!razorpayConfigured(env)) throw new HttpError(503, 'Razorpay is not connected.');
  const res = await fetchImpl(`${API}/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`, { headers: { authorization: basicAuth(env) }, signal: timeout() });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(502, `Couldn't read the refund from Razorpay: ${rzpMessage(data, res.status)}`);
  return data;
}
