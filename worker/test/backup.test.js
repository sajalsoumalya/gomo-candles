import { describe, it, expect } from 'vitest';
import { runBackup } from '../src/backup.js';

describe('daily backup', () => {
  it('writes a gzip of the database once per IST day, skipping short-lived data', async () => {
    const root = { orders: { A: { total: 1 } }, settings: { store: { name: 'GoMo' } }, otp: { x: 1 }, rate_limits: { y: 1 } };
    const store = {};
    const d = { get: async (p, q) => (p === '' && q?.shallow ? Object.fromEntries(Object.keys(root).map((k) => [k, true])) : p === 'backup_meta' ? store.meta ?? null : root[p] ?? null), put: async (p, v) => { if (p === 'backup_meta') store.meta = v; } };
    const puts = [];
    const s3 = { putObject: async (k, b) => puts.push([k, b]), listObjects: async () => ({ objects: [{ key: 'gomo/backups/2020-01-01.json.gz' }] }), deleteObject: async (k) => puts.push(['del', k]) };
    const env = { __db: d, __s3: s3 };
    const now = Date.parse('2026-11-21T00:30:00Z');
    const r = await runBackup(env, { now });
    expect(r.last_key).toBe('gomo/backups/2026-11-21.json.gz');
    expect(r.sections).toBe(2);
    const text = await new Response(new Blob([puts[0][1]]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const saved = JSON.parse(text);
    expect(Object.keys(saved.data)).toEqual(['orders', 'settings']);
    expect(puts.some((p) => p[0] === 'del' && p[1].includes('2020-01-01'))).toBe(true); // old backup removed
    expect((await runBackup(env, { now })).skipped).toMatch(/already/);
  });
});
