/**
 * Filing a ticket notifies staff by mail — the new behavior added so a submitted report doesn't
 * just sit in the store until somebody happens to look. The database write is still the actual
 * record (see core/tickets.mjs's own comment on this); these tests are about the notification
 * on top of it, and about that notification never being able to turn a successful submission
 * into a failed one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFileStore } from '../server/store/fileStore.mjs';
import { createAttachmentStore } from '../server/core/attachments.mjs';
import { createTicketService } from '../server/core/tickets.mjs';
import { ticketCreatedMessage } from '../server/core/notify.mjs';

async function harness(extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'novahelp-notify-'));
  const store = createFileStore({ dir });
  await store.init();
  const attachments = createAttachmentStore({ dir });
  return {
    tickets: createTicketService({ store, attachments, ...extra }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const validInput = {
  project: 'online-earth',
  category: 'globe',
  issueType: 'globe-not-loading',
  subject: 'The globe never finishes loading',
  description: 'It sits on the loading spinner forever on a fresh profile, on two machines.',
  email: 'reporter@example.com',
  name: 'Sam',
  priority: 'high',
};

function memoryMailer() {
  const sent = [];
  return { sent, async send(message) { sent.push(message); return { ok: true }; } };
}

test('filing a ticket sends exactly one notification to the configured address', async (t) => {
  const mailer = memoryMailer();
  const { tickets, cleanup } = await harness({ mailer, notifyEmail: 'getnovasupport@gmail.com' });
  t.after(cleanup);

  const created = await tickets.create({ input: validInput });
  assert.equal(created.ok, true);

  assert.equal(mailer.sent.length, 1);
  const message = mailer.sent[0];
  assert.equal(message.to, 'getnovasupport@gmail.com');
  assert.match(message.subject, new RegExp(created.ticket.id));
  assert.match(message.text, /reporter@example\.com/);
  assert.match(message.text, new RegExp(created.ticket.id));
  assert.match(message.text, /The globe never finishes loading/);
});

test('with no mailer configured, the ticket is still created — notification is best-effort only', async (t) => {
  const { tickets, cleanup } = await harness();
  t.after(cleanup);

  const created = await tickets.create({ input: validInput });
  assert.equal(created.ok, true);
  assert.ok(created.ticket.id);
});

test('with no notifyEmail configured, nothing is sent even though a mailer exists', async (t) => {
  const mailer = memoryMailer();
  const { tickets, cleanup } = await harness({ mailer });
  t.after(cleanup);

  const created = await tickets.create({ input: validInput });
  assert.equal(created.ok, true);
  assert.equal(mailer.sent.length, 0);
});

test('a throwing mailer does not fail ticket creation, and is logged', async (t) => {
  const warnings = [];
  const errors = [];
  const brokenMailer = { async send() { throw new Error('SMTP is down'); } };
  const { tickets, cleanup } = await harness({
    mailer: brokenMailer,
    notifyEmail: 'getnovasupport@gmail.com',
    logger: { warn: (...a) => warnings.push(a), error: (...a) => errors.push(a) },
  });
  t.after(cleanup);

  const created = await tickets.create({ input: validInput });
  assert.equal(created.ok, true, 'the ticket is still created even though mail failed');
  assert.equal(errors.length, 1);
});

test('a mailer that reports failure (not a throw) does not fail ticket creation either, and warns once', async (t) => {
  const warnings = [];
  const failingMailer = { async send() { return { ok: false, reason: 'no-transport' }; } };
  const { tickets, cleanup } = await harness({
    mailer: failingMailer,
    notifyEmail: 'getnovasupport@gmail.com',
    logger: { warn: (...a) => warnings.push(a) },
  });
  t.after(cleanup);

  const created = await tickets.create({ input: validInput });
  assert.equal(created.ok, true);
  assert.equal(warnings.length, 1);
});

/* ── The message shape itself ────────────────────────────────────────────────────────────── */

test('ticketCreatedMessage never invents information the ticket does not have', () => {
  const ticket = {
    id: 'NH-TEST-0001',
    project: 'online-earth',
    category: 'globe',
    priority: 'high',
    requester: { email: 'reporter@example.com' },
    accountId: null,
    subject: 'The globe never finishes loading',
    description: 'It sits on the loading spinner forever.',
    createdAt: '2026-09-13T12:00:00.000Z',
  };

  const message = ticketCreatedMessage({ to: 'getnovasupport@gmail.com', ticket, projectLabel: 'Online Earth', categoryLabel: 'Globe' });

  assert.equal(message.to, 'getnovasupport@gmail.com');
  assert.match(message.text, /Category: Globe/);
  assert.match(message.text, /Project: Online Earth/);
  assert.match(message.text, /User: reporter@example\.com \(guest — no Nova Account\)/);
  assert.match(message.text, /Ticket ID: NH-TEST-0001/);
  assert.match(message.text, /Submitted: Sep\w*\. 13, 2026/);
});

test('a ticket filed by a signed-in Nova Account says so in the notification', () => {
  const ticket = {
    id: 'NH-TEST-0002',
    project: 'atlas',
    category: 'account',
    priority: 'urgent',
    requester: { email: 'reporter@example.com' },
    accountId: 'NA-ABCD-1234-EFGH',
    subject: 'Cannot sign in',
    description: 'Password reset link never arrives.',
    createdAt: '2026-09-13T12:00:00.000Z',
  };

  const message = ticketCreatedMessage({ to: 'x@example.com', ticket });
  assert.match(message.text, /User: reporter@example\.com \(Nova Account NA-ABCD-1234-EFGH\)/);
});
