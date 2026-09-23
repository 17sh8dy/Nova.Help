/**
 * The Resend HTTP mail transport, in isolation — no real network call, a scripted `fetch` in
 * its place, matching the `fetchImpl`-injection pattern `providers/oidc.mjs` already uses for
 * the same reason: the real transport is a config decision, this file proves what the code does
 * with a given response rather than trusting a live third party.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createResendMailer } from '../server/mail/resendMailer.mjs';

function fakeFetch({ status = 200, body = { id: 'abc123' } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { fetchImpl, calls };
}

test('createResendMailer refuses to be built without an apiKey', () => {
  assert.throws(() => createResendMailer({}), /apiKey/);
});

test('a successful send posts the right shape to the real Resend endpoint', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const mailer = createResendMailer({ apiKey: 'sk_test_123', fetchImpl });

  const result = await mailer.send({ to: 'getnovasupport@gmail.com', subject: 'New ticket', text: 'Body.' });

  assert.equal(result.ok, true);
  assert.equal(result.id, 'abc123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk_test_123');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    from: 'Nova.Help <onboarding@resend.dev>',
    to: 'getnovasupport@gmail.com',
    subject: 'New ticket',
    text: 'Body.',
  });
});

test('a custom from address is used instead of the shared onboarding domain', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const mailer = createResendMailer({ apiKey: 'sk_test_123', from: 'Nova.Help <noreply@nova.help>', fetchImpl });

  await mailer.send({ to: 'x@example.com', subject: 's', text: 't' });

  assert.equal(JSON.parse(calls[0].init.body).from, 'Nova.Help <noreply@nova.help>');
});

test('a refused send throws, matching every other transport in this codebase', async () => {
  const { fetchImpl } = fakeFetch({ status: 422, body: { message: 'invalid `to` field' } });
  const mailer = createResendMailer({ apiKey: 'sk_test_123', fetchImpl });

  await assert.rejects(
    () => mailer.send({ to: 'not-an-email', subject: 's', text: 't' }),
    /422/,
  );
});

test('the configured flag is true, matching every real transport', () => {
  const mailer = createResendMailer({ apiKey: 'sk_test_123', fetchImpl: fakeFetch().fetchImpl });
  assert.equal(mailer.configured, true);
});
