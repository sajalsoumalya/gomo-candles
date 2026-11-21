import { describe, it, expect } from 'vitest';
import { fyCode, invoiceNumber, splitTax, computeInvoice } from '../src/invoice.js';
import { validateSettingsInput, getSettings, DEFAULT_SETTINGS } from '../src/settings.js';

describe('fyCode (IST, April–March)', () => {
  it('uses the current FY after April 1', () => expect(fyCode('2026-11-18T06:00:00Z')).toBe('26-27'));
  it('uses the previous FY before April 1', () => expect(fyCode('2027-03-31T18:00:00Z')).toBe('26-27'));
  it('switches at IST midnight, not UTC', () => expect(fyCode('2027-03-31T18:31:00Z')).toBe('27-28'));
});

it('formats invoice numbers', () => expect(invoiceNumber('GM', '26-27', 7)).toBe('GM/26-27/0007'));

describe('splitTax', () => {
  it('back-calculates 5% from an inclusive price and adds up exactly', () => {
    const t = splitTax(105000, 5, true); // ₹1050
    expect(t.taxable).toBe(100000);
    expect(t.cgst + t.sgst).toBe(5000);
    expect(t.taxable + t.tax).toBe(105000);
  });
  it('puts odd paise into SGST and keeps the total exact', () => {
    const t = splitTax(49900, 5, true);
    expect(t.taxable + t.cgst + t.sgst).toBe(49900);
    expect(Math.abs(t.cgst - t.sgst)).toBeLessThanOrEqual(1);
  });
  it('uses IGST for other states', () => {
    const t = splitTax(49900, 5, false);
    expect(t.cgst).toBe(0);
    expect(t.igst).toBe(t.tax);
  });
});

const order = { order_no: 'GM-261118-0001', created_at: '2026-11-18T06:00:00Z', status: 'placed', customer_name: 'A', phone: '9876543210',
  address_line1: 'x', city: 'Kolkata', state: 'West Bengal', pincode: '700001', shipping: 50, savings: 0, payment_method: 'cod', payment_status: 'pending' };
const items = [{ name: 'Candle', qty: 2, unit_price: 499, line_total: 998 }];
const seller = { name: 'GoMo', gstin: '19ABCDE1234F1Z5', address: 'Kolkata', state: 'West Bengal' };

describe('computeInvoice', () => {
  it('prints a plain invoice with no tax when there is no GSTIN', () => {
    const inv = computeInvoice(order, items, { number: 'GM/26-27/0001', mode: 'plain', rate: 0, hsn: '3406', seller: { ...seller, gstin: null } });
    expect(inv.title).toBe('Invoice');
    expect(inv.totals.tax).toBe(0);
    expect(inv.totals.gross).toBe(1048);
    expect(inv.lines).toHaveLength(2); // item + shipping
  });
  it('uses CGST + SGST within the state', () => {
    const inv = computeInvoice(order, items, { number: 'n', mode: 'tax', rate: 5, hsn: '3406', seller });
    expect(inv.title).toBe('Tax Invoice');
    expect(inv.tax_type).toBe('cgst_sgst');
    expect(inv.totals.igst).toBe(0);
    expect(Math.round((inv.totals.taxable + inv.totals.tax) * 100)).toBe(104800);
  });
  it('uses IGST for another state', () => {
    const inv = computeInvoice({ ...order, state: 'Maharashtra' }, items, { number: 'n', mode: 'tax', rate: 5, hsn: '3406', seller });
    expect(inv.tax_type).toBe('igst');
    expect(inv.totals.cgst).toBe(0);
  });
});

describe('invoice settings validation', () => {
  const env = {};
  const current = DEFAULT_SETTINGS;
  it('accepts an empty GSTIN', () => {
    const out = validateSettingsInput({ invoice: { gstin: '', hsn: '3406', gst_rate: 5, prefix: 'gm' } }, env, current);
    expect(out.invoice.prefix).toBe('GM');
  });
  it('rejects a bad GSTIN and a GSTIN without state/address', () => {
    expect(() => validateSettingsInput({ invoice: { gstin: 'ABC', hsn: '3406', gst_rate: 5, prefix: 'GM' } }, env, current)).toThrow();
    let err;
    try { validateSettingsInput({ invoice: { gstin: '19ABCDE1234F1Z5', hsn: '3406', gst_rate: 5, prefix: 'GM' } }, env, current); }
    catch (e) { err = e; }
    expect(Object.keys(err.details.fields)).toEqual(expect.arrayContaining(['invoice.state', 'invoice.address']));
  });
  it('fills invoice defaults for old stored settings', async () => {
    const s = await getSettings({ __db: { get: async () => ({ store: { name: 'X' } }) } });
    expect(s.invoice.hsn).toBe('3406');
  });
});
