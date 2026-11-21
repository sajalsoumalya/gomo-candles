import { describe, it, expect } from 'vitest';
import { computeInvoice } from '../src/invoice.js';
import { priceCart, offerTax } from '../src/pricing.js';

const seller = { name: 'GoMo', gstin: '19ABCDE1234F1Z5', address: 'Kolkata', state: 'West Bengal' };
const inv = { number: 'GM/26-27/0001', mode: 'tax', rate: 5, hsn: '3406', seller };
const order = { order_no: 'GM-1', created_at: '2026-11-21T00:00:00Z', state: 'Maharashtra', shipping: 0 };

describe('GST per product', () => {
  it('uses each line’s HSN and rate, falling back to the store default', () => {
    const items = [
      { name: 'Candle', qty: 1, unit_price: 1050, line_total: 1050, hsn: '3406', gst_rate: 5 },
      { name: 'Linen Mist', qty: 1, unit_price: 1180, line_total: 1180, hsn: '3307', gst_rate: 18 },
      { name: 'Old line', qty: 1, unit_price: 105, line_total: 105 },
    ];
    const r = computeInvoice(order, items, inv);
    expect(r.lines.map((l) => [l.hsn, l.rate])).toEqual([['3406', 5], ['3307', 18], ['3406', 5]]);
    expect(r.lines[1].taxable).toBe(1000);
    expect(r.lines[1].igst).toBe(180);
    expect(r.rate).toBe(null); // mixed rates
    expect(r.rate_summary.map((x) => x.rate)).toEqual([5, 18]);
    expect(Math.round((r.totals.taxable + r.totals.tax) * 100)).toBe(Math.round(r.totals.gross * 100));
  });
  it('spreads a coupon across lines so totals still match what was paid', () => {
    const items = [
      { name: 'A', qty: 1, unit_price: 500, line_total: 500, gst_rate: 5 },
      { name: 'B', qty: 1, unit_price: 500, line_total: 500, gst_rate: 18 },
    ];
    const r = computeInvoice({ ...order, discount: 100, coupon_code: 'SAVE100' }, items, inv);
    expect(r.totals.gross).toBe(900);
    expect(r.lines.find((l) => l.is_discount).amount).toBe(-100);
    expect(r.lines[0].discount + r.lines[1].discount).toBe(100);
  });
  it('order lines carry product tax info; combos use the highest rate', () => {
    const products = {
      candle: { id: 'candle', name: 'Candle', price: 449, published: true, orderable: true, in_stock: true, hsn: '3406', gst_rate: 5 },
      mist: { id: 'mist', name: 'Mist', price: 299, published: true, orderable: true, in_stock: true, hsn: '3307', gst_rate: 18 },
    };
    const offers = { c: { id: 'c', name: 'Combo', price: 600, published: true, items: [{ product_id: 'candle', qty: 1 }, { product_id: 'mist', qty: 1 }] } };
    const r = priceCart([{ type: 'product', id: 'mist', qty: 1 }, { type: 'offer', id: 'c', qty: 1 }], { products, offers }, { free_above: 0, fee: 0 });
    expect(r.lines[0]).toMatchObject({ hsn: '3307', gst_rate: 18 });
    expect(r.lines[1]).toMatchObject({ hsn: '3406', gst_rate: 18 });
    expect(offerTax(offers.c, { candle: { price: 1 } })).toEqual({ hsn: null, gst_rate: null });
  });
});
