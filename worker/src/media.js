// Product photos on S3-compatible storage (RustFS). Uploads go through the Worker so keys never reach the browser.
//
// media/{id} = { id, product_id, status, filename, sha256, alt, w, h, color, created_at, updated_at, expires_at,
//                variants: { original|web|thumb: { key, type, size, multipart, upload_id, part_size, parts_total, parts: {n: etag}, done } } }
// status: uploading → uploaded → attached → trash → (record removed after objects are deleted)
// Unsaved uploads expire (uploading: 6 h, uploaded: 24 h) and are removed by the cleanup cron, which also aborts
// stray multipart uploads and sweeps orphaned objects.

import { HttpError, json, readJson, nowIso } from './util.js';
import { db, pushKey, values } from './db.js';
import { s3, s3Configured } from './s3.js';
import { FILES_PREFIX, fileDisposition } from './files.js'; // cycle is safe: only used inside functions

export const PART_SIZE = 8 * 1024 * 1024; // S3 minimum part size is 5 MiB (except the last part)
export const PREFIX = 'gomo/products/';
const MAX_PER_PRODUCT = 10;
const LIMITS = {
  original: { max: 50 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'] },
  web: { max: 6 * 1024 * 1024, types: ['image/webp', 'image/jpeg'] },
  thumb: { max: 1024 * 1024, types: ['image/webp', 'image/jpeg'] },
};
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif' };
const UPLOADING_TTL = 6 * 3600_000;
const UPLOADED_TTL = 24 * 3600_000;
const ORPHAN_AGE = 48 * 3600_000;
const IMMUTABLE = 'public, max-age=31536000, immutable';

export const isMediaId = (id) => /^[a-z0-9]{10,24}$/.test(String(id || ''));

function requireStorage(env) {
  if (!s3Configured(env) && !env.__s3) throw new HttpError(503, 'Photo storage is not set up yet. Add the S3_* Worker secrets.', { code: 'storage_unconfigured' });
}

const mediaPath = (id) => `media/${id}`;
// Part ETags are stored under keys "n1", "n2"… (numeric keys would be turned into arrays by RTDB).
const partList = (v) => Object.entries(v.parts || {}).filter(([k, e]) => /^n\d+$/.test(k) && e).map(([k, etag]) => ({ n: Number(k.slice(1)), etag }));

async function loadMedia(env, id) {
  if (!isMediaId(id)) throw new HttpError(404, 'Upload not found.');
  const m = await db(env).get(mediaPath(id));
  if (!m) throw new HttpError(404, 'Upload not found.');
  return m;
}

function publicMedia(m) {
  const variants = {};
  for (const [name, v] of Object.entries(m.variants || {})) {
    variants[name] = {
      key: v.key, type: v.type, size: v.size, multipart: !!v.multipart, part_size: v.part_size || null,
      parts_total: v.parts_total || 1, parts_done: partList(v).map((p) => p.n).sort((a, b) => a - b), done: !!v.done,
    };
  }
  return { id: m.id, product_id: m.product_id, status: m.status, filename: m.filename, alt: m.alt || '', w: m.w, h: m.h, color: m.color || null,
    created_at: m.created_at, expires_at: m.expires_at || null, variants, error: m.error || null };
}

/** Image entry as stored on a product and sent to the shop. */
export function productImage(m, alt) {
  return { id: m.id, alt: alt ?? m.alt ?? '', w: m.w || null, h: m.h || null, color: m.transparent ? null : m.color || null, transparent: !!m.transparent,
    web: m.variants?.web?.key || m.variants?.original?.key, thumb: m.variants?.thumb?.key || m.variants?.web?.key || m.variants?.original?.key };
}

// --------------------------------------------------------------------------- admin: upload lifecycle

export async function adminCreateMedia(request, env) {
  requireStorage(env);
  const body = await readJson(request);
  const d = db(env);
  // Owner: a product id, or "offer-<offerId>" for photos of an offer (combo / pack).
  const productId = String(body.product_id || '');
  const ownerPath = productId.startsWith('offer-') ? `offers/${productId.slice(6)}/id` : `products/${productId}/id`;
  if (!/^[a-z0-9-]{1,70}$/.test(productId) || !(await d.get(ownerPath))) {
    throw new HttpError(422, 'Save it first, then add photos.', { code: 'product_required' });
  }
  const sha256 = /^[0-9a-f]{64}$/.test(body.sha256 || '') ? body.sha256 : null;
  const existing = values(await d.get('media', { orderBy: 'product_id', equalTo: productId }))
    .filter((m) => ['uploading', 'uploaded', 'attached'].includes(m.status));
  if (sha256 && !body.allow_duplicate) {
    const dup = existing.find((m) => m.sha256 === sha256 && m.status !== 'uploading');
    if (dup) throw new HttpError(409, 'This photo is already on this product.', { code: 'duplicate', media_id: dup.id });
  }
  if (existing.filter((m) => m.status !== 'uploading').length >= MAX_PER_PRODUCT + 5) {
    throw new HttpError(409, `A product can have up to ${MAX_PER_PRODUCT} photos.`, { code: 'too_many' });
  }

  const id = pushKey();
  const variants = {};
  const fields = {};
  const client = s3(env);
  for (const name of ['original', 'web', 'thumb']) {
    const v = body.variants?.[name];
    if (!v) { if (name !== 'thumb') fields[name] = 'Missing'; continue; }
    const type = String(v.type || '').toLowerCase();
    const size = Number(v.size);
    if (!LIMITS[name].types.includes(type)) { fields[name] = `Unsupported file type (${type || 'unknown'}).`; continue; }
    if (!Number.isInteger(size) || size < 1 || size > LIMITS[name].max) { fields[name] = `File too large (max ${Math.round(LIMITS[name].max / 1048576)} MB).`; continue; }
    const key = `${PREFIX}${productId}/${id}/${name}.${EXT[type]}`;
    const multipart = size > PART_SIZE;
    variants[name] = { key, type, size, multipart, done: false, ...(multipart ? { part_size: PART_SIZE, parts_total: Math.ceil(size / PART_SIZE) } : {}) };
  }
  if (Object.keys(fields).length) throw new HttpError(422, 'Please check the photo.', { fields });
  for (const v of Object.values(variants)) if (v.multipart) v.upload_id = await client.createMultipart(v.key, v.type, IMMUTABLE);

  const now = Date.now();
  const rec = {
    id, product_id: productId, status: 'uploading', filename: String(body.filename || '').slice(0, 120), sha256,
    alt: String(body.alt || '').slice(0, 140), w: Number(body.w) || null, h: Number(body.h) || null,
    color: body.transparent === true ? null : /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : null,
    transparent: body.transparent === true,
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), expires_at: now + UPLOADING_TTL, variants,
  };
  await d.put(mediaPath(id), rec);
  return json({ media: publicMedia(rec) }, 201);
}

export function bodyStream(request, length) {
  if (typeof FixedLengthStream !== 'undefined' && request.body) {
    const { readable, writable } = new FixedLengthStream(length);
    request.body.pipeTo(writable).catch(() => {});
    return readable;
  }
  return request.arrayBuffer();
}

export function declaredLength(request) {
  const n = Number(request.headers.get('content-length'));
  if (!Number.isInteger(n) || n < 1) throw new HttpError(411, 'Content-Length is required.');
  return n;
}

export async function adminUploadVariant(request, env, id, name) {
  requireStorage(env);
  const m = await loadMedia(env, id);
  const v = m.variants?.[name];
  if (!v) throw new HttpError(404, 'Unknown variant.');
  if (m.status !== 'uploading') throw new HttpError(409, 'This upload is already finished.');
  if (v.multipart) throw new HttpError(409, 'Upload this file in parts.');
  const len = declaredLength(request);
  if (len !== v.size) throw new HttpError(422, `Expected ${v.size} bytes, got ${len}.`);
  const body = await bodyStream(request, len);
  const { etag } = await s3(env).putObject(v.key, body, { contentType: v.type, contentLength: len, cacheControl: IMMUTABLE, retry: !(body instanceof ReadableStream) });
  await db(env).patch(`${mediaPath(id)}/variants/${name}`, { done: true, etag: etag || null });
  await db(env).patch(mediaPath(id), { updated_at: nowIso() });
  return json({ ok: true });
}

export async function adminUploadPart(request, env, id, name, n) {
  requireStorage(env);
  const m = await loadMedia(env, id);
  const v = m.variants?.[name];
  if (!v?.multipart) throw new HttpError(404, 'This file is not a multipart upload.');
  if (m.status !== 'uploading') throw new HttpError(409, 'This upload is already finished.');
  if (!Number.isInteger(n) || n < 1 || n > v.parts_total) throw new HttpError(422, 'Invalid part number.');
  const expected = n < v.parts_total ? v.part_size : v.size - v.part_size * (v.parts_total - 1);
  const len = declaredLength(request);
  if (len !== expected) throw new HttpError(422, `Part ${n} should be ${expected} bytes, got ${len}.`);
  const etag = await s3(env).uploadPart(v.key, v.upload_id, n, await bodyStream(request, len), len);
  await db(env).patch(`${mediaPath(id)}/variants/${name}/parts`, { [`n${n}`]: etag });
  return json({ ok: true, part: n, etag });
}

export async function adminGetMedia(env, id) {
  return json({ media: publicMedia(await loadMedia(env, id)) });
}

export async function adminCompleteMedia(env, id) {
  requireStorage(env);
  const m = await loadMedia(env, id);
  if (m.status !== 'uploading') return json({ media: publicMedia(m) });
  const client = s3(env);
  const d = db(env);
  for (const [name, v] of Object.entries(m.variants)) {
    if (v.multipart && !v.done) {
      const parts = partList(v);
      if (parts.length !== v.parts_total) throw new HttpError(409, `${name}: ${v.parts_total - parts.length} part(s) still missing.`, { code: 'parts_missing', variant: name });
      await client.completeMultipart(v.key, v.upload_id, parts);
      await d.patch(`${mediaPath(id)}/variants/${name}`, { done: true });
      v.done = true;
    }
    if (!v.done) throw new HttpError(409, `${name} has not been uploaded yet.`, { code: 'variant_missing', variant: name });
    let head;
    try { head = await client.head(v.key); } catch (e) {
      console.error('complete: size check failed', id, name, e?.status, e?.code, String(e?.message || e).slice(0, 200));
      throw new HttpError(502, `Couldn't confirm the ${name} file with storage (${e?.code || e?.status || 'error'}). Please try again.`, { code: 'storage_check_failed' });
    }
    if (!head || head.size !== v.size) {
      throw new HttpError(422, `${name} did not arrive intact (expected ${v.size} bytes, found ${head ? head.size : 'nothing'}). Please upload again.`, { code: 'size_mismatch' });
    }
  }
  const now = Date.now();
  await d.patch(mediaPath(id), { status: 'uploaded', updated_at: new Date(now).toISOString(), expires_at: now + UPLOADED_TTL });
  return json({ media: publicMedia({ ...m, status: 'uploaded', expires_at: now + UPLOADED_TTL }) });
}

/** Delete an upload that was never saved on a product (cancel / editor closed). */
export async function adminDeleteMedia(env, id) {
  const m = await loadMedia(env, id);
  if (m.status === 'attached') throw new HttpError(409, 'This photo is on a product. Remove it in the product editor and save.');
  if (s3Configured(env) || env.__s3) await purgeObjects(env, m);
  await db(env).remove(mediaPath(id));
  return json({ ok: true });
}

export async function adminListMedia(request, env) {
  const productId = new URL(request.url).searchParams.get('product_id') || '';
  if (!/^[a-z0-9-]{1,70}$/.test(productId)) throw new HttpError(422, 'product_id is required.');
  const rows = values(await db(env).get('media', { orderBy: 'product_id', equalTo: productId }))
    .filter((m) => m.status === 'uploading' || m.status === 'uploaded')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return json({ media: rows.map(publicMedia) });
}

// --------------------------------------------------------------------------- product attach / detach

/**
 * Validate a product's new image list. Returns { images, attach: [ids], trash: [ids] } — the caller writes the product
 * first and then calls applyMediaChanges(), so a failed product save never loses photos.
 */
export async function planProductImages(env, productId, current = [], next = []) {
  if (!Array.isArray(next)) throw new HttpError(422, 'images must be a list.');
  if (next.length > MAX_PER_PRODUCT) throw new HttpError(422, `A product can have up to ${MAX_PER_PRODUCT} photos.`, { fields: { images: `Up to ${MAX_PER_PRODUCT} photos.` } });
  const d = db(env);
  const seen = new Set();
  const images = [];
  for (const it of next) {
    const id = typeof it === 'string' ? it : it?.id;
    if (!isMediaId(id) || seen.has(id)) throw new HttpError(422, 'Invalid photo list.', { fields: { images: 'Invalid photo list.' } });
    seen.add(id);
    const m = await d.get(mediaPath(id));
    if (!m || m.product_id !== productId || !['uploaded', 'attached'].includes(m.status)) {
      throw new HttpError(422, 'One of the photos is no longer available. Please upload it again.', { fields: { images: 'A photo expired or is missing.' }, code: 'media_missing', media_id: id });
    }
    images.push(productImage(m, typeof it === 'object' ? String(it.alt ?? m.alt ?? '').slice(0, 140) : undefined));
  }
  const currentIds = (Array.isArray(current) ? current : values(current)).map((i) => i?.id).filter(Boolean);
  return {
    images,
    attach: images.map((i) => i.id).filter((id) => !currentIds.includes(id)),
    trash: currentIds.filter((id) => !seen.has(id)),
    alts: Object.fromEntries(images.map((i) => [i.id, i.alt])),
  };
}

export async function applyMediaChanges(env, { attach = [], trash = [], alts = {} }) {
  const now = nowIso();
  const updates = {};
  for (const id of attach) { updates[`media/${id}/status`] = 'attached'; updates[`media/${id}/expires_at`] = null; updates[`media/${id}/updated_at`] = now; }
  for (const [id, alt] of Object.entries(alts)) updates[`media/${id}/alt`] = alt;
  for (const id of trash) { updates[`media/${id}/status`] = 'trash'; updates[`media/${id}/trashed_at`] = now; updates[`media/${id}/updated_at`] = now; }
  if (Object.keys(updates).length) await db(env).patch('', updates);
}

// --------------------------------------------------------------------------- serving

export function mediaBase(env) {
  return env.S3_PUBLIC_URL ? String(env.S3_PUBLIC_URL).replace(/\/+$/, '') : null;
}

export async function serveMedia(request, env, ctx, key) {
  const isFile = key.startsWith(FILES_PREFIX);
  if (!(key.startsWith(PREFIX) || isFile) || !/^[a-z0-9/._-]+$/.test(key) || key.includes('..')) return new Response('Not found', { status: 404 });
  if (!s3Configured(env) && !env.__s3) return new Response('Not found', { status: 404 });
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const range = request.headers.get('range');
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache && !range) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) {
      const inm = request.headers.get('if-none-match');
      if (inm && inm === hit.headers.get('etag')) return new Response(null, { status: 304, headers: { etag: inm, 'cache-control': IMMUTABLE } });
      return hit;
    }
  }
  const res = await s3(env).getObject(key, { range, ifNoneMatch: request.headers.get('if-none-match') });
  if (res.status === 304) return new Response(null, { status: 304, headers: { etag: res.headers.get('etag') || '', 'cache-control': IMMUTABLE } });
  if (res.status !== 200 && res.status !== 206) return new Response('Not found', { status: 404, headers: { 'cache-control': 'public, max-age=60' } });
  const headers = new Headers({
    'content-type': res.headers.get('content-type') || 'application/octet-stream',
    'cache-control': IMMUTABLE, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff',
    'content-disposition': 'inline', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin',
  });
  if (isFile) {
    headers.set('content-disposition', fileDisposition(key, headers.get('content-type')));
    headers.set('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  }
  for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) if (res.headers.get(h)) headers.set(h, res.headers.get(h));
  const out = new Response(res.body, { status: res.status, headers });
  if (cache && res.status === 200 && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, out.clone()).catch(() => {}));
  return out;
}

// --------------------------------------------------------------------------- cleanup

async function purgeObjects(env, m) {
  const client = s3(env);
  for (const v of Object.values(m.variants || {})) {
    if (v.multipart && v.upload_id && !v.done) await client.abortMultipart(v.key, v.upload_id);
    await client.deleteObject(v.key);
  }
}

/** Run by the cron trigger (and "Run cleanup now"). Returns a summary that is also stored in media_meta/last_cleanup. */
export async function runCleanup(env, { sweep = null, now = Date.now() } = {}) {
  const summary = { at: new Date(now).toISOString(), deleted: 0, expired: 0, aborted: 0, orphans: 0, errors: [] };
  if (!s3Configured(env) && !env.__s3) { summary.skipped = 'storage not configured'; return summary; }
  const d = db(env);
  const client = s3(env);
  const all = (await d.get('media')) || {};
  const active = new Set();
  let budget = 200; // keep each run short

  for (const m of Object.values(all)) {
    if (!m?.id) continue;
    const expired = (m.status === 'uploading' || m.status === 'uploaded') && m.expires_at && m.expires_at < now;
    if (m.status === 'attached' || ((m.status === 'uploading' || m.status === 'uploaded') && !expired)) { active.add(m.id); continue; }
    if (m.status !== 'trash' && !expired) continue;
    if (budget-- <= 0) break;
    try {
      await purgeObjects(env, m);
      await d.remove(mediaPath(m.id));
      if (expired) summary.expired++; else summary.deleted++;
    } catch (e) {
      active.add(m.id);
      const msg = String(e?.message || e).slice(0, 200);
      summary.errors.push(`${m.id}: ${msg}`);
      await d.patch(mediaPath(m.id), { error: msg, cleanup_attempts: (m.cleanup_attempts || 0) + 1 });
    }
  }

  // Stray multipart uploads (e.g. the record was lost): abort anything older than a day that no active record owns.
  try {
    const activeUploads = new Set(Object.values(all).flatMap((m) => (active.has(m?.id) ? Object.values(m.variants || {}).map((v) => v.upload_id) : [])).filter(Boolean));
    for (const u of await client.listMultipart('gomo/')) {
      if (activeUploads.has(u.upload_id)) continue;
      if (u.initiated && Date.parse(u.initiated) > now - 24 * 3600_000) continue;
      await client.abortMultipart(u.key, u.upload_id);
      summary.aborted++;
    }
  } catch (e) {
    summary.errors.push(`list multipart: ${String(e?.message || e).slice(0, 160)}`);
  }

  // Orphan sweep (daily, resumable): objects whose media record is gone or no longer active.
  const meta = (await d.get('media_meta/sweep')) || {};
  const due = sweep ?? (!meta.finished_at || Date.parse(meta.finished_at) < now - 24 * 3600_000 || meta.token);
  if (due) {
    try {
      let token = meta.token || null;
      let scanned = 0;
      do {
        const page = await client.listObjects(PREFIX, token);
        for (const o of page.objects) {
          scanned++;
          const id = o.key.slice(PREFIX.length).split('/')[1];
          if (active.has(id)) continue;
          if (o.last_modified && Date.parse(o.last_modified) > now - ORPHAN_AGE) continue;
          const rec = all[id];
          if (rec && rec.status !== 'trash' && !(rec.expires_at && rec.expires_at < now)) continue;
          await client.deleteObject(o.key);
          summary.orphans++;
        }
        token = page.next;
      } while (token && scanned < 2000);
      await d.put('media_meta/sweep', token ? { token, started_at: meta.started_at || summary.at } : { finished_at: summary.at });
    } catch (e) {
      summary.errors.push(`sweep: ${String(e?.message || e).slice(0, 160)}`);
    }
  }

  await d.put('media_meta/last_cleanup', summary);
  return summary;
}

export async function adminStorageStats(env) {
  const all = values(await db(env).get('media'));
  const by_status = {};
  let bytes = 0;
  for (const m of all) {
    by_status[m.status] = (by_status[m.status] || 0) + 1;
    if (m.status === 'attached') for (const v of Object.values(m.variants || {})) bytes += Number(v.size) || 0;
  }
  return json({
    configured: s3Configured(env), public_url: mediaBase(env), bucket: env.S3_BUCKET || null, endpoint: env.S3_ENDPOINT ? new URL(env.S3_ENDPOINT).host : null,
    by_status, attached_bytes: bytes, last_cleanup: (await db(env).get('media_meta/last_cleanup')) || null,
  });
}

export async function adminTestStorage(env) {
  requireStorage(env);
  const client = s3(env);
  const key = `gomo/_probe/${Date.now()}.txt`;
  const steps = [];
  const step = async (name, fn) => {
    const t = Date.now();
    try { await fn(); steps.push({ name, ok: true, ms: Date.now() - t }); } catch (e) { steps.push({ name, ok: false, error: String(e?.message || e).slice(0, 200) }); throw e; }
  };
  try {
    const payload = new TextEncoder().encode('gomo storage probe');
    await step('upload', () => client.putObject(key, payload, { contentType: 'text/plain', contentLength: payload.length }));
    await step('check', async () => { const h = await client.head(key); if (!h || h.size !== payload.length) throw new Error('size mismatch'); });
    await step('read', async () => { const r = await client.getObject(key); if (r.status !== 200) throw new Error(`HTTP ${r.status}`); await r.arrayBuffer(); });
    await step('multipart', async () => { const id = await client.createMultipart(`${key}.mp`, 'text/plain'); await client.abortMultipart(`${key}.mp`, id); });
  } catch { /* reported in steps */ } finally {
    try { await client.deleteObject(key); steps.push({ name: 'delete', ok: true }); } catch (e) { steps.push({ name: 'delete', ok: false, error: String(e?.message || e) }); }
  }
  return json({ ok: steps.every((s) => s.ok), steps });
}
