/**
 * An R2-shaped bucket over the local filesystem, for running and testing the R2 store here.
 *
 * A WEAKER GUARANTEE THAN sqliteD1.mjs, AND WORTH SAYING SO. That driver runs the same SQL
 * engine D1 is built on, so a query proven there is proven. This is not the same: it is a
 * reimplementation of R2's shape, so it can only show that the adapter CALLS R2 correctly --
 * that keys are built as intended, that `discard` sweeps a whole prefix and pages properly,
 * that a missing object reads as null. Whether R2 itself behaves as expected is settled by
 * `wrangler dev`, which runs the real local R2, and nothing here is a substitute for that.
 *
 * It implements only the four operations the attachment store uses: put, get, delete, list.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Keys contain '/', which is a prefix convention in R2 and a directory on a filesystem. */
const toPath = (root, key) => path.join(root, ...key.split('/'));

/** Metadata rides alongside the object, since a filesystem has nowhere else to put it. */
const metaPath = (root, key) => `${toPath(root, key)}.meta.json`;

async function walk(dir, base = '') {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // nothing written yet
  }
  for (const entry of entries) {
    const key = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), key)));
    else if (!entry.name.endsWith('.meta.json')) out.push(key);
  }
  return out;
}

export function createLocalR2({ dir, pageSize = 1000 }) {
  const root = path.resolve(dir);

  return {
    async put(key, value, options = {}) {
      const target = toPath(root, key);
      await mkdir(path.dirname(target), { recursive: true });
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      await writeFile(target, bytes);
      await writeFile(
        metaPath(root, key),
        JSON.stringify({ httpMetadata: options.httpMetadata ?? {}, customMetadata: options.customMetadata ?? {} }),
        'utf8',
      );
      return { key, size: bytes.length };
    },

    async get(key) {
      let bytes;
      try {
        bytes = await readFile(toPath(root, key));
      } catch {
        return null; // R2 answers a missing object with null, not an error
      }
      let meta = {};
      try {
        meta = JSON.parse(await readFile(metaPath(root, key), 'utf8'));
      } catch {
        // An object with no sidecar is still an object.
      }
      return {
        key,
        size: bytes.length,
        httpMetadata: meta.httpMetadata ?? {},
        customMetadata: meta.customMetadata ?? {},
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },

    /** R2 accepts one key or an array of them. */
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        await rm(toPath(root, key), { force: true });
        await rm(metaPath(root, key), { force: true });
      }
    },

    /**
     * Keys in order, from after `cursor`.
     *
     * The cursor is the last key of the previous page, not an offset into the listing. That is
     * how R2's own cursor behaves, and the difference matters: an offset cursor shifts when
     * objects are deleted between pages, so a caller that lists-and-deletes would skip rows
     * against this driver in a way it never would against R2. A shim that is fragile where the
     * real thing is not teaches the wrong lesson.
     */
    async list({ prefix = '', cursor, limit = pageSize } = {}) {
      const all = (await walk(root)).filter((key) => key.startsWith(prefix)).sort();
      const remaining = cursor ? all.filter((key) => key > cursor) : all;
      const page = remaining.slice(0, limit);
      const truncated = page.length < remaining.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? page.at(-1) : undefined,
      };
    },
  };
}
