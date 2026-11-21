import { describe, it, expect } from 'vitest';
import { adminUpdateOrder } from '../src/orders.js';

function env(status) {
  const order = { order_no: 'GM-261118-0001', status, payment_method: 'cod', payment_status: 'pending', customer_name: 'A', phone: '9876543210', items: [], events: {} };
  const writes = [];
  return { writes, env: { __db: {
    get: async (p) => (p === `orders/${order.order_no}` ? structuredClone(order) : null),
    patch: async (p, v) => { writes.push([p, v]); },
    put: async () => {}, remove: async () => {},
    getWithEtag: async () => ({ value: null, etag: '1' }), putIfMatch: async () => true,
  } } };
}
const req = (body) => new Request('https://x/api', { method: 'PATCH', body: JSON.stringify({ ...body, notify: { whatsapp: false, email: false } }) });
const admin = { email: 'a@b.c' };
const ctx = { waitUntil() {} };

describe('admin order status', () => {
  it('blocks moving an order back a step', async () => {
    const { env: e, writes } = env('packed');
    await expect(adminUpdateOrder(req({ status: 'confirmed' }), e, ctx, 'GM-261118-0001', admin)).rejects.toMatchObject({ status: 409 });
    expect(writes).toHaveLength(0);
  });
  it('allows moving forward and cancelling before shipping', async () => {
    for (const next of ['shipped', 'cancelled']) {
      const { env: e } = env('packed');
      const res = await adminUpdateOrder(req({ status: next }), e, ctx, 'GM-261118-0001', admin).catch((x) => x);
      expect(res?.status).not.toBe(409);
    }
  });
});
