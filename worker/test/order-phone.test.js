import { describe, it, expect } from 'vitest';
import { orderPhone } from '../src/orders.js';

describe('orderPhone', () => {
  it('uses the verified mobile on the account', () => {
    expect(orderPhone({ phone: '9876543210', phone_verified: true }, '9000000000', true)).toEqual({ phone: '9876543210', verified: true });
  });
  it('accepts a typed number when no code channel is configured', () => {
    expect(orderPhone({ phone_verified: false }, '+91 98765 43210', false)).toEqual({ phone: '9876543210', verified: false });
    expect(orderPhone(null, '09876543210', false)).toEqual({ phone: '9876543210', verified: false });
  });
  it('rejects a missing or invalid typed number', () => {
    for (const bad of ['', '12345', '5876543210', undefined]) {
      try { orderPhone({}, bad, false); throw new Error('should fail'); } catch (e) { expect(e.status).toBe(422); expect(e.details.fields.phone).toBeTruthy(); }
    }
  });
  it('still requires verification once codes can be sent', () => {
    try { orderPhone({ phone: '9876543210', phone_verified: false }, '9876543210', true); throw new Error('should fail'); } catch (e) {
      expect(e.status).toBe(403); expect(e.details.code).toBe('phone_unverified');
    }
  });
});
