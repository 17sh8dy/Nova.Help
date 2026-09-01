/**
 * Attachments on Cloudflare R2 — the same three methods as the store in core/attachments.mjs.
 *
 * The bytes were never going into D1. A row limit measured in kilobytes is the wrong home for
 * a 10MB screen recording, and D1's billing counts rows rather than bytes, so a blob column
 * would be both the most expensive and the least appropriate choice available. R2 is object
 * storage, which is what an attachment is.
 *
 * WHAT DOES NOT CHANGE, and must not:
 *
 * - THE UPLOADED NAME IS NEVER A KEY. Objects are stored under a generated id, exactly as they
 *   were stored under a generated filename on disk. The name the browser sent is carried as
 *   metadata, so there is still nothing for `../` to do — and an object key, unlike a path, is
 *   not even interpreted by a filesystem.
 *
 * - THE UPLOADED CONTENT TYPE IS NEVER TRUSTED FOR SERVING. What the browser claimed is
 *   recorded for support to read; what gets sent back is decided by `serveTypeFor` from the
 *   extension alone. Nothing here writes a Content-Type that R2 would hand to a browser: the
 *   objects are stored as `application/octet-stream` so that even a direct-to-bucket link,
 *   should one ever exist, cannot render an uploaded .html as a page.
 *
 * - THE SIZE LIMITS ARE ENFORCED BEFORE ANYTHING IS WRITTEN. `validateFiles` in
 *   core/attachments.mjs runs first and is untouched by any of this.
 *
 * ORDERING WITH THE TICKET WRITE. `create` in core/tickets.mjs saves the bytes BEFORE the
 * document and calls `discard` if the document fails, so a failed submission leaves nothing
 * behind. That ordering carries over unchanged: R2 first, D1 second, discard on failure. It is
 * the right way round — an object with no ticket is invisible and cheap to sweep, whereas a
 * ticket referencing bytes that were never written is a broken page for the reporter.
 */
import { newAttachmentId } from '../core/ids.mjs';
import { safeDisplayName } from '../core/attachments.mjs';

/** One object per attachment, under a prefix per ticket so `discard` is a prefix sweep. */
const keyFor = (ticketId, id) => `tickets/${ticketId}/${id}`;
const prefixFor = (ticketId) => `tickets/${ticketId}/`;

export function createR2AttachmentStore({ bucket }) {
  return {
    /**
     * Write validated files and return the metadata records to store on the ticket.
     * Called only after validation, and only once the ticket id exists.
     */
    async save(ticketId, files = []) {
      if (!files.length) return [];
      const saved = [];

      for (const file of files) {
        const id = newAttachmentId();
        const filename = safeDisplayName(file.filename);
        const declaredType = String(file.contentType ?? '').slice(0, 100) || null;

        await bucket.put(keyFor(ticketId, id), file.data, {
          /* Deliberately opaque. The type this file is served as is decided at read time from
             its extension, and storing anything else here would put a second, weaker opinion
             about that in a place no code path consults. */
          httpMetadata: { contentType: 'application/octet-stream' },
          customMetadata: {
            ticketId,
            filename,
            declaredType: declaredType ?? '',
            uploadedAt: new Date().toISOString(),
          },
        });

        saved.push({
          id,
          filename,
          declaredType,
          size: file.size,
          uploadedAt: new Date().toISOString(),
        });
      }

      return saved;
    },

    /**
     * Raw bytes for a stored attachment, or null when it is gone.
     *
     * A Uint8Array rather than a Buffer: it has the `.length` the response header needs, it is
     * what `res.end()` and `new Response()` both accept, and it does not assume Node.
     */
    async read(ticketId, id) {
      const object = await bucket.get(keyFor(ticketId, id));
      if (!object) return null;
      return new Uint8Array(await object.arrayBuffer());
    },

    /**
     * Remove everything for a ticket. Used when ticket creation fails after files landed.
     *
     * R2 lists in pages, so this loops. A ticket is capped at five attachments and will never
     * need a second page, but a sweep that silently stops at the page boundary is the kind of
     * thing that is only ever discovered by finding the leftovers years later.
     */
    async discard(ticketId) {
      /* Re-listed from the start each time rather than paged with a cursor. Carrying a cursor
         across a delete means paginating a collection while removing from it, which is a way
         to walk straight past objects however the cursor is implemented. Re-listing is
         obviously correct, and a ticket is capped at five attachments, so it is one round trip
         in every case that will actually occur.

         The bound is a safety rail, not a limit on the work: without it a delete that silently
         failed would spin here for as long as the request was allowed to live. */
      for (let sweep = 0; sweep < 100; sweep += 1) {
        const listed = await bucket.list({ prefix: prefixFor(ticketId) });
        const keys = listed.objects.map((object) => object.key);
        if (!keys.length) return;
        await bucket.delete(keys);
      }
      throw new Error(`discard(${ticketId}) did not drain; objects are not being deleted.`);
    },
  };
}
