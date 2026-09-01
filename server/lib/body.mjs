/**
 * Request bodies: URL-encoded forms, JSON, and multipart uploads.
 *
 * WHY THERE IS A MULTIPART PARSER HERE. The ticket form posts files, and it posts them as a
 * plain HTML form so that submitting a ticket does not depend on JavaScript. That requires
 * multipart/form-data, and this project has no dependencies, so it requires this file. It is
 * about a hundred lines because it does exactly what this application needs and nothing else:
 * no streaming to disk, no nested multipart, no transfer encodings.
 *
 * THE SIZE CAP IS ENFORCED WHILE READING. `readBody` counts bytes as they arrive and destroys
 * the socket the moment the total passes the limit, so a large upload costs a bounded amount
 * of memory and never reaches the parser. Per-file limits are applied afterwards, on parts
 * that are already known to fit inside the total.
 */

/** Read the whole body into memory, or stop early. Returns `{ ok, buffer }` / `{ ok: false }`. */
export function readBody(req, { limit }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, reason: 'too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks) }));
    req.on('aborted', () => finish({ ok: false, reason: 'aborted' }));
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

const rawContentType = (req) => String(req.headers['content-type'] ?? '');

/**
 * The content type, lowercased — for COMPARING against, and for nothing else.
 *
 * The media type is case-insensitive, so lowercasing is right for deciding which parser to
 * use. A multipart BOUNDARY is not: it is a literal string that has to match the bytes in the
 * body exactly. Reading it out of the lowercased header meant that any client whose boundary
 * contained a capital letter parsed to no fields at all — which is Chrome, Safari and Edge,
 * all of which send `----WebKitFormBoundary...`. Firefox sends digits and worked, and so did
 * the test suite, because undici's FormData boundary happens to be lowercase too.
 */
const contentType = (req) => rawContentType(req).toLowerCase();

/** Turn URLSearchParams into a plain object, keeping the last value for repeated keys. */
function paramsToObject(params) {
  const out = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

/**
 * Parse a request body into `{ ok, fields, files }`.
 *
 * `fields` is always a plain object of strings; `files` is always an array (empty for form and
 * JSON bodies). Callers therefore never branch on the content type.
 */
export async function parseBody(req, { limit = 32 * 1024 * 1024, maxFileBytes = Infinity } = {}) {
  const type = contentType(req);

  if (type.startsWith('multipart/form-data')) {
    // From the RAW header: the boundary is matched byte for byte against the body.
    const boundary = /boundary="?([^";]+)"?/i.exec(rawContentType(req))?.[1];
    if (!boundary) return { ok: false, reason: 'bad-multipart', fields: {}, files: [] };

    const body = await readBody(req, { limit });
    if (!body.ok) return { ...body, fields: {}, files: [] };

    const parsed = parseMultipart(body.buffer, boundary, { maxFileBytes });
    return { ok: true, ...parsed };
  }

  if (type.startsWith('application/json')) {
    const body = await readBody(req, { limit: Math.min(limit, 1024 * 1024) });
    if (!body.ok) return { ...body, fields: {}, files: [] };
    try {
      const parsed = JSON.parse(body.buffer.toString('utf8') || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'bad-json', fields: {}, files: [] };
      }
      return { ok: true, fields: parsed, files: [] };
    } catch {
      return { ok: false, reason: 'bad-json', fields: {}, files: [] };
    }
  }

  const body = await readBody(req, { limit: Math.min(limit, 1024 * 1024) });
  if (!body.ok) return { ...body, fields: {}, files: [] };
  return {
    ok: true,
    fields: paramsToObject(new URLSearchParams(body.buffer.toString('utf8'))),
    files: [],
  };
}

/* ── multipart/form-data ───────────────────────────────────────────────────────────────── */

const CRLF2 = Buffer.from('\r\n\r\n');

/** Split a buffer on a delimiter without copying until the pieces are needed. */
function split(buffer, delimiter) {
  const pieces = [];
  let start = 0;
  for (;;) {
    const at = buffer.indexOf(delimiter, start);
    if (at === -1) break;
    pieces.push(buffer.subarray(start, at));
    start = at + delimiter.length;
  }
  pieces.push(buffer.subarray(start));
  return pieces;
}

function parseHeaders(raw) {
  const headers = {};
  for (const line of raw.toString('utf8').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/**
 * Read `name="..."` from a Content-Disposition header.
 *
 * Filenames arrive percent-encoded from some clients and raw from others; both are handled,
 * and the result is only ever used as a label — `core/attachments.mjs` never lets it near a
 * filesystem path.
 */
function dispositionValue(header, key) {
  const quoted = new RegExp(`${key}="([^"]*)"`).exec(header);
  const bare = new RegExp(`${key}=([^;]+)`).exec(header);
  const raw = quoted?.[1] ?? bare?.[1]?.trim();
  if (raw == null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseMultipart(buffer, boundary, { maxFileBytes = Infinity } = {}) {
  const fields = {};
  const files = [];
  const sections = split(buffer, Buffer.from(`--${boundary}`));

  for (const section of sections) {
    // The preamble, the epilogue ("--\r\n") and empty separators are not parts.
    if (section.length < 4) continue;
    const headerEnd = section.indexOf(CRLF2);
    if (headerEnd === -1) continue;

    const headers = parseHeaders(section.subarray(0, headerEnd));
    const disposition = headers['content-disposition'];
    if (!disposition) continue;

    const name = dispositionValue(disposition, 'name');
    if (!name) continue;

    // Body runs from after the blank line to the CRLF that precedes the next boundary.
    let body = section.subarray(headerEnd + CRLF2.length);
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.subarray(0, body.length - 2);
    }

    const filename = dispositionValue(disposition, 'filename');
    if (filename === null) {
      fields[name] = body.toString('utf8');
      continue;
    }

    // An empty file input still sends a part, with an empty filename and no bytes.
    if (!filename && body.length === 0) continue;

    const truncated = body.length > maxFileBytes;
    files.push({
      field: name,
      filename,
      contentType: headers['content-type'] ?? null,
      size: body.length,
      truncated,
      data: truncated ? body.subarray(0, maxFileBytes) : body,
    });
  }

  return { fields, files };
}
