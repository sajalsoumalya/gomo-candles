import { describe, it, expect } from 'vitest';
import { safeFileName, fileDisposition, adminUploadFile, adminDeleteFile, FILES_PREFIX } from '../src/files.js';
import { serveMedia } from '../src/media.js';

function fakeEnv() {
  const store = {}, objects = {};
  const __db = {
    get: async (p) => p.split('/').reduce((o, k) => o?.[k], store) ?? null,
    put: async (p, v) => { const ks = p.split('/'); let o = store; for (const k of ks.slice(0, -1)) o = o[k] ||= {}; o[ks.at(-1)] = v; },
    remove: async (p) => { const ks = p.split('/'); let o = store; for (const k of ks.slice(0, -1)) o = o?.[k]; if (o) delete o[ks.at(-1)]; },
  };
  const __s3 = {
    putObject: async (key, body, opts) => { objects[key] = { body: new Uint8Array(await new Response(await body).arrayBuffer()), ...opts }; return {}; },
    deleteObject: async (key) => { delete objects[key]; },
    getObject: async (key) => objects[key]
      ? new Response(objects[key].body, { status: 200, headers: { 'content-type': objects[key].contentType } })
      : new Response('', { status: 404 }),
  };
  return { env: { __db, __s3 }, store, objects };
}

describe('file names and disposition', () => {
  it('makes safe lowercase names and keeps the extension', () => {
    expect(safeFileName('My Banner (1).PNG')).toBe('my-banner-1.png');
    expect(safeFileName('../../etc/passwd')).toBe('etc-passwd');
    expect(safeFileName('')).toBe('file');
  });
  it('downloads risky types instead of rendering them', () => {
    expect(fileDisposition('a/b/x.pdf', 'application/pdf')).toMatch(/^inline/);
    expect(fileDisposition('a/b/x.html', 'text/html')).toMatch(/^attachment/);
    expect(fileDisposition('a/b/x.svg', 'image/svg+xml')).toMatch(/^attachment/);
  });
});

describe('upload → serve → delete', () => {
  it('stores the file in the bucket and serves it sandboxed', async () => {
    const { env, store, objects } = fakeEnv();
    const bytes = new TextEncoder().encode('<script>alert(1)</script>');
    const req = new Request('https://api.test/api/admin/files?name=Page.html&folder=Docs', {
      method: 'PUT', body: bytes, headers: { 'content-type': 'text/html', 'content-length': String(bytes.length) },
    });
    const res = await adminUploadFile(req, env, { email: 'a@b.c' });
    expect(res.status).toBe(201);
    const { file } = await res.json();
    expect(file.key.startsWith(FILES_PREFIX)).toBe(true);
    expect(file.folder).toBe('docs');
    expect(store.files[file.id].uploaded_by).toBe('a@b.c');
    expect(objects[file.key].body.length).toBe(bytes.length);

    const served = await serveMedia(new Request(`https://api.test/media/${file.key}`), env, null, file.key);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(served.headers.get('content-security-policy')).toMatch(/sandbox/);

    await adminDeleteFile(new Request('https://api.test/x'), env, file.id);
    expect(objects[file.key]).toBeUndefined();
    expect(store.files[file.id]).toBeUndefined();
  });

  it('rejects files over the size limit before uploading', async () => {
    const { env, objects } = fakeEnv();
    const req = new Request('https://api.test/api/admin/files?name=big.zip', { method: 'PUT', headers: { 'content-length': String(200 * 1024 * 1024) } });
    await expect(adminUploadFile(req, env, null)).rejects.toMatchObject({ status: 413 });
    expect(Object.keys(objects)).toHaveLength(0);
  });

  it('still refuses keys outside the photo and file folders', async () => {
    const { env } = fakeEnv();
    const r = await serveMedia(new Request('https://api.test/media/gomo/_probe/x.txt'), env, null, 'gomo/_probe/x.txt');
    expect(r.status).toBe(404);
  });
});
