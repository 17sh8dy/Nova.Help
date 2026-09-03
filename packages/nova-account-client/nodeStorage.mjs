/**
 * A token in a file, for Electron main and anything else with a filesystem.
 *
 * SEPARATE FROM ./storage.mjs ON PURPOSE. This module imports `node:fs`, and a bundler
 * building a renderer pulls in every module it can reach — so putting this beside
 * `browserStorage` made Open Cut's production build fail on a function its renderer never
 * calls. The split is the fix, and it is also the honest shape: these two run in different
 * places and always did.
 *
 * See ./storage.mjs for what is and is not protected by keeping a bearer token on disk.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A 0600 file in a directory the app already owns.
 *
 * Written 0600 inside a directory the app already owns. On Windows those modes are advisory,
 * which is worth knowing and is not a reason to skip them on the platforms where they are not.
 *
 * SYNCHRONOUS ON PURPOSE. This is one small file read at startup and written on sign-in;
 * making it async would push a promise through every caller — including React render paths
 * that only want to know whether a token exists — to save a millisecond that nobody has.
 */
export function fileStorage(directory, { filename = 'nova-account.json' } = {}) {
  const file = path.join(directory, filename);

  return {
    read() {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        // Not signed in, or the file is unreadable. Both mean the same thing to a caller.
        return null;
      }
    },
    write(value) {
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // Read-only install directory, a full disk, a locked profile. The session still works.
      }
    },
    clear() {
      try {
        rmSync(file, { force: true });
      } catch {
        // Already gone, or not ours to remove.
      }
    },
  };
}
