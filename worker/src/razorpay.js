import { HttpError, hmacSha256Hex, timingSafeEqual } from './util.js';

const API = 'https://api.razorpay.com/v1';

export function razorpayConfigured(env) {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

/** Create a Razorpay order. Amount is in whole rupees; Razorpay wants paise. */
export async function createRazorpayOrder(env, { amount, receipt, notes }, fetchImpl = fetch) {
  if (!razorpayConfigured(env)) throw new HttpError(503, 'Online payment is not available right now.');
  const res = await fetchImpl(`${API}/orders`, {
    method: 'POST',
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
