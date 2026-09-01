/**
 * Static files from public/.
 *
 * Small enough to read on demand; the whole asset set is one stylesheet, two scripts and an
 * icon. Files are cached in memory after the first read in production and re-read every time
 * in development, so editing the stylesheet does not mean restarting the server.
 *
 * PATH SAFETY. The resolved path must still be inside the root directory after resolution, so
 * neither `../` nor an encoded variant of it can escape. A request that resolves outside is a
 * 404, not a 403 — there is nothing to confirm.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { baseHeaders } from './http.mjs';

const TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
]);

export function createStaticHandler({ root, cache = true }) {
  const memo = new Map();

  async function load(filePath) {
    if (cache && memo.has(filePath)) return memo.get(filePath);
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const body = await readFile(filePath);
    const entry = { body, etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
    if (cache) memo.set(filePath, entry);
    return entry;
  }

  /** Returns true when it served the request. */
  return async function serveStatic(req, res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }

    const resolved = path.resolve(root, `.${decoded}`);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;

    let entry;
    try {
      entry = await load(resolved);
    } catch {
      return false;
    }
    if (!entry) return false;

    const type = TYPES.get(path.extname(resolved).toLowerCase()) ?? 'application/octet-stream';

    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, baseHeaders({ etag: entry.etag }));
      res.end();
      return true;
    }

    res.writeHead(200, baseHeaders({
      'content-type': type,
      'content-length': entry.body.length,
      etag: entry.etag,
      // Short, because assets are not fingerprinted. A deploy should not need a hard refresh.
      'cache-control': cache ? 'public, max-age=300' : 'no-store',
    }));
    if (req.method === 'HEAD') res.end();
    else res.end(entry.body);
    return true;
  };
}
