// General file library on the same RustFS / S3 bucket as product photos (banners, PDFs, documents, anything).
// Files live under gomo/files/{id}/{name}; product-photo cleanup only touches gomo/products/, so it never removes these.
// files/{id} = { id, name, key, type, size, folder, note, created_at, uploaded_by }
// Uploads are a single streamed PUT through the Worker (keys never reach the browser), up to MAX_FILE_BYTES.

import { HttpError, json, nowIso } from './util.js';
import { db, pushKey, values } from './db.js';
import { s3, s3Configured } from './s3.js';
import { bodyStream, declaredLength } from './media.js';

export const FILES_PREFIX = 'gomo/files/';
export const MAX_FILE_BYTES = 95 * 1024 * 1024; // Cloudflare free plan request bodies are capped at 100 MB
const IMMUTABLE = 'public, max-age=31536000, immutable';
// Shown in the browser; everything else downloads. HTML/SVG/JS never render, so a file can't run script on the API's domain.
const INLINE_TYPES = /^(image\/(jpeg|png|webp|avif|gif)|application\/pdf|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav)|text\/plain)$/;

const isFileId = (id) => /^[a-z0-9]{10,24}$/.test(String(id || ''));

/** "My Banner (1).PNG" → "my-banner-1.png"; keeps the extension, safe for URLs and the /media/ route. */
export function safeFileName(name) {
  const raw = String(name || '').trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const m = /^(.*?)(\.[a-z0-9]{1,8})?$/.exec(raw);
  const base = (m[1] || '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'file';
  return base + (m[2] || '');
}

export const fileDisposition = (key, type) => {
  const name = String(key).split('/').pop();
  return `${INLINE_TYPES.test(String(type || '').split(';')[0].trim()) ? 'inline' : 'attachment'}; filename="${name}"`;
};

function requireStorage(env) {
  if (!s3Configured(env) && !env.__s3) throw new HttpError(503, 'File storage is not set up yet. Add the S3_* Worker secrets.', { code: 'storage_unconfigured' });
}

const cleanFolder = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

const publicFile = (f) => ({ id: f.id, name: f.name, key: f.key, type: f.type, size: f.size, folder: f.folder || '', note: f.note || '', created_at: f.created_at, uploaded_by: f.uploaded_by || null });

/** PUT /api/admin/files?name=&folder=&note=   body = file bytes, Content-Type = file type. */
export async function adminUploadFile(request, env, admin) {
  requireStorage(env);
  const url = new URL(request.url);
  const original = String(url.searchParams.get('name') || '').slice(0, 160);
  if (!original.trim()) throw new HttpError(422, 'File name is missing.');
  const len = declaredLength(request);
  if (len > MAX_FILE_BYTES) throw new HttpError(413, `Files can be up to ${Math.round(MAX_FILE_BYTES / 1048576)} MB.`);
  const type = (String(request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream').slice(0, 100);

  const id = pushKey();
  const key = `${FILES_PREFIX}${id}/${safeFileName(original)}`;
  await s3(env).putObject(key, bodyStream(request, len), {
    contentType: type, contentLength: len, cacheControl: IMMUTABLE, disposition: fileDisposition(key, type), retry: false, timeout: 300000,
  });
  const rec = {
    id, name: original.trim(), key, type, size: len, folder: cleanFolder(url.searchParams.get('folder')),
    note: String(url.searchParams.get('note') || '').trim().slice(0, 200), created_at: nowIso(), uploaded_by: admin?.email || null,
  };
  try {
    await db(env).put(`files/${id}`, rec);
  } catch (e) {
    await s3(env).deleteObject(key).catch(() => {}); // don't leave an object nobody can see
    throw e;
  }
  return json({ file: publicFile(rec) }, 201);
}

export async function adminListFiles(request, env) {
  const url = new URL(request.url);
  const folder = cleanFolder(url.searchParams.get('folder'));
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 60);
  const all = values(await db(env).get('files')).filter((f) => f?.id);
  const folders = [...new Set(all.map((f) => f.folder).filter(Boolean))].sort();
  let rows = all;
  if (folder) rows = rows.filter((f) => f.folder === folder);
  if (q) rows = rows.filter((f) => f.name.toLowerCase().includes(q) || (f.note || '').toLowerCase().includes(q));
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return json({
    files: rows.slice(0, 500).map(publicFile), total: rows.length, folders,
    bytes: all.reduce((s, f) => s + (Number(f.size) || 0), 0), max_bytes: MAX_FILE_BYTES,
  });
}

export async function adminUpdateFile(env, id, body) {
  if (!isFileId(id)) throw new HttpError(404, 'File not found.');
  const d = db(env);
  const f = await d.get(`files/${id}`);
  if (!f) throw new HttpError(404, 'File not found.');
  const patch = {};
  if ('folder' in body) patch.folder = cleanFolder(body.folder);
  if ('note' in body) patch.note = String(body.note || '').trim().slice(0, 200);
  if ('name' in body) { const n = String(body.name || '').trim().slice(0, 160); if (n) patch.name = n; } // display name only; the link stays the same
  if (Object.keys(patch).length) await d.patch(`files/${id}`, patch);
  return json({ file: publicFile({ ...f, ...patch }) });
}

export async function adminDeleteFile(request, env, id) {
  requireStorage(env);
  if (!isFileId(id)) throw new HttpError(404, 'File not found.');
  const d = db(env);
  const f = await d.get(`files/${id}`);
  if (!f) throw new HttpError(404, 'File not found.');
  await s3(env).deleteObject(f.key);
  await d.remove(`files/${id}`);
  // Drop the edge-cached copy served by /media/… on this data centre.
  if (typeof caches !== 'undefined') {
    const u = new URL(request.url);
    await caches.default.delete(new Request(`${u.origin}/media/${f.key}`)).catch(() => {});
  }
  return json({ ok: true });
}
