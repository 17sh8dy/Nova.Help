/**
 * The classic-script build of the account client.
 *
 * `global.js` exists because Online Earth runs on a `file://` origin, where Chromium refuses
 * to load a module script — so it cannot import the ESM entry point the other three Nova
 * products use. It is GENERATED from those same sources, and this file is the thing that keeps
 * "generated" from quietly becoming "copied and drifting".
 *
 * Two tests carry that:
 *
 *   1. Regenerating it produces exactly what is checked in. A change to index.mjs that is not
 *      rebuilt fails here rather than in Online Earth six weeks later.
 *   2. The build BEHAVES like the module — driven against a real server, including the one
 *      behaviour a hand-maintained copy would be most likely to lose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server/app.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'packages', 'nova-account-client');
const globalFile = path.join(clientDir, 'global.js');

test('the classic build is exactly what the generator produces', async () => {
  const before = await readFile(globalFile, 'utf8');
  await run(process.execPath, [path.join(clientDir, 'build-global.mjs')]);
  const after = await readFile(globalFile, 'utf8');

  assert.equal(
    after,
    before,
    'global.js is out of date. Run: node packages/nova-account-client/build-global.mjs',
  );
});

/** Evaluate the classic build the way a `<script>` tag would, and hand back its global. */
async function loadGlobal() {
  const source = await readFile(globalFile, 'utf8');
  const host = {};
  new Function('window', source)(host);
  return host.NovaAccountClient;
}

test('it exposes the same entry points as the module', async () => {
  const api = await loadGlobal();
  const expected = ['createNovaAccountClient', 'memoryStorage', 'browserStorage', 'asyncStorage'];
  for (const name of expected) {
    assert.equal(typeof api[name], 'function', `${name} is missing from the classic build`);
  }
});

test('a client built from the classic script signs in against the real server', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-global-'));
  const app = await createApp({
    dataDir: dir,
    dev: true,
    passwordCost: { N: 1024, r: 8, p: 1 },
    logger: { warn() {}, error() {} },
  });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const api = await loadGlobal();
  const client = api.createNovaAccountClient({
    product: 'online-earth',
    scopes: ['sync'],
    origin,
    storage: api.memoryStorage(),
    sleep: () => Promise.resolve(),
  });

  // A browser signs up and approves, exactly as a person would.
  const jar = new Map();
  const post = async (url, fields) => {
    const response = await fetch(`${origin}${url}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return response;
  };

  await post('/account/new', {
    email: 'ann@example.com',
    displayName: 'Ann',
    password: 'a passphrase nobody guesses',
    passwordConfirm: 'a passphrase nobody guesses',
  });

  const flow = await client.beginSignIn({ deviceName: 'A browser' });
  assert.equal(flow.ok, true);
  const waiting = flow.wait();
  await post('/account/device', { code: flow.userCode, action: 'approve' });

  const result = await waiting;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.account.displayName, 'Ann');
  assert.equal(client.isSignedIn(), true);

  // And sync works, which is the thing Online Earth actually wants an account for.
  assert.equal((await client.push({ baseVersion: 0, data: { places: ['home'] } })).ok, true);
  assert.deepEqual((await client.pull()).data, { places: ['home'] });
});

test('the classic build keeps a token when the server cannot be reached', async () => {
  /* The single behaviour a hand-maintained copy would be most likely to lose, and the one that
     signs people out on a train. Asserted on THIS build, not only on the module. */
  const api = await loadGlobal();
  const storage = api.memoryStorage();
  storage.write(
    JSON.stringify({
      product: 'online-earth',
      token: 'not-a-real-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scopes: ['identity'],
      account: { id: 'NA-0000-0000-0000', displayName: 'Ann', products: [] },
    }),
  );

  const client = api.createNovaAccountClient({
    product: 'online-earth',
    origin: 'http://127.0.0.1:1',
    storage,
  });

  assert.equal((await client.refresh()).state, 'offline');
  assert.equal(client.isSignedIn(), true, 'a network failure is not a sign-out');
});
