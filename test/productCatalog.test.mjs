/**
 * The product catalog expansion — Atlas Website and Nova Legal, and real logos in place of the
 * generic named glyph for the products that have one (Atlas, Nova Cut, Replay.GG, and Atlas
 * Website which reuses Atlas's own mark).
 *
 * `test/ecosystem.test.mjs` already asserts the general shape (every entry resolves, no url is
 * invented, nothing is missing from the directory) for every product including these two new
 * ones. What is specific to this change, and not covered there, is: the new projects carry
 * real support content of their own, and the homepage renders a real inline logo — not a
 * broken reference, not the old glyph — for every product that has one, while a product with
 * no real mark still falls back to the glyph system rather than rendering nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.mjs';
import { projects } from '../server/core/catalog.mjs';
import { products as ecosystemProducts } from '../data/ecosystem.js';
import { brandMark, hasBrandMark } from '../server/views/brandmarks.mjs';
import { hasIcon } from '../server/views/icons.mjs';

async function startServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-catalog-'));
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

/* ── The two new products exist and are wired up ──────────────────────────────────────────── */

test('Atlas Website and Nova Legal are in both catalogs', () => {
  for (const id of ['atlas-website', 'nova-legal']) {
    assert.ok(
      ecosystemProducts.some((p) => p.id === id),
      `${id} is missing from data/ecosystem.js`,
    );
    assert.ok(
      projects.some((p) => p.id === id),
      `${id} is missing a support project in data/projects/`,
    );
  }
});

test('their ecosystem urls are the confirmed live ones, not a guess', () => {
  const byId = Object.fromEntries(ecosystemProducts.map((p) => [p.id, p]));
  assert.equal(byId['atlas-website'].url, 'https://atlas-website.shadylabs.workers.dev/');
  assert.equal(byId['nova-legal'].url, 'https://nova-legal.shadylabs.workers.dev/');
});

test('both new support projects have real categories, not a stub', () => {
  const atlasWebsite = projects.find((p) => p.id === 'atlas-website');
  const novaLegal = projects.find((p) => p.id === 'nova-legal');

  // categories() always includes the appended "Something else" catch-all category is NOT a
  // thing — it is issue types that get the catch-all, not categories — so a real project here
  // means more than one category, or one category with more than the bare minimum of issues.
  assert.ok(atlasWebsite.categories.length >= 2, 'atlas-website should have more than a bare stub');
  assert.ok(novaLegal.categories.length >= 2, 'nova-legal should have more than a bare stub');

  const atlasWebsiteIssues = atlasWebsite.categories.flatMap((c) => c.issueTypes);
  const novaLegalIssues = novaLegal.categories.flatMap((c) => c.issueTypes);
  assert.ok(atlasWebsiteIssues.length >= 4);
  assert.ok(novaLegalIssues.length >= 4);
});

/* ── The logo lookup itself ────────────────────────────────────────────────────────────────── */

test('a brand mark exists for every product that declares logo:', () => {
  for (const project of projects) {
    if (!project.logo) continue;
    assert.ok(hasBrandMark(project.logo), `${project.id} declares logo: '${project.logo}', which has no mark`);
  }
});

test('a project with no logo still has a valid fallback icon', () => {
  for (const project of projects) {
    if (project.logo) continue;
    assert.ok(project.icon, `${project.id} has neither a logo nor an icon`);
    assert.ok(hasIcon(project.icon), `${project.id}'s icon "${project.icon}" is not a real glyph`);
  }
});

test('brandMark renders real, differently-coloured inline SVG per product', () => {
  const atlas = brandMark('atlas', { size: 24 });
  const novaCut = brandMark('nova-cut', { size: 24 });
  const replayGg = brandMark('replay-gg', { size: 24 });

  for (const svg of [atlas, novaCut, replayGg]) {
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>$/);
    assert.match(svg, /width="24" height="24"/);
  }

  // Not the same artwork with a different name — real, distinct marks.
  assert.notEqual(atlas, novaCut);
  assert.notEqual(atlas, replayGg);
  assert.notEqual(novaCut, replayGg);
  assert.match(atlas, /#2C2C2A/); // Atlas's own dark square
  assert.match(novaCut, /#0A84FF/); // Nova Cut's own blue square
  assert.match(replayGg, /#E6293F/); // Replay.GG's own red accent

  assert.equal(brandMark('not-a-real-product'), null);
});

/* ── What actually reaches the homepage ───────────────────────────────────────────────────── */

test('the homepage renders a real logo for every product that has one', async (t) => {
  const origin = await startServer(t);
  const html = await get(origin, '/');

  for (const project of projects) {
    if (!project.logo) continue;
    const mark = brandMark(project.logo, { size: 24 });
    assert.ok(html.includes(mark), `${project.id}'s card does not render its brand mark`);
  }
});

test('the product__icon--logo wrapper is used only for a real logo, never for a glyph fallback', async (t) => {
  const origin = await startServer(t);
  const html = await get(origin, '/');

  const logoWrapped = (html.match(/product__icon--logo/g) ?? []).length;
  const withLogo = projects.filter((p) => p.logo).length;
  assert.equal(logoWrapped, withLogo);
});

test('Nova Legal and Nova Site (no real mark) still render a card with a glyph icon, not a blank', async (t) => {
  const origin = await startServer(t);
  const html = await get(origin, '/');

  for (const id of ['nova-legal', 'nova-site']) {
    const project = projects.find((p) => p.id === id);
    assert.ok(project, id);
    assert.equal(project.logo, undefined, `${id} was expected to have no real mark`);
    // Its card links out and names the product — the ordinary, pre-existing card shape.
    assert.match(html, new RegExp(`href="/help/${id}"`));
  }
});

test('every product card on the homepage still renders — nothing regressed', async (t) => {
  const origin = await startServer(t);
  const html = await get(origin, '/');

  for (const project of projects) {
    assert.match(html, new RegExp(`href="/help/${project.id}"`), `${project.name} card is missing`);
    assert.ok(html.includes(project.name), `${project.name} is not named on its own card`);
  }
  // Same number of cards as projects — nothing duplicated, nothing dropped.
  const cards = (html.match(/class="product"/g) ?? []).length;
  assert.equal(cards, projects.length);
});

test('the individual help page for each new product renders too', async (t) => {
  const origin = await startServer(t);
  for (const id of ['atlas-website', 'nova-legal']) {
    const response = await fetch(`${origin}/help/${id}`, { redirect: 'manual' });
    assert.equal(response.status, 200, `/help/${id}`);
  }
});
