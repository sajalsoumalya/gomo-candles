import { describe, it, expect } from 'vitest';
import { areaFor, can, areasOf, adminSaveStaff } from '../src/staff.js';
import { requireArea } from '../src/auth.js';
import { adminPutSettings } from '../src/admin.js';

describe('per-page permissions', () => {
  it('maps admin paths to pages', () => {
    expect(areaFor('GET', '/api/admin/orders/GM-1')).toBe('orders');
    expect(areaFor('GET', '/api/admin/coupons')).toBe('coupons');
    expect(areaFor('GET', '/api/admin/settings')).toBe('settings_any');
    expect(areaFor('PUT', '/api/admin/staff')).toBe('owner');
    expect(areaFor('PUT', '/api/admin/roles')).toBe('owner');
    expect(areaFor('POST', '/api/admin/storage/cleanup')).toBe('set_storage');
    expect(areaFor('GET', '/api/admin/whatever-new')).toBe('owner');
  });
  it('presets and custom lists', () => {
    expect(can(areasOf('packer'), 'orders')).toBe(true);
    expect(can(areasOf('packer'), 'catalog')).toBe(false);
    expect(can(areasOf('manager'), 'coupons')).toBe(true);
    expect(can(areasOf('manager'), 'settings_any')).toBe(false);
    const custom = areasOf('custom', ['orders', 'set_shipping', 'bogus']);
    expect(custom).toEqual(['orders', 'set_shipping']);
    expect(can(custom, 'settings_any')).toBe(true);
    expect(can(custom, 'owner')).toBe(false);
    expect(can(['*'], 'owner')).toBe(true);
  });
  it('blocks API calls outside the person’s pages', () => {
    const admin = { areas: ['orders'] };
    expect(() => requireArea(admin, 'GET', '/api/admin/settings')).toThrow();
    expect(() => requireArea(admin, 'PATCH', '/api/admin/orders/GM-1')).not.toThrow();
  });
  it('checks each settings section on save', async () => {
    const env = { __db: { get: async () => null, patch: async () => {} } };
    const req = (b) => new Request('https://x', { method: 'PUT', body: JSON.stringify(b) });
    await expect(adminPutSettings(req({ store: { name: 'X' } }), env, { areas: ['set_shipping'] })).rejects.toMatchObject({ status: 403 });
  });
  it('validates staff and supports saved roles', async () => {
    const store = { roles: { 'packing-team': { label: 'Packing team', areas: ['orders', 'exports'] } } };
    const env = { __db: { get: async (p) => store[p] ?? null, put: async () => {}, patch: async () => {}, remove: async () => {} } };
    const owner = { uid: 'u', email: 'o@x.in', areas: ['*'] };
    await expect(adminSaveStaff(env, { email: 'a@b.in', role: 'custom', areas: [] }, owner, ['o@x.in'])).rejects.toMatchObject({ status: 422 });
    await expect(adminSaveStaff(env, { email: 'a@b.in', role: 'nope' }, owner, ['o@x.in'])).rejects.toMatchObject({ status: 422 });
    const r = await adminSaveStaff(env, { email: 'a@b.in', role: 'packing-team' }, owner, ['o@x.in']);
    expect((await r.json()).staff).toMatchObject({ role: 'packing-team', role_label: 'Packing team', areas: ['orders', 'exports'] });
    expect(areasOf('packing-team', null, store.roles)).toEqual(['orders', 'exports']);
  });
});

describe('roles and access requests', async () => {
  const { adminSaveRole, adminDeleteRole, recordAccessRequest } = await import('../src/staff.js');
  function mem() {
    const root = {};
    const walk = (p, mk) => { let o = root; const ks = p.split('/'); for (const k of ks.slice(0, -1)) { if (o[k] == null) { if (!mk) return [null]; o[k] = {}; } o = o[k]; } return [o, ks.at(-1)]; };
    const get = (p) => { const [o, k] = walk(p); return o ? o[k] ?? null : null; };
    const put = (p, v) => { const [o, k] = walk(p, true); if (v === null) delete o[k]; else o[k] = structuredClone(v); };
    return { root, get: async (p) => structuredClone(get(p)), put: async (p, v) => put(p, v), patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(`${p}/${k}`, x); }, remove: async (p) => put(p, null) };
  }
  const admin = { uid: 'u', email: 'o@x.in', areas: ['*'] };
  it('creates, refuses built-in edits, and blocks deleting a role in use', async () => {
    const d = mem(); const env = { __db: d };
    const r = await (await adminSaveRole(env, { label: 'Packing team', areas: ['orders', 'bogus'] }, admin)).json();
    expect(r.role).toMatchObject({ id: 'packing-team', areas: ['orders'] });
    await expect(adminSaveRole(env, { id: 'manager', label: 'Managers', areas: ['orders'] }, admin)).rejects.toMatchObject({ status: 409 });
    await d.put('staff/a@b_in', { email: 'a@b.in', role: 'packing-team' });
    await expect(adminDeleteRole(env, 'packing-team', admin)).rejects.toMatchObject({ status: 409 });
  });
  it('records one pending request per email', async () => {
    const d = mem(); const env = { __db: d };
    await recordAccessRequest(env, { email: 'New@X.in', sub: 'u9', name: 'New' });
    await recordAccessRequest(env, { email: 'new@x.in', sub: 'u9' });
    expect(Object.keys(d.root.access_requests)).toHaveLength(1);
    expect(Object.values(d.root.access_requests)[0]).toMatchObject({ email: 'new@x.in', status: 'pending' });
  });
});
