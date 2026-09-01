/**
 * Attachments — files a reporter adds to a ticket.
 *
 * Screenshots and log files are the difference between a diagnosable ticket and a
 * conversation, so this is first-version functionality rather than a later feature. The
 * handling is deliberately conservative:
 *
 * - THE UPLOADED NAME IS NEVER A PATH. Files are stored under a generated id, and the name
 *   the browser sent is kept only as a label. No filename from a request ever reaches the
 *   filesystem, so there is nothing for `../` to do.
 *
 * - THE UPLOADED CONTENT TYPE IS NEVER TRUSTED FOR SERVING. What the browser claimed is
 *   recorded for support to read; what gets sent back is decided by the allowlist below, and
 *   everything else is served as an opaque download. A .html upload can therefore never be
 *   rendered as a page on this origin.
 *
 * - THE TOTAL SIZE LIMIT IS ENFORCED WHILE READING. `lib/body.mjs` counts bytes as they
 *   arrive and destroys the connection past the cap, so an oversized upload costs bounded
 *   memory. The per-file limits below are then applied to parts already known to fit, and a
 *   file that fails any check is refused before a single byte is written to disk.
 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { newAttachmentId } from './ids.mjs';

export const ATTACHMENT_LIMITS = {
  maxFiles: 5,
  maxBytesPerFile: 10 * 1024 * 1024,
  maxBytesTotal: 25 * 1024 * 1024,
};

/** Extensions offered in the file picker. Anything else is refused with the reason shown. */
export const ACCEPTED_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.txt',
  '.log',
  '.json',
  '.csv',
  '.pdf',
  '.zip',
  '.mp4',
  '.webm',
];

/** The only content types this server will ever echo back. Everything else downloads opaquely. */
const SAFE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'],
  ['.csv', 'text/plain; charset=utf-8'],
  ['.json', 'text/plain; charset=utf-8'],
]);

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const extensionOf = (filename) => path.extname(String(filename ?? '')).toLowerCase();

/** A display name: no directories, no control characters, bounded length. */
export function safeDisplayName(filename) {
  const base = path.basename(String(filename ?? '').replace(/\\/g, '/')).trim();
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  return cleaned || 'attachment';
}

export function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How this file will be served back, decided from the extension alone. */
export function serveTypeFor(attachment) {
  return SAFE_TYPES.get(extensionOf(attachment.filename)) ?? 'application/octet-stream';
}

export const isImage = (attachment) => IMAGE_TYPES.has(serveTypeFor(attachment));

/**
 * Check a set of parsed files before anything is written. Returns `{ ok, errors, files }`;
 * `errors` is a list of sentences shown above the attachment field.
 */
export function validateFiles(files = []) {
  const errors = [];
  const kept = files.filter((f) => f.size > 0);

  if (kept.length > ATTACHMENT_LIMITS.maxFiles) {
    errors.push(`Attach at most ${ATTACHMENT_LIMITS.maxFiles} files.`);
  }
  let total = 0;
  for (const file of kept) {
    const name = safeDisplayName(file.filename);
    total += file.size;
    if (file.truncated || file.size > ATTACHMENT_LIMITS.maxBytesPerFile) {
      errors.push(`${name} is larger than ${humanSize(ATTACHMENT_LIMITS.maxBytesPerFile)}.`);
    }
    if (!ACCEPTED_EXTENSIONS.includes(extensionOf(name))) {
      errors.push(`${name} is a file type we cannot accept. Zip it if you need to send it.`);
    }
  }
  if (total > ATTACHMENT_LIMITS.maxBytesTotal) {
    errors.push(`Those files come to more than ${humanSize(ATTACHMENT_LIMITS.maxBytesTotal)} in total.`);
  }

  return { ok: errors.length === 0, errors, files: kept };
}

export function createAttachmentStore({ dir }) {
  const root = path.join(dir, 'attachments');
  const dirFor = (ticketId) => path.join(root, ticketId);
  const fileFor = (ticketId, id) => path.join(dirFor(ticketId), id);

  return {
    /**
     * Write validated files for a ticket and return the metadata records to store on it.
     * Called only after validation, and only after the ticket id exists.
     */
    async save(ticketId, files = []) {
      if (!files.length) return [];
      await mkdir(dirFor(ticketId), { recursive: true });
      const saved = [];
      for (const file of files) {
        const id = newAttachmentId();
        await writeFile(fileFor(ticketId, id), file.data);
        saved.push({
          id,
          filename: safeDisplayName(file.filename),
          declaredType: String(file.contentType ?? '').slice(0, 100) || null,
          size: file.size,
          uploadedAt: new Date().toISOString(),
        });
      }
      return saved;
    },

    /** Raw bytes for a stored attachment, or null when it is gone. */
    async read(ticketId, id) {
      try {
        return await readFile(fileFor(ticketId, id));
      } catch {
        return null;
      }
    },

    /** Remove everything for a ticket. Used when ticket creation fails after files landed. */
    async discard(ticketId) {
      await rm(dirFor(ticketId), { recursive: true, force: true });
    },
  };
}
