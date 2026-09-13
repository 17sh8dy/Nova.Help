/**
 * Unit-level coverage for the parts of the SMTP transport that don't require a real mail
 * server: the misconfiguration guard, and dot-stuffing (RFC 5321) which is easy to get subtly
 * wrong and would show up only as a truncated or corrupted message body in production.
 *
 * The actual SMTP conversation (STARTTLS, AUTH LOGIN, DATA) is not exercised here — it needs a
 * real or fully-simulated TLS server to test honestly, which is disproportionate for this
 * change. It is intended to be verified once, by hand, against a real Gmail app password before
 * relying on it — see server/mail/smtpMailer.mjs's own doc comment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSmtpMailer, dotStuff } from '../server/mail/smtpMailer.mjs';

test('refuses to build without both a user and a password', () => {
  assert.throws(() => createSmtpMailer({ user: 'someone@gmail.com' }), /user and pass/);
  assert.throws(() => createSmtpMailer({ pass: 'x'.repeat(16) }), /user and pass/);
});

test('reports itself as configured once user and pass are given', () => {
  const mailer = createSmtpMailer({ user: 'someone@gmail.com', pass: 'x'.repeat(16) });
  assert.equal(mailer.configured, true);
});

test('dot-stuffing escapes a leading dot so the server does not read it as end-of-data', () => {
  const stuffed = dotStuff('Line one\n.\nLine three');
  assert.equal(stuffed, 'Line one\r\n..\r\nLine three');
});

test('dot-stuffing leaves ordinary lines untouched', () => {
  const stuffed = dotStuff('No dots here.\nOr here either.');
  assert.equal(stuffed, 'No dots here.\r\nOr here either.');
});

test('a send against an unreachable server fails gracefully — no throw, no hang', async () => {
  const warnings = [];
  const mailer = createSmtpMailer({
    host: '127.0.0.1',
    port: 1, // nothing listens on port 1
    user: 'someone@gmail.com',
    pass: 'x'.repeat(16),
    logger: { error: (...a) => warnings.push(a) },
  });

  const result = await mailer.send({ to: 'x@example.com', subject: 'test', text: 'test' });
  assert.equal(result.ok, false);
  assert.equal(warnings.length, 1);
});
