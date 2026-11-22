import { describe, it, expect, beforeEach } from 'vitest';
import { requireAdmin, requestAccess, resetKeyCache } from '../src/auth.js';
import { adminListStaff, adminSaveStaff } from '../src/staff.js';

// Real RS256 tokens signed by a test key; the "Google key list" fetch returns that key.
const PROJECT = 'gomocandle';
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const fetchImpl = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=3600' } });
const b64 = (x) => btoa(typeof x === 'string' ? x : String.fromCharCode(...new Uint8Array(x))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function token(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, iat: now - 10, exp: now + 3600, auth_time: now - 10, sub: 'u-' + claims.email, email_verified: true, ...claims }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}
function memDb(data = {}) {
  const root = structuredClone(data);
  const seg = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => seg(p).reduce((o, k) => (o == null ? undefined : o[k]), root) ?? null;
  const put = (p, v) => { const ks = seg(p), last = ks.pop(); const parent = ks.reduce((o, k) => (o[k] ??= {}), root); if (v == null) delete parent[last]; else parent[last] = structuredClone(v); };
  return { root, __db: { get: async (p) => structuredClone(get(p)), put: async (p, v) => put(p, v), patch: async (p, v) => { for (const [k, x] of Object.entries(v)) put(p ? `${p}/${k}` : k, x); }, remove: async (p) => put(p, null), getWithEtag: async (p) => ({ value: structuredClone(get(p)), etag: JSON.stringify(get(p)) }), putIfMatch: async (p, v, etag) => { if (JSON.stringify(get(p)) !== etag) return false; put(p, v); return true; } } };
}
const req = async (claims, body) => new Request('https://api/x', { method: 'POST', headers: { authorization: `Bearer ${await token(claims)}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };
const OWNER = 'owner@gomo.in';
let m, env;
beforeEach(() => { resetKeyCache(); m = memDb(); env = { ...m, FIREBASE_PROJECT_ID: PROJECT, ADMIN_EMAILS: OWNER }; });

describe('staff ask for access themselves; the owner approves', () => {
  it('signing in does not create a request — they are told to ask', async () => {
    const e = await err(requireAdmin(await req({ email: 'Priya@Gmail.com', name: 'Priya' }), env, { fetchImpl }));
    expect(e.status).toBe(403);
    expect(e.details.code).toBe('not_admin');
    expect(m.root.access_requests).toBeUndefined();
  });
  it('"Request access" creates one pending request (with the note); signing in then says pending', async () => {
    const r = await requestAccess(await req({ email: 'priya@gmail.com', name: 'Priya' }, { note: 'Packing, Saturdays' }), env, { fetchImpl });
    expect(r.status).toBe('pending');
    await requestAccess(await req({ email: 'priya@gmail.com' }), env, { fetchImpl }); // pressing twice keeps one
    const list = Object.values(m.root.access_requests);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ email: 'priya@gmail.com', status: 'pending', note: 'Packing, Saturdays', name: 'Priya' });
    const e = await err(requireAdmin(await req({ email: 'priya@gmail.com' }), env, { fetchImpl }));
    expect(e.details.code).toBe('access_pending');
  });
  it('unverified emails cannot ask', async () => {
    const e = await err(requestAccess(await req({ email: 'x@gmail.com', email_verified: false }), env, { fetchImpl }));
    expect(e.details.code).toBe('email_unverified');
    expect(m.root.access_requests).toBeUndefined();
  });
  it('the owner sees the request and approves it with a custom set of pages', async () => {
    await requestAccess(await req({ email: 'priya@gmail.com', name: 'Priya' }, { note: 'hi' }), env, { fetchImpl });
    const list = await (await adminListStaff(env, [OWNER])).json();
    expect(list.requests.map((r) => [r.email, r.note])).toEqual([['priya@gmail.com', 'hi']]);
    await adminSaveStaff(env, { email: 'priya@gmail.com', name: 'Priya', role: 'custom', areas: ['orders', 'customers'] }, { email: OWNER }, [OWNER]);
    const after = await (await adminListStaff(env, [OWNER])).json();
    expect(after.requests).toHaveLength(0);
    const admin = await requireAdmin(await req({ email: 'priya@gmail.com' }), env, { fetchImpl });
    expect(admin.areas.sort()).toEqual(['customers', 'orders']);
  });
  it('a declined person is told so and cannot re-request', async () => {
    m.root.access_requests = { 'x@gmail_com': { email: 'x@gmail.com', status: 'declined' } };
    const e = await err(requestAccess(await req({ email: 'x@gmail.com' }), env, { fetchImpl }));
    expect(e.details.code).toBe('access_declined');
    const e2 = await err(requireAdmin(await req({ email: 'x@gmail.com' }), env, { fetchImpl }));
    expect(e2.details.code).toBe('access_declined');
  });
  it('team members and the owner get "member" (no request made)', async () => {
    expect((await requestAccess(await req({ email: OWNER }), env, { fetchImpl })).status).toBe('member');
    expect(m.root.access_requests).toBeUndefined();
  });
});
