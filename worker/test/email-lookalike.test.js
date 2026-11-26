import { describe, it, expect } from 'vitest';
import { staffRecord } from '../src/staff.js';
import { safeKey } from '../src/db.js';

const memEnv = (data) => ({ __db: { get: async (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? null : o[k]), data) ?? null, patch: async () => {} } });

describe('lookalike emails (a.b@ vs a_b@ share one database key)', () => {
  it('they really do collide', () => {
    expect(safeKey('rahul.k@yahoo.com')).toBe(safeKey('rahul_k@yahoo.com'));
  });
  it('staff access only for the exact approved email', async () => {
    const env = memEnv({ staff: { [safeKey('a.b@outlook.com')]: { email: 'a.b@outlook.com', role: 'manager', active: true } } });
    expect(await staffRecord(env, 'a.b@outlook.com')).toBeTruthy();
    expect(await staffRecord(env, 'a_b@outlook.com')).toBe(null);
  });
});
