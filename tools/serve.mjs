// Local preview of the shop that behaves like Firebase Hosting:
// real files are served as-is; any other path (/shop, /shipping-policy, /track/…) falls back to index.html.
// Usage: node tools/serve.mjs [port]   (default 5500)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.argv[2]) || 5500;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(root, path));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, 'index.html');
    await stat(file);
  } catch {
    // Missing file with an extension (e.g. /assets/x.png) is a real 404; anything else is a page route.
    if (extname(path)) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
    file = join(root, 'index.html');
  }
  const body = await readFile(file);
  res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(body);
}).listen(port, '127.0.0.1', () => console.log(`GoMo shop preview: http://127.0.0.1:${port}/`));
