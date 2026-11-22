import { describe, it, expect } from 'vitest';
import { topicsFor, db } from '../src/db.js';
import { areaFor } from '../src/staff.js';

describe('live-update topics', () => {
  it('maps a write path to its topic', () => {
    expect([...topicsFor('orders/GM-261122-0001/status')]).toEqual(['orders']);
    expect([...topicsFor('products/candle/stock')]).toEqual(['catalog']);
    expect([...topicsFor('/offers/combo-trio')]).toEqual(['catalog']);
    expect([...topicsFor('users/abc')]).toEqual(['customers']);
    expect([...topicsFor('settings')]).toEqual(['settings']);
  });
  it('ignores internal paths', () => {
    expect(topicsFor('rate_limits/x').size).toBe(0);
    expect(topicsFor('otp/verify_phone/9876543210').size).toBe(0);
    expect(topicsFor('changes').size).toBe(0);
    expect(topicsFor('shiprocket/token').size).toBe(0);
  });
  it('reads the keys of a multi-path root patch', () => {
    expect([...topicsFor('', { 'users/u1': {}, 'order_index/phone/98/GM-1': true, 'rate_limits/a': 1 })].sort()).toEqual(['customers', 'orders']);
    expect(topicsFor('', null).size).toBe(0);
  });
  it('any signed-in admin may poll for changes', () => {
    expect(areaFor('GET', '/api/admin/changes')).toBe('any');
  });
});

describe('db writes stamp changes/<topic>', () => {
  const fake = (failChanges = false) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const u = new URL(url);
      calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : undefined });
      if (failChanges && u.pathname === '/changes.json') return new Response('boom', { status: 500 });
      return init.method === 'GET' ? new Response('null', { status: 200 }) : new Response(null, { status: 204 });
    };
    return { calls, d: db({ RTDB_URL: 'http://localhost:9000' }, fetchImpl) };
  };

  it('a product stock write stamps catalog', async () => {
    const { calls, d } = fake();
    await d.put('products/candle-live-1/stock', 4);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PUT /products/candle-live-1/stock.json', 'PATCH /changes.json']);
    expect(typeof calls[1].body.catalog).toBe('number');
  });
  it('internal writes and reads stamp nothing', async () => {
    const { calls, d } = fake();
    await d.put('rate_limits/abc', { count: 1 });
    await d.get('orders');
    expect(calls.some((c) => c.path === '/changes.json')).toBe(false);
  });
  it('a failing stamp never fails the write', async () => {
    const { d } = fake(true);
    await expect(d.patch('', { 'users/live-u2': { name: 'A' } })).resolves.toBeNull();
  });
});
