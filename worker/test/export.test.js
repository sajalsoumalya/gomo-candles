import { describe, it, expect } from 'vitest';
import { adminExportOrders } from '../src/orders.js';

const orders = {
  'GM-261118-0001': { order_no: 'GM-261118-0001', created_at: '2026-11-18T05:00:00Z', status: 'placed', customer_name: 'Riya, Sen', phone: '9876543210', email: '=cmd', city: 'Kolkata', state: 'West Bengal', pincode: '700016', address_line1: '12 Park St',
    subtotal: 799, discount: 100, coupon_code: 'SAVE100', shipping: 0, total: 699, payment_method: 'cod', payment_status: 'pending', items: [{ qty: 1, name: 'Combo' }] },
  'GM-261101-0002': { order_no: 'GM-261101-0002', created_at: '2026-11-01T05:00:00Z', status: 'delivered', customer_name: 'Amit', phone: '9000000000', city: 'Pune', state: 'Maharashtra', pincode: '411001', address_line1: 'x',
    subtotal: 449, shipping: 0, total: 449, payment_method: 'razorpay', payment_status: 'paid', items: [{ qty: 2, name: 'Candle' }] },
};
const env = { __db: { get: async (p) => (p === 'orders' ? orders : null) } };

describe('orders CSV export', () => {
  it('exports filtered rows safely', async () => {
    const res = await adminExportOrders(new Request('https://x/api/admin/exports/orders.csv?status=placed'), env);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    const text = await res.text();
    const lines = text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(2); // header + 1 filtered order
    expect(lines[1]).toContain('"Riya, Sen"');      // commas quoted
    expect(lines[1]).toContain("'=cmd");            // formula injection blocked
    expect(lines[1]).toContain('SAVE100');
  });
  it('filters by IST date', async () => {
    const res = await adminExportOrders(new Request('https://x/api/admin/exports/orders.csv?from=2026-11-01&to=2026-11-01'), env);
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('GM-261101-0002');
  });
});
