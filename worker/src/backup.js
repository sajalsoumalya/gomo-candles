// Daily database backup → RustFS bucket (private): gomo/backups/YYYY-MM-DD.json.gz (IST date). Keeps the last KEEP_DAYS.
// Covers orders, customers, products, offers, coupons, settings, staff, roles … (everything except short-lived data).
// Restore: download the file, gunzip, and import it in the Firebase console (Realtime Database → ⋮ → Import JSON).

import { json, nowIso } from './util.js';
import { db } from './db.js';
import { s3, s3Configured } from './s3.js';

export const BACKUP_PREFIX = 'gomo/backups/';
const KEEP_DAYS = 30;
// Short-lived or rebuildable data that would only bloat the backup.
const SKIP = new Set(['otp', 'rate_limits', 'media_meta']);

const istDate = (t = Date.now()) => new Date(t + 330 * 60000).toISOString().slice(0, 10);

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function runBackup(env, { force = false, now = Date.now() } = {}) {
  if (!s3Configured(env) && !env.__s3) return { skipped: 'storage not configured' };
  const d = db(env);
  const day = istDate(now);
  const meta = (await d.get('backup_meta')) || {};
  if (!force && meta.last_day === day) return { skipped: 'already backed up today', last: meta };

  const top = Object.keys((await d.get('', { shallow: true })) || {}).filter((k) => !SKIP.has(k));
  const data = {};
  for (const k of top) data[k] = await d.get(k);
  const text = JSON.stringify({ backup_of: 'gomocandle', taken_at: nowIso(), data });
  const body = await gzip(text);
  const key = `${BACKUP_PREFIX}${day}.json.gz`;
  const client = s3(env);
  await client.putObject(key, body, { contentType: 'application/gzip', contentLength: body.length, cacheControl: 'no-store' });

  // Retention: drop backups older than KEEP_DAYS.
  let removed = 0;
  try {
    const cutoff = istDate(now - KEEP_DAYS * 86400000);
    const page = await client.listObjects(BACKUP_PREFIX);
    for (const o of page.objects) {
      const m = /(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(o.key);
      if (m && m[1] < cutoff) { await client.deleteObject(o.key); removed++; }
    }
  } catch (e) { console.error('backup retention failed', e?.message || e); }

  const info = { last_day: day, last_at: nowIso(), last_key: key, bytes: body.length, raw_bytes: text.length, sections: top.length, removed_old: removed };
  await d.put('backup_meta', info);
  return info;
}

export async function adminBackupStatus(env) {
  const meta = (await db(env).get('backup_meta')) || null;
  let files = [];
  try { files = (await s3(env).listObjects(BACKUP_PREFIX)).objects.map((o) => ({ key: o.key, size: o.size, at: o.last_modified })).sort((a, b) => (a.key < b.key ? 1 : -1)); } catch { /* storage down */ }
  return json({ last: meta, files: files.slice(0, KEEP_DAYS), keep_days: KEEP_DAYS });
}

/** Owner downloads a backup file through the Worker (bucket stays private). */
export async function adminDownloadBackup(env, name) {
  if (!/^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(name)) return new Response('Not found', { status: 404 });
  const res = await s3(env).getObject(BACKUP_PREFIX + name);
  if (res.status !== 200) return new Response('Not found', { status: 404 });
  return new Response(res.body, { headers: { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="gomo-backup-${name}"`, 'cache-control': 'no-store' } });
}
