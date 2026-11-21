import { describe, it, expect, vi } from 'vitest';

const WHO = { uid: 'u1', profile: { uid: 'u1', phone: '9876543210', email: 'a@b.co', name: 'A', addresses: { x: { line1: 'L' } } } };
const { rateLimit } = await import('../src/db.js');
const { deleteMyAccount, exportMyData } = await import('../src/account.js');

function memDb(data) {
  const root = structuredClone(data);
  const seg = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), root) ?? null;
  const put = (p, v) => { const ks = seg(p), last = ks.pop(); if (last === undefined) return; const par = ks.reduce((o, k) => (o[k] ??= {}), root); if (v == null) delete par[last]; else par[last] = structuredClone(v); };
  return { root, __db: {
    get: async (p) => structuredClone(get(p)),
    put: async (p, v) => put(p, v),
    patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(p ? `${p}/${k}` : k, x); },
    remove: async (p) => put(p, null),
    getWithEtag: async (p) => ({ value: structuredClone(get(p)), etag: JSON.stringify(get(p)) }),
    putIfMatch: async (p, v, etag) => { if (JSON.stringify(get(p)) !== etag) return false; put(p, v); return true; },
  } };
}

describe('rate limiter never fails open', () => {
  it('blocks when every write loses the race and the count is over the limit', async () => {
    const env = { __db: {
      getWithEtag: async () => ({ value: { window_start: Math.floor(Date.now() / 1000), count: 99 }, etag: '1' }),
      putIfMatch: async () => false, // always contended
    } };
    expect(await rateLimit(env, 'k', 10, 3600)).toBe(false);
  });
  it('still allows under the limit', async () => {
    const m = memDb({});
    expect(await rateLimit(m, 'k', 2, 3600)).toBe(true);
    expect(await rateLimit(m, 'k', 2, 3600)).toBe(true);
    expect(await rateLimit(m, 'k', 2, 3600)).toBe(false);
  });
});

describe('account delete and export', () => {
  const req = (body) => new Request('https://x/api', { method: 'POST', body: JSON.stringify(body) });
  it('needs the word DELETE', async () => {
    const m = memDb({});
    await expect(deleteMyAccount(req({}), { ...m, __auth: { remove: async () => {} } }, WHO)).rejects.toMatchObject({ status: 400 });
  });
  it('refuses while an order is on its way', async () => {
    const m = memDb({ user_orders: { u1: { 'GM-1': 1 } }, orders: { 'GM-1': { status: 'shipped' } } });
    await expect(deleteMyAccount(req({ confirm: 'DELETE' }), { ...m, __auth: { remove: async () => {} } }, WHO)).rejects.toMatchObject({ status: 409 });
  });
  it('erases the profile and indexes, keeps the order', async () => {
    const removed = [];
    const m = memDb({ users: { u1: { name: 'A', phone: '9876543210' } }, user_index: { phone: { 9876543210: 'u1' }, email: { 'a@b_co': 'u1' } },
      user_orders: { u1: { 'GM-1': 1 } }, orders: { 'GM-1': { status: 'delivered', customer_name: 'A' } } });
    await deleteMyAccount(req({ confirm: 'DELETE' }), { ...m, __auth: { remove: async (uid) => removed.push(uid) } }, WHO);
    expect(m.root.users.u1.name).toBeUndefined();
    expect(m.root.users.u1.disabled).toBe(true);
    expect(m.root.user_index.phone?.['9876543210']).toBeUndefined();
    expect(m.root.orders['GM-1'].customer_name).toBe('A');
    expect(removed).toEqual(['u1']);
  });
  it('exports profile, addresses and orders', async () => {
    const m = memDb({ user_orders: { u1: { 'GM-1': 1 } }, orders: { 'GM-1': { order_no: 'GM-1', status: 'delivered', items: { a: { name: 'Candle' } }, events: { e: 1 } } } });
    const data = await (await exportMyData(new Request('https://x/api'), m, WHO)).json();
    expect(data.account.phone).toBe('9876543210');
    expect(data.addresses).toHaveLength(1);
    expect(data.orders[0].items[0].name).toBe('Candle');
    expect(data.orders[0].events).toBeUndefined();
  });
});
