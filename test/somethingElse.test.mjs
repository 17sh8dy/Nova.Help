/**
 * "Something else" — the escape hatch on every step-three screen.
 *
 * The promise being tested is narrow and total: whatever product and area a reporter picks,
 * the list of issues ends with a way out, and taking it lands them on the page where they
 * describe the problem rather than on a second list of things that also do not fit.
 *
 * The subtle test is the sensitivity one. The hatch is appended to every category including
 * the account-and-security ones, and if it did not inherit their sensitivity it would both
 * escape the human-only routing itself AND flip the whole category out of sensitive, because
 * a category counts as sensitive only when every route out of it ends with a person.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as catalog from '../server/core/catalog.mjs';
import { classify } from '../server/core/policy.mjs';
import { validateTicketInput } from '../server/core/validation.mjs';
import { createApp } from '../server/app.mjs';

const { CATCH_ALL_ID } = catalog;

async function startServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-hatch-'));
  const app = await createApp({ dataDir: dir, dev: true, logger: { warn() {}, error() {} } });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, app };
}

const call = (origin, url, options = {}) => fetch(`${origin}${url}`, { redirect: 'manual', ...options });

/* ── The catalog guarantee ─────────────────────────────────────────────────────────────── */

test('every category in every product ends with "Something else"', () => {
  let categories = 0;
  for (const project of catalog.projects) {
    for (const category of project.categories) {
      categories += 1;
      const last = category.issueTypes.at(-1);
      assert.equal(
        last.id,
        CATCH_ALL_ID,
        `${project.id}/${category.id} does not end with the escape hatch`,
      );
      assert.equal(last.catchAll, true);
      assert.equal(last.label, 'Something else');
      // Exactly one, never two.
      assert.equal(category.issueTypes.filter((t) => t.catchAll).length, 1);
    }
  }
  assert.equal(categories, 41, 'the catalog should still have 41 categories');
  assert.equal(catalog.stats.catchAll, categories);
});

test('the hatch resolves and is addressable like any other issue type', () => {
  for (const project of catalog.projects) {
    for (const category of project.categories) {
      const found = catalog.resolveSelection({
        project: project.id,
        category: category.id,
        issueType: CATCH_ALL_ID,
      });
      assert.equal(found.ok, true, `${project.id}/${category.id}/${CATCH_ALL_ID} should resolve`);
      assert.equal(found.issueType.path, `${project.id}/${category.id}/${CATCH_ALL_ID}`);
    }
  }
});

test('the hatch offers no articles, so the form shows no suggestion panel', () => {
  for (const project of catalog.projects) {
    for (const category of project.categories) {
      const hatch = category.issueTypes.at(-1);
      assert.deepEqual([...hatch.articles], []);
      assert.deepEqual(catalog.articlesFor(hatch), []);
    }
  }
});

test('the hatch lets the reporter choose severity rather than pinning one', () => {
  const hatch = catalog.getIssueType('online-earth', 'globe', CATCH_ALL_ID);
  assert.equal(hatch.priorityMode, 'ask');
  assert.equal(hatch.priority, catalog.DEFAULT_PRIORITY);
});

/* ── Sensitivity. The one that would break quietly. ────────────────────────────────────── */

test('the hatch inherits its category sensitivity and routes to a person where its neighbours do', () => {
  let sensitiveCategories = 0;

  for (const project of catalog.projects) {
    for (const category of project.categories) {
      const declared = category.issueTypes.filter((t) => !t.catchAll);
      const hatch = category.issueTypes.find((t) => t.catchAll);
      const expected = declared.length > 0 && declared.every((t) => t.sensitive);

      assert.equal(
        hatch.sensitive,
        expected,
        `${project.id}/${category.id}: the hatch should be ${expected ? '' : 'not '}sensitive`,
      );

      if (expected) {
        sensitiveCategories += 1;
        const routing = classify({
          project: project.id,
          category: category.id,
          issueType: CATCH_ALL_ID,
          priority: 'normal',
        });
        assert.equal(routing.humanOnly, true, `${project.id}/${category.id}: hatch must be human-only`);
        assert.ok(routing.reason);
      }
    }
  }

  assert.ok(sensitiveCategories > 0, 'there should be sensitive categories to check');
});

test('appending the hatch does not change whether a category is sensitive', () => {
  for (const project of catalog.projects) {
    for (const category of project.categories) {
      const declaredOnly = category.issueTypes.filter((t) => !t.catchAll);
      assert.equal(
        category.sensitive,
        declaredOnly.length > 0 && declaredOnly.every((t) => t.sensitive),
        `${project.id}/${category.id}: sensitivity must be decided by the declared issues alone`,
      );
    }
  }
  // The account area is the case that matters: it must still be entirely human-only.
  const account = catalog.getCategory('nova-site', 'account');
  assert.equal(account.sensitive, true);
  assert.equal(account.issueTypes.every((t) => t.sensitive), true);
});

test('the catch-all id is reserved against a data file declaring its own', () => {
  // The shipped catalog is clean...
  assert.deepEqual(catalog.validate(), []);
  // ...and the rule that keeps it clean is a real rule, not a comment.
  assert.equal(CATCH_ALL_ID, 'something-else');
  const declaresReserved = catalog.projects.some((p) =>
    p.categories.some((c) => c.issueTypes.filter((t) => t.id === CATCH_ALL_ID).length > 1),
  );
  assert.equal(declaresReserved, false);
});

/* ── Filing through it ─────────────────────────────────────────────────────────────────── */

test('a ticket filed against the hatch validates like any other', () => {
  const result = validateTicketInput({
    project: 'open-cut',
    category: 'editing',
    issueType: CATCH_ALL_ID,
    subject: 'Something odd happens when I scrub',
    description: 'It is hard to describe, but the playhead sometimes jumps back a second or two.',
    email: 'reporter@example.com',
    priority: 'normal',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.issueType.id, CATCH_ALL_ID);
});

/* ── The screens ───────────────────────────────────────────────────────────────────────── */

test('step three shows the hatch last, set apart from the listed issues', async (t) => {
  const { origin } = await startServer(t);
  const html = await call(origin, '/help/online-earth/globe').then((r) => r.text());

  assert.match(html, /Something else/);
  assert.match(html, /choices--hatch/, 'the hatch should be in its own group, not among the issues');
  assert.match(html, /choice--catch-all/);
  assert.match(html, /href="\/help\/online-earth\/globe\/something-else"/);

  // It comes after every real issue on the page.
  const hatchAt = html.indexOf('choices--hatch');
  assert.ok(hatchAt > html.indexOf('globe-not-loading'));
  assert.ok(hatchAt > html.indexOf('camera-controls'));
});

test('every step-three screen on the site offers the way out', async (t) => {
  const { origin } = await startServer(t);
  for (const project of catalog.projects) {
    for (const category of project.categories) {
      const html = await call(origin, `/help/${project.id}/${category.id}`).then((r) => r.text());
      assert.match(
        html,
        new RegExp(`href="/help/${project.id}/${category.id}/${CATCH_ALL_ID}"`),
        `${project.id}/${category.id} has no escape hatch on screen`,
      );
    }
  }
});

test('choosing it goes straight to the ticket form, not to another list', async (t) => {
  const { origin } = await startServer(t);
  const response = await call(origin, '/help/online-earth/globe/something-else');
  const html = await response.text();

  assert.equal(response.status, 200);
  // It is the ticket form: a description box and a submit button, on step four.
  assert.match(html, /<textarea[^>]*id="description"/);
  assert.match(html, /Submit ticket/);
  assert.match(html, /Step 4 of 4/);
  // And it asks the open question rather than pretending to know the problem.
  assert.match(html, /Tell us what is going on/);
  assert.match(html, /Nothing on the last screen fitted/);
  // No second list of predefined issues.
  assert.equal(html.includes('choices--tight'), false);
  assert.equal(html.includes('Worth trying first'), false);
});

test('a ticket filed through the hatch is a real ticket', async (t) => {
  const { origin, app } = await startServer(t);

  const response = await fetch(`${origin}/help/atlas/voice/something-else`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      subject: 'Hard to describe but the voice cuts out',
      description: 'It stops mid-sentence maybe one time in five, and I cannot find a pattern to it.',
      email: 'reporter@example.com',
      priority: 'normal',
    }).toString(),
  });

  assert.equal(response.status, 303, await response.text());
  const id = decodeURIComponent(response.headers.get('location').split('/').pop().split('?')[0]);
  const stored = await app.ctx.tickets.get(id);

  assert.equal(stored.issueType, CATCH_ALL_ID);
  assert.equal(stored.category, 'voice');
  assert.equal(stored.project, 'atlas');
  assert.equal(stored.status, 'open');
});

test('the JSON API tells an automated client the hatch exists', async (t) => {
  const { origin } = await startServer(t);

  const catalogJson = await call(origin, '/api/catalog').then((r) => r.json());
  for (const project of catalogJson.projects) {
    for (const category of project.categories) {
      assert.equal(
        category.issueTypes.at(-1).id,
        CATCH_ALL_ID,
        `${project.id}/${category.id} is missing the hatch in the API`,
      );
    }
  }

  const resolved = await call(origin, '/api/resolve/replay-gg/capture/something-else').then((r) => r.json());
  assert.equal(resolved.issueType.id, CATCH_ALL_ID);
  assert.equal(resolved.formUrl, '/help/replay-gg/capture/something-else');
});
