/**
 * Unit tests for the parts that decide things: the catalog, ids, validation, the multipart
 * parser, access passes, and the ticket service's rules.
 *
 * These are the tests that matter most, because everything they cover is invisible from the
 * page and expensive to get wrong: a priority that can be tampered with, a status machine
 * that can be walked sideways, an internal note that leaks into the reporter's view.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as catalog from '../server/core/catalog.mjs';
import { newTicketId, normalizeTicketId, isTicketId } from '../server/core/ids.mjs';
import { validateTicketInput, validateReplyInput } from '../server/core/validation.mjs';
import { classify, assistantScope } from '../server/core/policy.mjs';
import { parseMultipart } from '../server/lib/body.mjs';
import { createAccess } from '../server/lib/access.mjs';
import { createRateLimiter } from '../server/lib/rateLimit.mjs';
import { createFileStore, sameEmail } from '../server/store/fileStore.mjs';
import { createAttachmentStore, safeDisplayName, validateFiles } from '../server/core/attachments.mjs';
import { createTicketService, publicEvents, summarize } from '../server/core/tickets.mjs';
import { esc, paragraphs } from '../server/views/components.mjs';

/** A ticket service over a throwaway directory. */
async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-'));
  const store = createFileStore({ dir });
  await store.init();
  const attachments = createAttachmentStore({ dir });
  return {
    dir,
    store,
    attachments,
    tickets: createTicketService({ store, attachments }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const validInput = {
  project: 'online-earth',
  category: 'globe',
  issueType: 'globe-not-loading',
  subject: 'The globe never finishes loading',
  description: 'It sits on the loading spinner forever on a fresh profile, on two machines.',
  email: 'Reporter@Example.com',
  name: 'Sam',
  priority: 'high',
  platform: 'Windows',
  appVersion: '1.4.0',
};

/* ── Catalog ───────────────────────────────────────────────────────────────────────────── */

test('the shipped catalog is structurally valid', () => {
  assert.deepEqual(catalog.validate(), []);
});

test('every issue type resolves from its ids', () => {
  for (const project of catalog.projects) {
    for (const category of project.categories) {
      for (const issueType of category.issueTypes) {
        const found = catalog.resolveSelection({
          project: project.id,
          category: category.id,
          issueType: issueType.id,
        });
        assert.equal(found.ok, true, issueType.path);
      }
    }
  }
});

test('resolveSelection reports which level was missing', () => {
  assert.equal(catalog.resolveSelection({ project: 'nope' }).missing, 'project');
  assert.equal(catalog.resolveSelection({ project: 'atlas', category: 'nope' }).missing, 'category');
  assert.equal(
    catalog.resolveSelection({ project: 'atlas', category: 'voice', issueType: 'nope' }).missing,
    'issueType',
  );
});

test('status transitions are declared in both directions where the UI needs them', () => {
  assert.equal(catalog.canTransition('open', 'in_progress'), true);
  assert.equal(catalog.canTransition('waiting_user', 'in_progress'), true);
  assert.equal(catalog.canTransition('closed', 'open'), true);
  assert.equal(catalog.canTransition('closed', 'resolved'), false);
});

/* ── Ids ───────────────────────────────────────────────────────────────────────────────── */

test('ticket ids round-trip through the forms people type', () => {
  const id = newTicketId();
  assert.match(id, /^NH-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizeTicketId(id.toLowerCase()), id);
  assert.equal(normalizeTicketId(id.replace(/-/g, '')), id);
  assert.equal(normalizeTicketId(` ${id} `), id);
});

test('ids using the excluded letters are rejected rather than guessed at', () => {
  assert.equal(normalizeTicketId('NH-IIII-LLLL'), null);
  assert.equal(isTicketId('NH-123'), false);
  assert.equal(isTicketId(''), false);
  assert.equal(isTicketId(null), false);
});

test('ticket ids do not repeat across a large batch', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) seen.add(newTicketId());
  assert.equal(seen.size, 5000);
});

/* ── Validation ────────────────────────────────────────────────────────────────────────── */

test('a complete submission validates and is normalised', () => {
  const result = validateTicketInput(validInput);
  assert.equal(result.ok, true);
  assert.equal(result.values.email, 'reporter@example.com');
  assert.equal(result.values.priority, 'high');
});

test('validation keeps what was typed so the form can be re-rendered', () => {
  const result = validateTicketInput({ ...validInput, email: 'not-an-address' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.email);
  assert.equal(result.values.description, validInput.description);
});

test('a pinned priority cannot be overridden by the submitted form', () => {
  const result = validateTicketInput({
    ...validInput,
    category: 'feedback',
    issueType: 'feature-request',
    priority: 'urgent',
  });
  assert.equal(result.ok, true);
  assert.equal(result.values.priority, 'low');
});

test('environment fields are dropped for projects that do not collect them', () => {
  const result = validateTicketInput({
    ...validInput,
    project: 'nova-site',
    category: 'website',
    issueType: 'page-error',
    platform: 'Windows',
    appVersion: '9.9',
  });
  assert.equal(result.ok, true);
  assert.equal(result.values.platform, '');
  assert.equal(result.values.appVersion, '');
});

test('a selection that does not exist is refused', () => {
  const result = validateTicketInput({ ...validInput, category: 'invented' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.category);
});

test('replies have to say something', () => {
  assert.equal(validateReplyInput({ body: '   ' }).ok, false);
  assert.equal(validateReplyInput({ body: 'It is fixed, thank you.' }).ok, true);
});

/* ── Policy ────────────────────────────────────────────────────────────────────────────── */

test('sensitive issue types are human-only, and say why', () => {
  const verdict = classify({ project: 'atlas', category: 'account', issueType: 'account-security', priority: 'high' });
  assert.equal(verdict.sensitive, true);
  assert.equal(verdict.humanOnly, true);
  assert.ok(verdict.reason);
});

test('urgent severity is human-only even in an ordinary category', () => {
  const verdict = classify({ project: 'atlas', category: 'voice', issueType: 'no-speech', priority: 'urgent' });
  assert.equal(verdict.sensitive, false);
  assert.equal(verdict.humanOnly, true);
});

test('no ticket ever permits an automated reply or an automated decision', () => {
  for (const project of catalog.projects) {
    for (const category of project.categories) {
      for (const issueType of category.issueTypes) {
        const scope = assistantScope({
          project: project.id,
          category: category.id,
          issueType: issueType.id,
          priority: issueType.priority,
        });
        assert.equal(scope.autoRespond, false, issueType.path);
        assert.equal(scope.mayDecide, false, issueType.path);
        if (issueType.sensitive) assert.equal(scope.suggest, false, issueType.path);
      }
    }
  }
});

/* ── Multipart ─────────────────────────────────────────────────────────────────────────── */

function multipartBody(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const filename = part.filename ? `; filename="${part.filename}"` : '';
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${filename}\r\n`));
    if (part.type) chunks.push(Buffer.from(`Content-Type: ${part.type}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data ?? ''));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test('multipart bodies split into fields and files', () => {
  const boundary = 'xBOUNDARYx';
  const body = multipartBody(boundary, [
    { name: 'subject', data: 'Globe will not load' },
    { name: 'description', data: 'Line one\r\nLine two' },
    { name: 'files', filename: 'screenshot.png', type: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);

  const { fields, files } = parseMultipart(body, boundary);
  assert.equal(fields.subject, 'Globe will not load');
  assert.equal(fields.description, 'Line one\r\nLine two');
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'screenshot.png');
  assert.equal(files[0].size, 4);
});

test('binary content survives the parser byte for byte', () => {
  const boundary = 'bin';
  const payload = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x2d, 0x2d, 0x00]);
  const body = multipartBody(boundary, [{ name: 'files', filename: 'log.bin', data: payload }]);
  const { files } = parseMultipart(body, boundary);
  assert.deepEqual(files[0].data, payload);
});

test('an empty file input contributes no file', () => {
  const boundary = 'empty';
  const body = multipartBody(boundary, [{ name: 'files', filename: '', data: '' }]);
  assert.equal(parseMultipart(body, boundary).files.length, 0);
});

test('a part larger than the per-file limit is marked truncated', () => {
  const boundary = 'big';
  const body = multipartBody(boundary, [{ name: 'files', filename: 'huge.log', data: 'x'.repeat(500) }]);
  const { files } = parseMultipart(body, boundary, { maxFileBytes: 100 });
  assert.equal(files[0].truncated, true);
  assert.equal(validateFiles(files).ok, false);
});

/* ── Attachments ───────────────────────────────────────────────────────────────────────── */

test('an uploaded filename can never be a path', () => {
  assert.equal(safeDisplayName('../../etc/passwd'), 'passwd');
  assert.equal(safeDisplayName('C:\\Users\\me\\log.txt'), 'log.txt');
  assert.equal(safeDisplayName(''), 'attachment');
});

test('file types outside the allowlist are refused with a reason', () => {
  const result = validateFiles([{ filename: 'payload.html', size: 10, data: Buffer.alloc(10) }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /cannot accept/);
});

/* ── Access passes ─────────────────────────────────────────────────────────────────────── */

test('a pass opens its own ticket and nothing else', () => {
  const access = createAccess({ secret: 'a'.repeat(32) });
  const token = access.issue('NH-1111-2222');
  assert.equal(access.grants(token, 'NH-1111-2222'), true);
  assert.equal(access.grants(token, 'NH-3333-4444'), false);
});

test('an altered or expired pass verifies as nothing', () => {
  const access = createAccess({ secret: 'a'.repeat(32) });
  const token = access.issue('NH-1111-2222');
  assert.equal(access.verify(`${token}x`), null);
  assert.equal(access.verify('NH-1111-2222.9999999999.forged'), null);
  assert.equal(access.verify(undefined), null);

  const expired = createAccess({ secret: 'a'.repeat(32), ttlSeconds: -10 });
  assert.equal(expired.verify(expired.issue('NH-1111-2222')), null);
});

test('a pass signed with another key is refused', () => {
  const mine = createAccess({ secret: 'a'.repeat(32) });
  const theirs = createAccess({ secret: 'b'.repeat(32) });
  assert.equal(mine.verify(theirs.issue('NH-1111-2222')), null);
});

/* ── Rate limiting ─────────────────────────────────────────────────────────────────────── */

test('the limiter opens, closes, and can be cleared', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  assert.equal(limiter.hit('ip').ok, true);
  assert.equal(limiter.hit('ip').ok, true);
  assert.equal(limiter.hit('ip').ok, false);
  assert.equal(limiter.hit('other').ok, true);
  limiter.clear('ip');
  assert.equal(limiter.hit('ip').ok, true);
});

/* ── Ticket service ────────────────────────────────────────────────────────────────────── */

test('creating a ticket stores it, opens it, and records the first event', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const result = await h.tickets.create({ input: validInput, files: [] });
  assert.equal(result.ok, true);

  const ticket = result.ticket;
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.requester.email, 'reporter@example.com');
  assert.equal(ticket.events.length, 1);
  assert.equal(ticket.events[0].type, 'created');
  assert.equal(ticket.assignee, null);
  assert.deepEqual(ticket.tags, []);

  const reloaded = await h.tickets.get(ticket.id);
  assert.equal(reloaded.subject, validInput.subject);
});

test('a ticket survives a restart of the store', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const { ticket } = await h.tickets.create({ input: validInput, files: [] });

  const reopened = createFileStore({ dir: h.dir });
  const loaded = await reopened.init();
  assert.equal(loaded.loaded, 1);
  assert.equal((await reopened.get(ticket.id)).subject, validInput.subject);
});

test('invalid input returns errors instead of throwing, and writes nothing', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const result = await h.tickets.create({ input: { ...validInput, subject: '' }, files: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.subject);
  assert.equal((await h.store.list()).total, 0);
});

test('attachments are written and recorded on the ticket', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const result = await h.tickets.create({
    input: validInput,
    files: [{ field: 'files', filename: 'app.log', size: 5, data: Buffer.from('hello'), contentType: 'text/plain' }],
  });

  assert.equal(result.ticket.attachments.length, 1);
  const record = result.ticket.attachments[0];
  assert.equal(record.filename, 'app.log');
  assert.deepEqual(await h.attachments.read(result.ticket.id, record.id), Buffer.from('hello'));
});

test('a reply on a waiting ticket hands it back to support', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const { ticket } = await h.tickets.create({ input: validInput, files: [] });
  await h.tickets.setStatus(ticket.id, 'waiting_user', { actor: { kind: 'staff', name: 'Support' } });

  const replied = await h.tickets.addReply(ticket.id, { body: 'Here are the logs you asked for.' });
  assert.equal(replied.ok, true);
  assert.equal(replied.ticket.status, 'in_progress');
});

test('a reply on a closed ticket reopens it', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const { ticket } = await h.tickets.create({ input: validInput, files: [] });
  await h.tickets.setStatus(ticket.id, 'closed');
  const replied = await h.tickets.addReply(ticket.id, { body: 'This is happening again.' });
  assert.equal(replied.ticket.status, 'open');
});

test('illegal status transitions are refused', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const { ticket } = await h.tickets.create({ input: validInput, files: [] });
  await h.tickets.setStatus(ticket.id, 'closed');

  const refused = await h.tickets.setStatus(ticket.id, 'resolved');
  assert.equal(refused.ok, false);
  assert.equal((await h.tickets.get(ticket.id)).status, 'closed');

  assert.equal((await h.tickets.setStatus(ticket.id, 'invented')).ok, false);
});

test('internal notes never appear in the reporter view', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const { ticket } = await h.tickets.create({ input: validInput, files: [] });
  await h.tickets.addInternalNote(ticket.id, { body: 'Reproduced on the test rig.' });

  const stored = await h.tickets.get(ticket.id);
  assert.equal(stored.events.some((e) => e.visibility === 'internal'), true);
  assert.equal(publicEvents(stored).some((e) => e.body?.includes('test rig')), false);
});

test('concurrent replies all survive', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const { ticket } = await h.tickets.create({ input: validInput, files: [] });
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => h.tickets.addReply(ticket.id, { body: `Reply number ${i}` })),
  );

  const stored = await h.tickets.get(ticket.id);
  assert.equal(stored.events.filter((e) => e.type === 'reply').length, 12);
});

test('sensitive tickets are routed to a human at creation', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const { ticket } = await h.tickets.create({
    input: {
      ...validInput,
      category: 'account',
      issueType: 'account-security',
      subject: 'Someone else signed into my account',
    },
    files: [],
  });

  assert.equal(ticket.routing.humanOnly, true);
  assert.ok(ticket.routing.reason);
  assert.equal(ticket.priority, 'urgent');
});

test('summaries carry labels but never the description', async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  const { ticket } = await h.tickets.create({ input: validInput, files: [] });
  const view = summarize(ticket);
  assert.equal(view.labels.project, 'Online Earth');
  assert.equal(view.labels.issueType, "The globe isn't loading");
  assert.equal(view.description, undefined);
});

test('email comparison ignores case and surrounding space', () => {
  assert.equal(sameEmail('A@b.com', ' a@B.com '), true);
  assert.equal(sameEmail('a@b.com', 'a@b.co'), false);
  assert.equal(sameEmail(null, undefined), true);
});

/* ── Rendering ─────────────────────────────────────────────────────────────────────────── */

test('everything a reporter writes is escaped on the way out', () => {
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('" onload="x'), '&quot; onload=&quot;x');
  assert.match(paragraphs('<b>one</b>\n\ntwo'), /^<p>&lt;b&gt;one&lt;\/b&gt;<\/p><p>two<\/p>$/);
});
