/**
 * Request body parsing, and one bug in particular.
 *
 * THE BUG THIS FILE EXISTS FOR. `parseBody` lowercased the whole Content-Type header and then
 * read the multipart boundary out of the lowercased copy. A media type is case-insensitive so
 * lowercasing is right for choosing a parser; a boundary is a literal that has to match the
 * bytes in the body, and lowercasing it meant any client sending a boundary with a capital
 * letter in it parsed to NO FIELDS AT ALL. The reporter got "your ticket was not sent" with
 * every field blank, and no error anywhere said why.
 *
 * That is Chrome, Safari and Edge, which all send `----WebKitFormBoundary...`. Firefox sends
 * digits and was fine. The test suite was fine too, because undici's `FormData` picks a
 * lowercase boundary — so every existing attachment test passed while uploads from three of
 * the four major browsers were failing. Hence the boundaries below are written out by hand
 * rather than generated: the generated ones are exactly what hid this.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBody } from '../server/lib/body.mjs';

/** A request carrying `body`, with just enough of a Node stream for parseBody to read it. */
function request(headers, body) {
  const chunks = [Buffer.from(body, 'binary')];
  const listeners = new Map();
  const req = {
    method: 'POST',
    headers,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      if (event === 'end') {
        queueMicrotask(() => {
          for (const chunk of chunks) for (const fn of listeners.get('data') ?? []) fn(chunk);
          for (const fn of listeners.get('end') ?? []) fn();
        });
      }
      return req;
    },
    destroy() {},
  };
  return req;
}

/** A multipart body with the exact boundary given, built by hand. */
function multipart(boundary, { fields = {}, files = [] } = {}) {
  const parts = [
    ...Object.entries(fields).map(
      ([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
    ...files.map(
      (file) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n${file.data}\r\n`,
    ),
    `--${boundary}--\r\n`,
  ];
  return parts.join('');
}

/* ── The boundary is a literal, not a media type ─────────────────────────────────────────── */

const BOUNDARIES = {
  'Chrome, Safari and Edge': '----WebKitFormBoundary7MA4YWxkTrZu0gW',
  Firefox: '---------------------------9051914041544843365972754266',
  'undici, which the suite used to use exclusively': '----formdata-undici-064959751403',
  'every letter uppercase': 'ABCDEF0123456789',
  'mixed case with punctuation': 'X-Boundary_9aF.Zq--Test',
};

for (const [client, boundary] of Object.entries(BOUNDARIES)) {
  test(`a multipart body from ${client} parses its fields`, async () => {
    const body = multipart(boundary, {
      fields: { subject: 'The globe never finishes loading', email: 'reporter@example.com' },
    });
    const parsed = await parseBody(
      request({ 'content-type': `multipart/form-data; boundary=${boundary}` }, body),
    );

    assert.equal(parsed.ok, true);
    assert.equal(parsed.fields.subject, 'The globe never finishes loading');
    assert.equal(parsed.fields.email, 'reporter@example.com');
  });
}

test('a file survives a boundary with capital letters in it', async () => {
  const boundary = '----WebKitFormBoundaryAbCdEf123456';
  const body = multipart(boundary, {
    fields: { subject: 'Export fails' },
    files: [{ name: 'files', filename: 'session.log', type: 'text/plain', data: 'log line one\nlog line two' }],
  });

  const parsed = await parseBody(
    request({ 'content-type': `multipart/form-data; boundary=${boundary}` }, body),
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.subject, 'Export fails');
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].filename, 'session.log');
  assert.equal(parsed.files[0].data.toString('utf8'), 'log line one\nlog line two');
});

test('the media type itself is still matched case-insensitively', async () => {
  const boundary = '----WebKitFormBoundaryZZ99';
  const body = multipart(boundary, { fields: { subject: 'Still parsed' } });

  const parsed = await parseBody(
    request({ 'content-type': `Multipart/Form-Data; Boundary=${boundary}` }, body),
  );

  assert.equal(parsed.ok, true, 'MIME types are case-insensitive, and that has not changed');
  assert.equal(parsed.fields.subject, 'Still parsed');
});

test('a quoted boundary is unquoted, and keeps its case', async () => {
  const boundary = '----WebKitFormBoundaryQuoted';
  const body = multipart(boundary, { fields: { subject: 'Quoted boundary' } });

  const parsed = await parseBody(
    request({ 'content-type': `multipart/form-data; boundary="${boundary}"` }, body),
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.subject, 'Quoted boundary');
});

test('multipart with no boundary at all is refused rather than parsed as nothing', async () => {
  const parsed = await parseBody(request({ 'content-type': 'multipart/form-data' }, ''));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'bad-multipart');
});

/* ── The other two body types ────────────────────────────────────────────────────────────── */

test('a form-encoded body parses, whatever the case of its header', async () => {
  const parsed = await parseBody(
    request(
      { 'content-type': 'Application/X-WWW-Form-URLEncoded; charset=UTF-8' },
      'subject=Hello&email=a%40b.co',
    ),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.subject, 'Hello');
  assert.equal(parsed.fields.email, 'a@b.co');
  assert.deepEqual(parsed.files, []);
});

test('a JSON body parses, and a broken one is refused', async () => {
  const good = await parseBody(request({ 'content-type': 'application/json' }, '{"subject":"Hi"}'));
  assert.equal(good.ok, true);
  assert.equal(good.fields.subject, 'Hi');

  const bad = await parseBody(request({ 'content-type': 'application/json' }, '{not json'));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-json');

  // A JSON array is valid JSON and not a set of fields; taking it would produce nonsense.
  const array = await parseBody(request({ 'content-type': 'application/json' }, '[1,2,3]'));
  assert.equal(array.ok, false);
  assert.equal(array.reason, 'bad-json');
});
