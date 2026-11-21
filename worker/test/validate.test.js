import { describe, it, expect } from 'vitest';
import { validateProductInput } from '../src/validate.js';

describe('validateProductInput: mrp + details', () => {
  it('parses "Label: value" lines into rows', () => {
    const v = validateProductInput({ name: 'Evil Eye Candle', price: 449, mrp: 999, details: 'Expiry: 1 year\n\nStorage: Keep away from heat: and sun' });
    expect(v.mrp).toBe(999);
    expect(JSON.parse(v.details)).toEqual([
      { label: 'Expiry', value: '1 year' },
      { label: 'Storage', value: 'Keep away from heat: and sun' },
    ]);
  });

  it('accepts row objects and treats an empty MRP as none', () => {
    const v = validateProductInput({ name: 'Linen Mist', price: 299, mrp: '', details: [{ label: 'Quantity', value: '100 ml' }] }, { partial: true });
    expect(v.mrp).toBe(0);
    expect(JSON.parse(v.details)).toEqual([{ label: 'Quantity', value: '100 ml' }]);
  });

  it('rejects an MRP below the selling price and lines without a label', () => {
    expect(() => validateProductInput({ name: 'Sachet', price: 199, mrp: 99 })).toThrow();
    expect(() => validateProductInput({ name: 'Sachet', price: 199, details: 'just some text' })).toThrow();
    try { validateProductInput({ name: 'Sachet', price: 199, details: 'just some text' }); } catch (e) { expect(e.details.fields.details).toMatch(/Label: value/); }
  });

  it('leaves mrp/details untouched when not sent', () => {
    const v = validateProductInput({ price: 199 }, { partial: true });
    expect('mrp' in v).toBe(false);
    expect('details' in v).toBe(false);
  });
});
