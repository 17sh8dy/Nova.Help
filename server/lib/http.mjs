/**
 * HTTP plumbing: responses, cookies and the security headers every response carries.
 *
 * THE CONTENT SECURITY POLICY IS THE REASON THIS FILE EXISTS IN ONE PIECE. A support portal
 * renders text that strangers typed — a subject line, a description, a filename — on a page
 * that can also show their uploaded files. Escaping on output is the first defence and the
 * policy below is the second: no inline script, no third-party origin, nothing framed. It is
 * set here rather than per-route so a page added later cannot forget it.
 */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

export function baseHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

export function sendHtml(res, html, { status = 200, headers = {} } = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, baseHeaders({
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  }));
  res.end(body);
}

export function sendJson(res, data, { status = 200, headers = {} } = {}) {
  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  res.writeHead(status, baseHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  }));
  res.end(body);
}

export function sendText(res, text, { status = 200, headers = {} } = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, baseHeaders({
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    ...headers,
  }));
  res.end(body);
}

export function redirect(res, location, { status = 303, headers = {} } = {}) {
  res.writeHead(status, baseHeaders({ location, 'cache-control': 'no-store', ...headers }));
  res.end();
}

/* ── Cookies ───────────────────────────────────────────────────────────────────────────── */

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * `secure` is off when the server is running over plain HTTP in development, because a Secure
 * cookie is silently dropped there and the ticket page would appear to forget you instantly.
 */
export function cookie(name, value, { maxAge, secure = false, path = '/' } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  if (maxAge != null) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  return parts.join('; ');
}

export const clearCookie = (name, options = {}) => cookie(name, '', { ...options, maxAge: 0 });

/** Append a Set-Cookie to headers that may already carry one. */
export function withCookie(headers, value) {
  const existing = headers['set-cookie'];
  if (!existing) return { ...headers, 'set-cookie': value };
  return { ...headers, 'set-cookie': [].concat(existing, value) };
}

/* ── Request helpers ───────────────────────────────────────────────────────────────────── */

/** The client address, trusting a proxy header only when explicitly told to. */
export function clientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? null;
}

/** True when the request looks like fetch() rather than a form navigation. */
export const wantsJson = (req) => String(req.headers.accept ?? '').includes('application/json');
