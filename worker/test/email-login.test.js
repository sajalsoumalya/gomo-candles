import { describe, it, expect, vi } from 'vitest';

// Firebase Admin and custom tokens are mocked; everything else (OTP, Postal delivery, profiles) runs for real on an in-memory DB.
const fb = { users: {} };
vi.mock('../src/google.js', () => ({
  SCOPES: { db: 'db' }, accessToken: async () => 't', dropToken: () => {},
  createCustomToken: async (_env, uid) => `token-for-${uid}`,
  authAdmin: () => ({
    lookup: async (uid) => fb.users[uid] || null,
    lookupByEmail: async (email) => Object.values(fb.users).find((u) => u.email === email) || null,
    lookupByPhone: async () => null,
    create: async ({ uid, email, email_verified }) => { fb.users[uid] = { uid, email, email_verified, providers: [] }; return fb.users[uid]; },
    update: async (uid, f) => { if ('email_verified' in f) fb.users[uid].email_verified = f.email_verified; },
  }),
}));

const { emailLoginStart, emailLoginVerify } = await import('../src/account.js');

function memDb() {
  const root = {};
  const walk = (p, make) => { let o = root; const ks = p.split('/').filter(Boolean); for (const k of ks.slice(0, -1)) { if (o[k] == null) { if (!make) return [null]; o[k] = {}; } o = o[k]; } return [o, ks.at(-1)]; };
  const get = (p) => { if (!p) return root; const [o, k] = walk(p); return o ? (o[k] ?? null) : null; };
  const put = (p, v) => { const [o, k] = walk(p, true); if (v === null) delete o[k]; else o[k] = structuredClone(v); };
  let n = 0;
  return {
    root,
    get: async (p) => structuredClone(get(p)),
    put: async (p, v) => put(p, v),
    patch: async (p, v) => { for (const [k, val] of Object.entries(v)) put(p ? `${p}/${k}` : k, val); },
    remove: async (p) => put(p, null),
    getWithEtag: async (p) => ({ value: structuredClone(get(p)), etag: String(++n) }),
    putIfMatch: async (p, v) => { put(p, v); return true; },
  };
}

const req = (path, body) => new Request(`https://api.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' } });

describe('sign in with an email code', () => {
  it('emails a code through Postal, then signs in and creates a verified account', async () => {
    const sent = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ status: 'success', data: { message_id: 'm1' } }), { status: 200 });
    });
    const env = { __db: memDb(), OTP_SECRET: 's'.repeat(32), POSTAL_URL: 'https://postal.test', POSTAL_API_KEY: 'k', MAIL_FROM: 'shop@gomo.test' };

    const start = await (await emailLoginStart(req('/api/auth/email/start', { email: 'Riya@Example.com' }), env)).json();
    expect(start.channel).toBe('email');
    const mail = sent.find((m) => m.url.startsWith('https://postal.test'));
    expect(mail.body.to).toContain('riya@example.com');
    const code = /\b(\d{6})\b/.exec(mail.body.plain_body || mail.body.subject)[1];

    const out = await (await emailLoginVerify(req('/api/auth/email/verify', { email: 'riya@example.com', code }), env)).json();
    expect(out.custom_token).toMatch(/^token-for-/);
    expect(out.is_new).toBe(true);
    expect(out.needs_phone).toBe(true);
    const uid = out.custom_token.slice('token-for-'.length);
    expect(env.__db.root.users[uid].email_verified).toBe(true);
    expect(fb.users[uid].email_verified).toBe(true);
    fetchSpy.mockRestore();
  });

  it('rejects a wrong code', async () => {
    const env = { __db: memDb(), OTP_SECRET: 's'.repeat(32), DEV_OTP_ECHO: '1' };
    const local = (p, b) => new Request(`http://localhost${p}`, { method: 'POST', body: JSON.stringify(b) });
    const start = await (await emailLoginStart(local('/api/auth/email/start', { email: 'a@b.co' }), env)).json();
    const wrong = start.dev_code === '000000' ? '111111' : '000000';
    await expect(emailLoginVerify(local('/api/auth/email/verify', { email: 'a@b.co', code: wrong }), env)).rejects.toMatchObject({ status: 400 });
  });

  it('signs an existing account in by its email and marks it verified', async () => {
    fb.users.olduser = { uid: 'olduser', email: 'old@b.co', email_verified: false, providers: ['google.com'] };
    const db = memDb();
    await db.put('users/olduser', { uid: 'olduser', email: 'old@b.co', email_verified: false, created_via: 'google', phone_verified: true, phone: '9876543210' });
    const env = { __db: db, OTP_SECRET: 's'.repeat(32), DEV_OTP_ECHO: '1' };
    const local = (p, b) => new Request(`http://localhost${p}`, { method: 'POST', body: JSON.stringify(b) });
    const { dev_code } = await (await emailLoginStart(local('/x', { email: 'old@b.co' }), env)).json();
    const out = await (await emailLoginVerify(local('/x', { email: 'old@b.co', code: dev_code }), env)).json();
    expect(out.custom_token).toBe('token-for-olduser');
    expect(out.is_new).toBe(false);
    expect(out.needs_phone).toBe(false);
    expect(fb.users.olduser.email_verified).toBe(true);
    expect(db.root.users.olduser.phone).toBe('9876543210'); // a Google account's data is kept
  });
});
