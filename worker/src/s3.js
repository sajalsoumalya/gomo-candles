// Minimal S3 client (AWS Signature V4, path-style) for S3-compatible storage such as RustFS / MinIO.
// Large bodies are streamed with x-amz-content-sha256: UNSIGNED-PAYLOAD (no hashing of file data in the Worker).

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (data) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** RFC 3986 encoding as SigV4 requires. */
export const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export const encodeKeyPath = (key) => String(key).split('/').map(uriEncode).join('/');

/**
 * Compute SigV4 headers. headers must include every header listed in `sign` (lower-case names); host is always signed.
 * Returns the Authorization header value.
 */
export async function signRequest({ method, host, path, query = {}, headers = {}, sign = [], payloadHash, amzDate, region, service = 's3', accessKeyId, secretAccessKey }) {
  const dateStamp = amzDate.slice(0, 8);
  const h = { host, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])) };
  const signed = [...new Set(['host', 'x-amz-content-sha256', 'x-amz-date', ...sign.map((s) => s.toLowerCase())])].filter((k) => k in h).sort();
  const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k] ?? '')}`).join('&');
  const canonicalRequest = [method, path, canonicalQuery, signed.map((k) => `${k}:${h[k]}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  let key = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, 'aws4_request');
  const signature = hex(await hmac(key, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
}

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export const xmlTag = (xml, tag) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml); return m ? decodeXml(m[1]) : null; };
export const xmlBlocks = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

export class S3Error extends Error {
  constructor(status, code, message) { super(`S3 ${status} ${code}: ${message}`); this.status = status; this.code = code; }
}

export function s3Configured(env) {
  return Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
}

export function s3(env, fetchImpl = fetch) {
  if (env.__s3) return env.__s3; // test hook
  if (!s3Configured(env)) throw new S3Error(500, 'NotConfigured', 'S3 storage is not configured on the Worker.');
  const endpoint = new URL(String(env.S3_ENDPOINT).replace(/\/+$/, ''));
  const region = env.S3_REGION || 'us-east-1';
  const bucket = env.S3_BUCKET;
  const basePath = endpoint.pathname.replace(/\/+$/, '');

  async function request(method, key, { query = {}, headers = {}, body, payloadHash = 'UNSIGNED-PAYLOAD', retry = true, timeout = 30000 } = {}) {
    const path = `${basePath}/${uriEncode(bucket)}${key != null ? '/' + encodeKeyPath(key) : ''}`;
    const qs = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k] ?? '')}`).join('&');
    const url = `${endpoint.origin}${path}${qs ? '?' + qs : ''}`;
    const attempts = retry ? 3 : 1;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const h = { ...headers, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
      h.authorization = await signRequest({
        method, host: endpoint.host, path, query, headers: h, payloadHash, amzDate, region,
        accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetchImpl(url, { method, headers: h, body, signal: ctrl.signal });
        if (res.status >= 500 && i < attempts - 1) { lastErr = new S3Error(res.status, 'ServerError', await res.text().catch(() => '')); }
        else return res;
      } catch (e) {
        lastErr = e?.name === 'AbortError' ? new S3Error(504, 'Timeout', 'Storage did not respond in time') : new S3Error(502, 'Network', String(e?.message || e));
        if (!retry) break;
      } finally {
        clearTimeout(timer);
      }
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
    throw lastErr;
  }

  async function check(res, okStatuses = [200]) {
    if (okStatuses.includes(res.status)) return res;
    const text = await res.text().catch(() => '');
    throw new S3Error(res.status, xmlTag(text, 'Code') || 'Error', (xmlTag(text, 'Message') || text).slice(0, 200));
  }

  return {
    bucket,
    /** Upload a whole object. body: ArrayBuffer | Uint8Array | ReadableStream (streams need contentLength + retry:false). */
    async putObject(key, body, { contentType = 'application/octet-stream', contentLength, cacheControl, retry, timeout, disposition } = {}) {
      const headers = { 'content-type': contentType };
      if (contentLength != null) headers['content-length'] = String(contentLength);
      if (cacheControl) headers['cache-control'] = cacheControl;
      if (disposition) headers['content-disposition'] = disposition;
      const res = await check(await request('PUT', key, { headers, body, retry: retry ?? !(body instanceof ReadableStream), ...(timeout ? { timeout } : {}) }));
      return { etag: res.headers.get('etag') };
    },
    async createMultipart(key, contentType = 'application/octet-stream', cacheControl) {
      const headers = { 'content-type': contentType };
      if (cacheControl) headers['cache-control'] = cacheControl;
      const res = await check(await request('POST', key, { query: { uploads: '' }, headers, payloadHash: EMPTY_SHA256 }));
      const uploadId = xmlTag(await res.text(), 'UploadId');
      if (!uploadId) throw new S3Error(502, 'BadResponse', 'No UploadId returned');
      return uploadId;
    },
    async uploadPart(key, uploadId, partNumber, body, contentLength) {
      const res = await check(await request('PUT', key, {
        query: { partNumber: String(partNumber), uploadId }, headers: { 'content-length': String(contentLength) }, body,
        retry: !(body instanceof ReadableStream), timeout: 120000,
      }));
      const etag = res.headers.get('etag');
      if (!etag) throw new S3Error(502, 'BadResponse', 'No ETag for uploaded part');
      return etag;
    },
    async completeMultipart(key, uploadId, parts) {
      const xml = `<CompleteMultipartUpload>${parts.sort((a, b) => a.n - b.n)
        .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const res = await check(await request('POST', key, {
        query: { uploadId }, headers: { 'content-type': 'application/xml' }, body: xml, payloadHash: await sha256Hex(xml), timeout: 120000,
      }));
      const text = await res.text();
      if (/<Error>/.test(text)) throw new S3Error(500, xmlTag(text, 'Code') || 'Error', xmlTag(text, 'Message') || 'Complete failed');
      return { etag: xmlTag(text, 'ETag') };
    },
    async abortMultipart(key, uploadId) {
      await check(await request('DELETE', key, { query: { uploadId }, payloadHash: EMPTY_SHA256 }), [200, 204, 404]);
    },
    async listMultipart(prefix) {
      const res = await check(await request('GET', null, { query: { uploads: '', prefix }, payloadHash: EMPTY_SHA256 }));
      const text = await res.text();
      return xmlBlocks(text, 'Upload').map((b) => ({ key: xmlTag(b, 'Key'), upload_id: xmlTag(b, 'UploadId'), initiated: xmlTag(b, 'Initiated') }));
    },
    async head(key) {
      // Size from the bucket listing — reliable on RustFS, where HEAD can report 0 bytes or fail behind nginx.
      const listSize = async () => {
        const res2 = await check(await request('GET', null, { query: { 'list-type': '2', prefix: key, 'max-keys': '1' }, payloadHash: EMPTY_SHA256 }));
        const hit = xmlBlocks(await res2.text(), 'Contents').find((b) => xmlTag(b, 'Key') === key);
        return hit ? Number(xmlTag(hit, 'Size')) : null;
      };
      let res;
      try { res = await request('HEAD', key, { payloadHash: EMPTY_SHA256 }); } catch (e) {
        console.error('s3 HEAD failed, using listing', key, e?.status, e?.code, String(e?.message || e).slice(0, 160));
        const size = await listSize();
        return size == null ? null : { size, etag: null, content_type: null };
      }
      if (res.status === 404) return null;
      if (res.status !== 200) {
        console.error('s3 HEAD status', res.status, key);
        const size = await listSize();
        return size == null ? null : { size, etag: null, content_type: null };
      }
      const out = { size: Number(res.headers.get('content-length')), etag: res.headers.get('etag'), content_type: res.headers.get('content-type') };
      if (!(out.size > 0)) out.size = (await listSize()) ?? out.size;
      return out;
    },
    /** Raw GET; pass through range / if-none-match. Caller handles status. */
    async getObject(key, { range, ifNoneMatch } = {}) {
      const headers = {};
      if (range) headers.range = range;
      if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
      return request('GET', key, { headers, payloadHash: EMPTY_SHA256 });
    },
    async deleteObject(key) {
      await check(await request('DELETE', key, { payloadHash: EMPTY_SHA256 }), [200, 204, 404]);
    },
    async listObjects(prefix, continuationToken) {
      const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (continuationToken) query['continuation-token'] = continuationToken;
      const res = await check(await request('GET', null, { query, payloadHash: EMPTY_SHA256 }));
      const text = await res.text();
      return {
        objects: xmlBlocks(text, 'Contents').map((b) => ({ key: xmlTag(b, 'Key'), size: Number(xmlTag(b, 'Size')), last_modified: xmlTag(b, 'LastModified') })),
        next: xmlTag(text, 'IsTruncated') === 'true' ? xmlTag(text, 'NextContinuationToken') : null,
      };
    },
  };
}
