// Photo upload engine for the admin panel.
// 1. prepare(): decode the photo (EXIF-aware), make a web-optimised WebP (max 2000 px) + 480 px thumbnail, hash the original.
// 2. upload(): create the upload on the Worker, send small files in one request and large originals in 8 MB parts
//    (3 in parallel, each retried up to 3 times), then complete. Progress is reported in bytes.
// 3. resume(): an interrupted upload continues with only the missing parts once the same file is picked again.
import { API_BASE } from './firebase-config.js';
import { getToken } from './auth.js';
import { api } from './api.js';

const WEB_MAX = 2000;
const THUMB_MAX = 480;
const PARALLEL = 3;
const RETRIES = 3;
const PENDING_KEY = 'gomo_admin_pending_uploads';
export const MAX_ORIGINAL = 50 * 1024 * 1024;
export const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif';

export const mediaUrl = (key) => `${API_BASE}/media/${String(key).split('/').map(encodeURIComponent).join('/')}`;

// ---------------------------------------------------------------- local record of unfinished uploads (for resume)
export function pendingUploads() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}'); } catch { return {}; }
}
function rememberPending(id, info) { const p = pendingUploads(); p[id] = info; localStorage.setItem(PENDING_KEY, JSON.stringify(p)); }
export function forgetPending(id) { const p = pendingUploads(); delete p[id]; localStorage.setItem(PENDING_KEY, JSON.stringify(p)); }

// ---------------------------------------------------------------- image processing

async function sha256(file) {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function scaled(bitmap, max, quality) {
  const ratio = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  const h = Math.max(1, Math.round(bitmap.height * ratio));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, w, h);
  let blob = await canvasBlob(c, 'image/webp', quality);
  if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(c, 'image/jpeg', quality); // Safari < 14 has no WebP encoder
  return { blob, w, h, canvas: c };
}

/** True if the photo has see-through parts (e.g. a cut-out product on no background). */
function hasTransparency(canvas) {
  const c = document.createElement('canvas');
  const s = Math.min(1, 160 / Math.max(canvas.width, canvas.height));
  c.width = Math.max(1, Math.round(canvas.width * s)); c.height = Math.max(1, Math.round(canvas.height * s));
  const g = c.getContext('2d');
  g.drawImage(canvas, 0, 0, c.width, c.height);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let clear = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 230) clear++;
  return clear / (px.length / 4) > 0.01;
}

function dominantColor(canvas) {
  const c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  const g = c.getContext('2d');
  g.drawImage(canvas, 0, 0, 1, 1);
  const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
  return '#' + [r, gg, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class UploadError extends Error {
  constructor(message, data) { super(message); this.data = data; }
}

/** Validate + process a picked file. Returns { file, sha, web, thumb, w, h, color, preview }. */
export async function prepare(file) {
  if (!file || !file.type.startsWith('image/')) throw new UploadError('Please choose a photo (JPEG, PNG, WebP or HEIC).');
  if (!ACCEPT.split(',').includes(file.type)) throw new UploadError(`${file.type.replace('image/', '').toUpperCase()} files are not supported. Use JPEG, PNG or WebP.`);
  if (file.size > MAX_ORIGINAL) throw new UploadError(`This photo is ${(file.size / 1048576).toFixed(0)} MB. The limit is 50 MB.`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new UploadError(/heic|heif/.test(file.type)
      ? 'This browser cannot read HEIC photos. Use Safari, or export the photo as JPEG first.'
      : 'This photo could not be read. It may be damaged — try exporting it again.');
  }
  if (bitmap.width < 300 || bitmap.height < 300) throw new UploadError('This photo is too small. Use at least 600 × 600 pixels for a sharp product photo.');
  const [web, thumb, sha] = await Promise.all([scaled(bitmap, WEB_MAX, 0.85), scaled(bitmap, THUMB_MAX, 0.8), sha256(file)]);
  const transparent = hasTransparency(thumb.canvas);
  const color = transparent ? null : dominantColor(thumb.canvas);
  bitmap.close?.();
  return { file, sha, web: web.blob, thumb: thumb.blob, w: web.w, h: web.h, color, transparent, preview: URL.createObjectURL(thumb.blob) };
}

// ---------------------------------------------------------------- transport

function putBytes(path, body, { signal, onProgress }) {
  return new Promise(async (resolve, reject) => {
    let token;
    try { token = await getToken(); } catch (e) { return reject(e); }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', API_BASE + path);
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new UploadError(data.error || `Upload failed (${xhr.status})`, data), { status: xhr.status }));
    };
    xhr.onerror = () => reject(Object.assign(new UploadError('Network error while uploading.'), { status: 0 }));
    xhr.onabort = () => reject(Object.assign(new UploadError('Upload cancelled.'), { cancelled: true }));
    if (signal) {
      if (signal.aborted) { xhr.abort(); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

async function withRetry(fn, signal) {
  let last;
  for (let i = 0; i < RETRIES; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e.cancelled || signal?.aborted) throw e;
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e; // not retryable
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
  throw last;
}

/**
 * Upload a prepared photo for a product.
 * opts: { productId, alt, signal, onProgress(fraction, label), media (existing record to resume), allowDuplicate }
 * Resolves with the completed media record.
 */
export async function upload(prep, opts) {
  const { productId, signal, onProgress } = opts;
  const blobs = { original: prep.file, web: prep.web, thumb: prep.thumb };
  let media = opts.media;
  if (!media) {
    const created = await api('/api/admin/media', {
      method: 'POST',
      body: {
        product_id: productId, filename: prep.file.name, sha256: prep.sha, w: prep.w, h: prep.h, color: prep.color, transparent: !!prep.transparent, alt: opts.alt || '',
        allow_duplicate: !!opts.allowDuplicate,
        variants: Object.fromEntries(Object.entries(blobs).map(([k, b]) => [k, { type: b.type, size: b.size }])),
      },
    });
    media = created.media;
  }
  rememberPending(media.id, { productId, name: prep.file.name, size: prep.file.size, sha: prep.sha, at: Date.now() });

  // progress bookkeeping
  const total = Object.values(blobs).reduce((s, b) => s + b.size, 0);
  const sent = {};
  const report = (label) => onProgress?.(Math.min(0.99, Object.values(sent).reduce((s, n) => s + n, 0) / total), label);

  const jobs = [];
  for (const [name, v] of Object.entries(media.variants)) {
    const blob = blobs[name];
    if (!blob) throw new UploadError(`Missing ${name} file.`);
    if (v.done) { sent[name] = blob.size; continue; }
    if (!v.multipart) {
      jobs.push(() => withRetry(() => putBytes(`/api/admin/media/${media.id}/${name}`, blob, {
        signal, onProgress: (n) => { sent[name] = n; report(name === 'original' ? 'Uploading original' : 'Uploading'); },
      }), signal).then(() => { sent[name] = blob.size; report(); }));
      continue;
    }
    for (let n = 1; n <= v.parts_total; n++) {
      const key = `${name}:${n}`;
      const start = (n - 1) * v.part_size;
      const part = blob.slice(start, Math.min(blob.size, start + v.part_size));
      if (v.parts_done.includes(n)) { sent[key] = part.size; continue; }
      jobs.push(() => withRetry(() => putBytes(`/api/admin/media/${media.id}/${name}/parts/${n}`, part, {
        signal, onProgress: (b) => { sent[key] = b; report(`Uploading part ${n} of ${v.parts_total}`); },
      }), signal).then(() => { sent[key] = part.size; report(); }));
    }
  }
  report('Starting');

  let next = 0;
  let failed = null;
  const worker = async () => {
    while (next < jobs.length && !failed) {
      const job = jobs[next++];
      try { await job(); } catch (e) { failed = failed || e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
  if (failed) throw failed;

  onProgress?.(0.995, 'Finishing');
  const done = await withRetry(() => api(`/api/admin/media/${media.id}/complete`, { method: 'POST' }), signal);
  onProgress?.(1, 'Uploaded');
  forgetPending(media.id);
  return done.media;
}

/** Cancel / discard an upload that is not on a product. keepalive lets it finish while the page is closing. */
export async function discard(id, { keepalive = false } = {}) {
  forgetPending(id);
  try {
    const token = await getToken();
    await fetch(`${API_BASE}/api/admin/media/${id}/delete`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, keepalive });
  } catch { /* the cleanup job removes it later */ }
}
