/**
 * The ecosystem directory and the footer.
 *
 * Most of what is asserted here is that NOTHING IS INVENTED. A product directory whose links
 * were guessed at is worse than no directory: every dead one has to be found and removed
 * later, usually by somebody who does not know which were real. So these tests pin the two
 * halves of the honest version — every entry links somewhere that exists today, and a product
 * with no website of its own renders no link rather than a broken one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';
import { projects } from '../server/core/catalog.mjs';
import { community, products, linkedProducts, forSupportProject } from '../data/ecosystem.js';

async function startServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-eco-'));
  const app = await createApp({ dataDir: dir, dev: true, logger: { warn() {}, error() {} } });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  return origin;
}

const get = (origin, url) => fetch(`${origin}${url}`, { redirect: 'manual' }).then((r) => r.text());

/* ── The data ──────────────────────────────────────────────────────────────────────────── */

test('every ecosystem entry names a real support project', async () => {
  const ids = new Set(projects.map((project) => project.id));
  for (const product of products) {
    assert.ok(ids.has(product.support), `${product.id} points at "${product.support}", which does not exist`);
  }
});

test('every Nova product in the catalog is in the directory', async () => {
  /* The other direction, and the one that rots quietly: adding a product to data/projects/
     without adding it here would leave it out of every footer on the site. */
  for (const project of projects) {
    assert.ok(forSupportProject(project.id), `${project.id} has a support catalog but no directory entry`);
  }
});

test('no product URL is invented — an unbuilt site is null, not a guess', async () => {
  for (const product of products) {
    if (product.url === null) continue;
    assert.match(product.url, /^https:\/\//, `${product.id}`);
    assert.equal(
      /example\.(com|org|net)|localhost|todo|placeholder/i.test(product.url),
      false,
      `${product.id} has a placeholder dressed up as a real URL`,
    );
  }
});

test('the Discord invite is the real one', async () => {
  assert.equal(community.discord, 'https://discord.gg/XBhER9Z6EB');
});

/* ── The rendering ─────────────────────────────────────────────────────────────────────── */

test('the footer lists every Nova product, linked to help that exists today', async (t) => {
  const origin = await startServer(t);
  const html = await get(origin, '/');

  for (const product of products) {
    assert.match(html, new RegExp(`/help/${product.support}"`), `${product.name} is missing`);
    assert.ok(html.includes(product.name), `${product.name} is not named`);
  }
});

test('a product with no website of its own renders no second link at all', async (t) => {
  const origin = await startServer(t);
  const html = await get(origin, '/');

  /* Not a disabled link, not "coming soon", not a `#`. The footer makes no promises about
     deployments that do not exist. */
  const expected = linkedProducts().length;
  const rendered = (html.match(/class="ecosystem__site"/g) ?? []).length;
  assert.equal(rendered, expected);
  assert.equal(html.includes('Coming soon'), false);
  assert.equal(html.includes('href="#"'), false);
});

test('the Discord link is in the footer, on every page', async (t) => {
  const origin = await startServer(t);

  for (const url of ['/', '/tickets', '/help/atlas', '/account/sign-in', '/privacy']) {
    const html = await get(origin, url);
    assert.match(html, /https:\/\/discord\.gg\/XBhER9Z6EB/, `missing on ${url}`);
    assert.match(html, /Join the Nova Discord/, `unlabelled on ${url}`);
  }
});

test('the Discord link does not leak where it came from', async (t) => {
  const origin = await startServer(t);
  const html = await get(origin, '/');

  /* `rel="noopener"` on an outbound link is the cheap half of the habit; the expensive half is
     remembering it, which is what this test is for. */
  assert.match(html, /<a class="footer__discord" href="https:\/\/discord\.gg\/XBhER9Z6EB" rel="noopener">/);
});

test('every help link in the footer actually resolves', async (t) => {
  const origin = await startServer(t);

  /* The point of linking to `/help/<id>` rather than to an unbuilt product site is that these
     work NOW. If one ever stops, this catches it here rather than in the footer of every page
     on the site. */
  for (const product of products) {
    const response = await fetch(`${origin}/help/${product.support}`, { redirect: 'manual' });
    assert.equal(response.status, 200, `/help/${product.support}`);
  }
});
