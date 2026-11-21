import { describe, it, expect, vi, afterEach } from 'vitest';
import { expireUnpaidOrders, adminUpdateOrder, retryPayment, razorpayWebhook } from '../src/orders.js';
import { reconcilePayment, adminProcessRefund, adminRefreshRefund } from '../src/refunds.js';
import { areaFor } from '../src/staff.js';
import { hmacSha256Hex } from '../src/util.js';

// In-memory RTDB (same shape as the real client: get/put/patch/remove + etag compare-and-set).
function memDb(data) {
  const root = structuredClone(data);
  const seg = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), root) ?? null;
  const put = (p, v) => {
    const ks = seg(p), last = ks.pop();
    if (last === undefined) return;
    const parent = ks.reduce((o, k) => (o[k] ??= {}), root);
    if (v == null) delete parent[last]; else parent[last] = structuredClone(v);
  };
  return {
    root,
    __db: {
      get: async (p, q) => {
        const v = get(p);
        if (q?.orderBy === 'created_at' && v) return Object.fromEntries(Object.entries(v).filter(([, o]) => o.created_at >= q.startAt && o.created_at <= q.endAt));
        if (q?.orderBy === 'order_no' && v) return Object.fromEntries(Object.entries(v).filter(([, o]) => o.order_no === q.equalTo));
        return structuredClone(v);
      },
      put: async (p, v) => put(p, v),
      patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(p ? `${p}/${k}` : k, x); },
      remove: async (p) => put(p, null),
      getWithEtag: async (p) => ({ value: structuredClone(get(p)), etag: JSON.stringify(get(p)) }),
      putIfMatch: async (p, v, etag) => { if (JSON.stringify(get(p)) !== etag) return false; put(p, v); return true; },
    },
  };
}

const NO = 'GM-261121-0001';
const KEYS = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'whsec' };
const base = (extra = {}) => ({
  order_no: NO, created_at: '2026-11-21T10:00:00.000Z', updated_at: '2026-11-21T10:00:00.000Z', status: 'placed',
  customer_name: 'Asha Roy', phone: '9876543210', email: null, payment_method: 'razorpay', payment_status: 'pending',
  razorpay_order_id: 'order_NEW', razorpay_order_ids: { order_OLD: 'order_OLD', order_NEW: 'order_NEW' },
  subtotal: 799, shipping: 0, discount: 0, total: 799, items: [{ kind: 'offer', ref_id: 'combo-trio', name: 'Combo', qty: 1, unit_price: 799, line_total: 799 }],
  events: {}, ...extra,
});
const env = (order, extra = {}) => { const m = memDb({ orders: { [NO]: order }, settings: {} }); return { m, env: { ...m, ...KEYS, ...extra } }; };
const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const req = (body) => new Request('https://x/api', { method: 'POST', body: JSON.stringify(body || {}) });
const admin = { email: 'owner@gomo.in', areas: ['*'] };

/** Razorpay stub: payments per Razorpay order id, refund responses in order. */
function razorpay({ payments = {}, refunds = [] } = {}) {
  const calls = [];
  const f = vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    const m = /\/orders\/([^/]+)\/payments$/.exec(url);
    if (m) return res(200, { entity: 'collection', items: payments[m[1]] || [] });
    if (/\/payments\/[^/]+\/refund$/.test(url)) { const next = refunds.shift(); if (next instanceof Error) throw next; return next; }
    if (/\/refunds\//.test(url)) return res(200, { id: 'rfnd_1', entity: 'refund', status: 'processed', amount: 79900 });
    if (/\/orders$/.test(url)) return res(200, { id: 'order_NEWER', amount: 79900, currency: 'INR' });
    return res(404, {});
  });
  return { f, calls };
}
afterEach(() => vi.unstubAllGlobals());

describe('payment check (money left the account but the website never heard)', () => {
  it('finds a captured payment on an earlier attempt and records it once', async () => {
    const { m, env: e } = env(base());
    const rz = razorpay({ payments: { order_OLD: [{ id: 'pay_A', status: 'captured', captured: true, amount: 79900 }] } });
    const r = await reconcilePayment(e, null, NO, 'test', rz.f);
    expect(r).toMatchObject({ paid: true, payment_id: 'pay_A' });
    expect(m.root.orders[NO].payment_status).toBe('paid');
    expect(m.root.orders[NO].razorpay_payment_id).toBe('pay_A');
    const again = await reconcilePayment(e, null, NO, 'test', rz.f);
    expect(again.already).toBe(true);
  });

  it('reports a bank-approved (authorized) payment without marking it paid', async () => {
    const { m, env: e } = env(base());
    const rz = razorpay({ payments: { order_NEW: [{ id: 'pay_B', status: 'authorized', amount: 79900 }] } });
    expect((await reconcilePayment(e, null, NO, 'test', rz.f)).state).toBe('authorized');
    expect(m.root.orders[NO].payment_status).toBe('pending');
  });

  it('flags an amount that differs from the order total', async () => {
    const { m, env: e } = env(base());
    const rz = razorpay({ payments: { order_NEW: [{ id: 'pay_C', status: 'captured', amount: 50000 }] } });
    await reconcilePayment(e, null, NO, 'test', rz.f);
    expect(m.root.orders[NO].payment_attention).toBe(true);
  });

  it('the unpaid-order expiry keeps an order Razorpay says is paid', async () => {
    const { m, env: e } = env(base({ stock_held: null }));
    vi.stubGlobal('fetch', razorpay({ payments: { order_OLD: [{ id: 'pay_D', status: 'captured', amount: 79900 }] } }).f);
    const r = await expireUnpaidOrders(e, { now: Date.parse('2026-11-21T11:00:00Z') });
    expect(r.expired).toEqual([]);
    expect(r.paid).toEqual([NO]);
    expect(m.root.orders[NO].status).toBe('placed');
    expect(m.root.orders[NO].payment_status).toBe('paid');
  });

  it('still expires a truly unpaid order', async () => {
    const { m, env: e } = env(base({ stock_held: null }));
    vi.stubGlobal('fetch', razorpay().f);
    const r = await expireUnpaidOrders(e, { now: Date.parse('2026-11-21T11:00:00Z') });
    expect(r.expired).toEqual([NO]);
    expect(m.root.orders[NO].status).toBe('cancelled');
  });

  it('"Pay again" never charges twice: an earlier paid attempt is shown as paid instead', async () => {
    const { m, env: e } = env(base(), {});
    m.root.settings = { payments: { razorpay: true, cod: true } };
    const rz = razorpay({ payments: { order_OLD: [{ id: 'pay_E', status: 'captured', amount: 79900 }] } });
    vi.stubGlobal('fetch', rz.f);
    const r = await (await retryPayment(req({ phone: '9876543210' }), e, null, NO)).json();
    expect(r.already_paid).toBe(true);
    expect(rz.calls.some((c) => /\/v1\/orders$/.test(c.url))).toBe(false); // no new Razorpay order created
    expect(m.root.orders[NO].payment_status).toBe('paid');
  });
});

describe('refunds: cancelled prepaid order → awaiting review → admin confirms → Razorpay', () => {
  const paid = (extra) => base({ payment_status: 'paid', razorpay_payment_id: 'pay_P', status: 'confirmed', ...extra });

  it('cancelling a paid online order only puts the refund in review', async () => {
    const { m, env: e } = env(paid());
    const body = { status: 'cancelled', notify: { whatsapp: false, email: false } };
    await adminUpdateOrder(new Request('https://x', { method: 'PATCH', body: JSON.stringify(body) }), e, { waitUntil() {} }, NO, admin);
    const o = m.root.orders[NO];
    expect(o.status).toBe('cancelled');
    expect(o.refund).toMatchObject({ status: 'review', amount: 799 });
    expect(o.payment_status).toBe('paid'); // no money moved
  });

  it('Process refund calls Razorpay once (paise + idempotency key) and cannot run twice', async () => {
    const { m, env: e } = env(paid({ status: 'cancelled', refund: { status: 'review', amount: 799, attempt: 1 } }));
    const rz = razorpay({ refunds: [res(200, { id: 'rfnd_1', entity: 'refund', status: 'pending', amount: 79900 })] });
    const out = await (await adminProcessRefund(req({}), e, NO, admin, rz.f)).json();
    expect(out.refund).toMatchObject({ status: 'processing', refund_id: 'rfnd_1', amount: 799 });
    const call = rz.calls.find((c) => /\/payments\/pay_P\/refund$/.test(c.url));
    expect(JSON.parse(call.init.body)).toMatchObject({ amount: 79900, speed: 'normal', notes: { order_no: NO } });
    expect(call.init.headers['x-refund-idempotency']).toBe(`gomo-${NO}-refund-1`);
    expect(m.root.orders[NO].payment_status).toBe('paid'); // refunded only when Razorpay confirms
    await expect(adminProcessRefund(req({}), e, NO, admin, rz.f)).rejects.toMatchObject({ status: 409 });
    expect(rz.calls.filter((c) => /\/refund$/.test(c.url))).toHaveLength(1);
    expect(m.root.order_index.refunds_open[NO]).toBe(true);
  });

  it('Razorpay webhook refund.processed marks the order Refunded', async () => {
    const { m, env: e } = env(paid({ status: 'cancelled', refund: { status: 'processing', refund_id: 'rfnd_1', amount: 799, attempt: 1 } }));
    const raw = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', status: 'processed', amount: 79900, notes: { order_no: NO }, acquirer_data: { arn: 'ARN123' } } } } });
    const sig = await hmacSha256Hex('whsec', raw);
    await razorpayWebhook(new Request('https://x', { method: 'POST', body: raw, headers: { 'x-razorpay-signature': sig } }), e, {});
    expect(m.root.orders[NO].payment_status).toBe('refunded');
    expect(m.root.orders[NO].refund).toMatchObject({ status: 'processed', arn: 'ARN123' });
  });

  it('a refund event for a different refund id is ignored', async () => {
    const { m, env: e } = env(paid({ status: 'cancelled', refund: { status: 'processing', refund_id: 'rfnd_1', amount: 799 } }));
    const raw = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_OTHER', status: 'processed', notes: { order_no: NO } } } } });
    await razorpayWebhook(new Request('https://x', { method: 'POST', body: raw, headers: { 'x-razorpay-signature': await hmacSha256Hex('whsec', raw) } }), e, {});
    expect(m.root.orders[NO].payment_status).toBe('paid');
  });

  it('Refresh status picks up a processed refund', async () => {
    const { m, env: e } = env(paid({ status: 'cancelled', refund: { status: 'processing', refund_id: 'rfnd_1', amount: 799 } }));
    await adminRefreshRefund(e, NO, admin, razorpay().f);
    expect(m.root.orders[NO].payment_status).toBe('refunded');
  });

  it('a refused refund can be tried again with a new key; a timeout reuses the same key', async () => {
    const { m, env: e } = env(paid({ status: 'cancelled', refund: { status: 'review', amount: 799, attempt: 1 } }));
    const rz = razorpay({ refunds: [
      new Error('network down'),
      res(400, { error: { description: 'Your account does not have enough balance to carry out the refund operation.' } }),
      res(200, { id: 'rfnd_2', entity: 'refund', status: 'processed', amount: 79900 }),
    ] });
    await expect(adminProcessRefund(req({}), e, NO, admin, rz.f)).rejects.toMatchObject({ status: 502 });
    expect(m.root.orders[NO].refund.status).toBe('review');
    await expect(adminProcessRefund(req({}), e, NO, admin, rz.f)).rejects.toThrow(/enough balance/);
    expect(m.root.orders[NO].refund).toMatchObject({ status: 'failed', attempt: 2 });
    await adminProcessRefund(req({}), e, NO, admin, rz.f);
    const keys = rz.calls.filter((c) => /\/refund$/.test(c.url)).map((c) => c.init.headers['x-refund-idempotency']);
    expect(keys).toEqual([`gomo-${NO}-refund-1`, `gomo-${NO}-refund-1`, `gomo-${NO}-refund-2`]);
    expect(m.root.orders[NO].payment_status).toBe('refunded');
  });

  it('partial refunds stay within the order total; COD orders cannot be refunded online', async () => {
    const { env: e } = env(paid({ status: 'cancelled', refund: { status: 'review', amount: 799 } }));
    await expect(adminProcessRefund(req({ amount: 900 }), e, NO, admin, razorpay().f)).rejects.toMatchObject({ status: 422 });
    const { env: e2 } = env(paid({ status: 'cancelled', payment_method: 'cod' }));
    await expect(adminProcessRefund(req({}), e2, NO, admin, razorpay().f)).rejects.toMatchObject({ status: 409 });
  });

  it('only people with the payments permission can process refunds', () => {
    expect(areaFor('POST', `/api/admin/orders/${NO}/refund`)).toBe('payments_edit');
    expect(areaFor('POST', `/api/admin/orders/${NO}/refund/refresh`)).toBe('orders');
    expect(areaFor('POST', `/api/admin/orders/${NO}/check-payment`)).toBe('orders');
  });
});
