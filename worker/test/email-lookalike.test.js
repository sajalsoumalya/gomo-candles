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

describe('sign-in codes never reach the admin Messages log', () => {
  it('subject and body are masked', async () => {
    const { deliver } = await import('../src/notify.js');
    const rows = [];
    const env = { __db: { put: async (p, v) => rows.push(v), patch: async () => {}, get: async () => null } };
    await deliver(env, { channel: 'email', to: 'a@b.co', subject: '482913 is your GoMo sign-in code', text: 'Code 482913', logText: 'Code ******', logSubject: '****** is your GoMo sign-in code', event: 'otp_login_email' }, async () => new Response('{}'));
    expect(JSON.stringify(rows)).not.toMatch(/482913/);
  });
});
