import { describe, it, expect } from 'vitest';
import { adminSaveStaff, adminRemoveStaff } from '../src/staff.js';
import { safeKey } from '../src/db.js';

function memEnv(data, fbUsers) {
  const root = structuredClone(data);
  const seg = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), root) ?? null;
  const put = (p, v) => { const ks = seg(p), last = ks.pop(); const par = ks.reduce((o, k) => (o[k] ??= {}), root); if (v == null) delete par[last]; else par[last] = structuredClone(v); };
  const calls = [];
  return { root, calls, env: {
    __db: { get: async (p) => structuredClone(get(p)), put: async (p, v) => put(p, v), remove: async (p) => put(p, null), patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(`${p}/${k}`, x); } },
    __auth: {
      lookupByEmail: async (e) => fbUsers[e] || null,
      update: async (uid, f) => calls.push(['update', uid, f]),
      remove: async (uid) => calls.push(['remove', uid]),
    },
  } };
}
const owner = { email: 'owner@gomo.in' };
const key = safeKey('pack@gomo.in');

describe('staff and Firebase sign-in', () => {
  it('switching a staff member off disables their Firebase sign-in, on enables it again', async () => {
    const m = memEnv({ staff: { [key]: { email: 'pack@gomo.in', role: 'packer', active: true } } }, { 'pack@gomo.in': { uid: 'U1' } });
    const off = await (await adminSaveStaff(m.env, { email: 'pack@gomo.in', role: 'packer', active: false }, owner, ['owner@gomo.in'])).json();
    expect(off.auth).toBe('sign-in disabled');
    expect(m.calls).toContainEqual(['update', 'U1', { disabled: true }]);
    const on = await (await adminSaveStaff(m.env, { email: 'pack@gomo.in', role: 'packer', active: true }, owner, ['owner@gomo.in'])).json();
    expect(on.auth).toBe('sign-in enabled');
    expect(m.calls).toContainEqual(['update', 'U1', { disabled: false }]);
  });
  it('removing a staff member deletes their Firebase sign-in', async () => {
    const m = memEnv({ staff: { [key]: { email: 'pack@gomo.in', role: 'packer', active: true } } }, { 'pack@gomo.in': { uid: 'U1' } });
    const r = await (await adminRemoveStaff(m.env, 'pack@gomo.in', owner, ['owner@gomo.in'])).json();
    expect(r.auth).toBe('sign-in deleted');
    expect(m.calls).toContainEqual(['remove', 'U1']);
    expect(m.root.staff[key]).toBeUndefined();
    expect(m.root.users.U1.disabled).toBe(true);
  });
  it('a lookalike email cannot remove someone else, and a super admin is never touched', async () => {
    const m = memEnv({ staff: { [safeKey('a.b@x.com')]: { email: 'a.b@x.com', role: 'packer', active: true } } }, { 'a_b@x.com': { uid: 'U2' }, 'a.b@x.com': { uid: 'U3' } });
    await expect(adminRemoveStaff(m.env, 'a_b@x.com', owner, [])).rejects.toMatchObject({ status: 404 });
    expect(m.calls).toEqual([]);
    expect(m.root.staff[safeKey('a.b@x.com')]).toBeTruthy();
  });
  it('a staff member who never signed in is simply removed', async () => {
    const m = memEnv({ staff: { [key]: { email: 'pack@gomo.in', role: 'packer', active: true } } }, {});
    const r = await (await adminRemoveStaff(m.env, 'pack@gomo.in', owner, [])).json();
    expect(r.auth).toBe('no sign-in account');
  });
});
