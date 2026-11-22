import { describe, it, expect } from 'vitest';
import { adminListOrders, spendByCustomer, adminStats } from '../src/orders.js';

// Minimal in-memory RTDB: queries return the whole node (enough for these scans).
function memEnv(root) {
  const seg = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), root) ?? null;
  return { __db: { get: async (p) => structuredClone(get(p)), put: async () => {}, patch: async () => {}, remove: async () => {} } };
}
const order = (no, over) => ({ order_no: no, created_at: `2026-11-2${no.slice(-1)}T10:00:00.000Z`, customer_name: 'A', phone: '9876543210', status: 'placed', payment_method: 'razorpay', payment_status: 'paid', total: 100, ...over });
const ORDERS = {
  'GM-261121-0001': order('GM-261121-0001', { uid: 'u1', total: 449 }),
  'GM-261121-0002': order('GM-261121-0002', { uid: 'u1', total: 799, payment_method: 'cod', payment_status: 'pending', status: 'confirmed' }),
  'GM-261121-0003': order('GM-261121-0003', { uid: 'u1', total: 500, status: 'cancelled' }),
  'GM-261121-0004': order('GM-261121-0004', { uid: 'u2', total: 1299, status: 'delivered' }),
  'GM-261121-0005': order('GM-261121-0005', { total: 199 }), // guest
};
const list = async (qs) => (await adminListOrders(new Request(`https://x/api/admin/orders?${qs}`), memEnv({ orders: ORDERS }))).json();

describe('amounts in admin lists', () => {
  it('orders list: total value of the filtered orders, cancelled left out', async () => {
    expect((await list('')).amount).toBe(449 + 799 + 1299 + 199);
    expect((await list('status=placed')).amount).toBe(449 + 199);
    expect((await list('status=cancelled')).amount).toBe(500);
  });
  it('per customer: orders placed and money received', async () => {
    const s = await spendByCustomer(memEnv({ orders: ORDERS }));
    expect(s.u1).toMatchObject({ n: 2, spent: 449 }); // COD not yet collected, cancelled ignored
    expect(s.u2).toMatchObject({ n: 1, spent: 1299 });
    expect(Object.keys(s).sort()).toEqual(['u1', 'u2']);
  });
  it('stats: money per status', async () => {
    const s = await (await adminStats(memEnv({ orders: ORDERS, products: {}, offers: {} }))).json();
    expect(s.amount_by_status).toMatchObject({ placed: 648, confirmed: 799, cancelled: 500, delivered: 1299 });
    expect(s.by_status).toMatchObject({ placed: 2, confirmed: 1, cancelled: 1, delivered: 1 });
  });
});
