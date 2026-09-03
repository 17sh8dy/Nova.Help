/**
 * Generate `global.js` — the classic-script build of the Nova Account client.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY A SECOND BUILD EXISTS AT ALL.
 *
 * Online Earth is a plain website with no bundler and no build step, and its Electron shell
 * opens it with `loadFile` — so the page runs on a `file://` origin. Chromium refuses to load
 * `<script type="module">` from `file://` (the origin is opaque, and module scripts are
 * fetched with CORS), so the ESM entry point is simply not reachable there. The choice was
 * between giving Online Earth its own copy of the client and giving it a DERIVED one.
 *
 * A copy would drift. This does not, because it is generated from the same two files the
 * other three products import, and `test/accountClientGlobal.test.mjs` regenerates it and
 * fails if the checked-in output differs by a byte. So there is still exactly one
 * implementation of "offline is not a sign-out", and one place to fix it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A TEXT TRANSFORM AND NOT A BUNDLER.
 *
 * Because it can be. `index.mjs` and the browser half of `storage.mjs` import NOTHING — no
 * package, no builtin, not each other. There is no module graph to resolve, so the whole job
 * is: drop the `export` keywords, wrap the result in an IIFE, and hang the entry points off
 * one global. A bundler would be a dependency, a config file and a lockfile entry to do a
 * concatenation, in a repository whose defining property is that it has no dependencies.
 *
 * The generator ASSERTS its own assumption rather than assuming it: if either source file
 * ever grows an `import`, this throws instead of quietly emitting a broken file.
 *
 *     node packages/nova-account-client/build-global.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The public names `global.js` hangs off `window.NovaAccountClient`. */
const EXPORTED = ['createNovaAccountClient', 'memoryStorage', 'browserStorage', 'asyncStorage', 'NOVA_ACCOUNTS_ORIGIN', 'SIGN_IN_FAILURES'];

const HEADER = `/**
 * The Nova Account client, as a classic script. GENERATED — DO NOT EDIT.
 *
 * Run \`node packages/nova-account-client/build-global.mjs\` to regenerate, and see that file
 * for why this exists: Online Earth runs on a file:// origin, where Chromium will not load a
 * module script, so it cannot import the ESM entry point that Open Cut, Replay.GG and Atlas
 * use. This is the same code, mechanically derived, and a test fails if the two drift.
 *
 * Usage:
 *
 *     <script src="nova-account/global.js"></script>
 *     const client = NovaAccountClient.createNovaAccountClient({ product: 'online-earth', ... });
 */
`;

/** Strip module syntax. Only ever applied to files this script has checked have no imports. */
function flatten(source, name) {
  if (/^\\s*import\\s/m.test(source)) {
    throw new Error(
      `${name} has an import. The classic build is a concatenation and cannot resolve one — ` +
        'either keep this file import-free, or replace this generator with a real bundler.',
    );
  }
  return source
    // `export function x` / `export const x` / `export class x` -> the bare declaration.
    .replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, '')
    // `export { a, b };` — nothing to keep; the names are collected below instead.
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    // `export * from ...` would be an import in disguise.
    .replace(/^export\s+\*.*$/gm, '');
}

const index = flatten(await readFile(path.join(here, 'index.mjs'), 'utf8'), 'index.mjs');
const storage = flatten(await readFile(path.join(here, 'storage.mjs'), 'utf8'), 'storage.mjs');

const output = `${HEADER}
/* eslint-disable */
(function (root) {
  'use strict';

${index}

${storage}

  root.NovaAccountClient = { ${EXPORTED.join(', ')} };
})(typeof window !== 'undefined' ? window : globalThis);
`;

await writeFile(path.join(here, 'global.js'), output, 'utf8');
console.log(`Wrote global.js (${output.length} bytes, ${EXPORTED.length} exports).`);
