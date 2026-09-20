/**
 * Managing a Nova Account: profile, password, address, sessions, pictures, and deletion.
 *
 * Every behaviour is run against BOTH stores. The file store and the D1 store implement
 * deletion, address changes and pictures completely differently, and the account is the same
 * account either way -- so a test that passed for one would say nothing about the other.
 *
 * What the tests care most about is what must NOT happen:
 *   - a change that needs the password must fail without it, and leave the account untouched
 *   - a deletion that is refused must delete nothing, and one whose ticket cleanup fails must
 *     delete nothing either (the two are one transaction)
 *   - a picture is only ever a PNG, JPEG or WebP, judged by its bytes
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAccounts, createMemoryMailer, isAvatarKeyFor, newAvatarKey, validateAvatar } from '@nova/accounts';
import { createD1AccountStore } from '@nova/accounts/d1Store';
import { createSqliteD1 } from '../server/store/sqliteD1.mjs';
import { applyAccountSchema } from '../server/store/migrate.mjs';

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'a passphrase nobody guesses';
const NEW_PASSWORD = 'an entirely different passphrase';
const SECRET = 'a-test-signing-secret-of-sufficient-length';

async function build(t, backend) {
  const mailer = createMemoryMailer();
  const logger = { warn() {}, error() {}, info() {} };
  if (backend === 'd1') {
    const db = createSqliteD1();
    await applyAccountSchema(db);
    t.after(() => db.close());
    const accounts = await createAccounts({
      secret: SECRET, cost: CHEAP, mailer, logger, store: createD1AccountStore({ db }),
    });
    return { accounts, mailer, db };
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'novamanage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accounts = await createAccounts({ dir, secret: SECRET, cost: CHEAP, mailer, logger });
  return { accounts, mailer, db: null };
}

/** An account with one signed-in session, and a token for it. */
async function signedUp(accounts, email = 'ann@example.com') {
  const made = await accounts.register({ email, displayName: 'Ann', password: PASSWORD, passwordConfirm: PASSWORD });
  assert.equal(made.ok, true, JSON.stringify(made));
  const session = await accounts.startSession(made.account.id);
  return { id: made.account.id, token: session.token, email };
}

for (const backend of ['file', 'd1']) {
  const name = (text) => `[${backend}] ${text}`;

  /* ── Profile ─────────────────────────────────────────────────────────────────────────── */

  test(name('the display name can be changed and cleared, and is bounded'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id } = await signedUp(accounts);

    assert.equal((await accounts.updateProfile(id, { displayName: '  Ann   Marie ' })).account.displayName, 'Ann Marie');
    assert.equal((await accounts.updateProfile(id, { displayName: '' })).account.displayName, null);

    const tooLong = await accounts.updateProfile(id, { displayName: 'x'.repeat(81) });
    assert.equal(tooLong.ok, false);
    assert.ok(tooLong.errors.displayName);
    assert.equal((await accounts.get(id)).displayName, null, 'a refused change changes nothing');
  });

  /* ── Password ────────────────────────────────────────────────────────────────────────── */

  test(name('changing the password needs the current one, and signs everything else out'), async (t) => {
    const { accounts, mailer } = await build(t, backend);
    const { id, token, email } = await signedUp(accounts);
    const other = await accounts.startSession(id); // a second device

    const wrong = await accounts.changePassword(id, { currentPassword: 'not it', password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD }, { keepToken: token });
    assert.equal(wrong.reason, 'wrong-password');
    assert.ok((await accounts.signIn({ email, password: PASSWORD })).ok, 'the old password still works after a refusal');

    const weak = await accounts.changePassword(id, { currentPassword: PASSWORD, password: 'short', passwordConfirm: 'short' }, { keepToken: token });
    assert.equal(weak.reason, 'invalid');

    const same = await accounts.changePassword(id, { currentPassword: PASSWORD, password: PASSWORD, passwordConfirm: PASSWORD }, { keepToken: token });
    assert.equal(same.reason, 'invalid');

    const done = await accounts.changePassword(id, { currentPassword: PASSWORD, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD }, { keepToken: token });
    assert.equal(done.ok, true);

    assert.equal((await accounts.signIn({ email, password: PASSWORD })).ok, false, 'the old password is dead');
    assert.equal((await accounts.signIn({ email, password: NEW_PASSWORD })).ok, true);
    assert.ok(await accounts.resolveSession(token), 'the session that asked is kept');
    assert.equal(await accounts.resolveSession(other.token), null, 'every other session is ended');
    assert.match(mailer.sent.at(-1).subject, /password was changed/);
    assert.equal(mailer.sent.at(-1).to, email);
  });

  test(name('a password change also kills an outstanding reset link'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, token, email } = await signedUp(accounts);
    await accounts.requestPasswordReset({ email }, { link: (raw) => `https://x.test/account/reset?token=${raw}` });
    await accounts.changePassword(id, { currentPassword: PASSWORD, password: NEW_PASSWORD, passwordConfirm: NEW_PASSWORD }, { keepToken: token });
    const account = await accounts.store.get(id);
    assert.ok(!account.passwordReset, 'no reset link survives');
  });

  /* ── Email ───────────────────────────────────────────────────────────────────────────── */

  test(name('changing the address needs the password, refuses a taken one, and moves sign-in'), async (t) => {
    const { accounts, mailer } = await build(t, backend);
    const { id, token, email } = await signedUp(accounts);
    await signedUp(accounts, 'bob@example.com');

    assert.equal((await accounts.changeEmail(id, { newEmail: 'ann2@example.com', currentPassword: 'nope' })).reason, 'wrong-password');
    assert.equal((await accounts.changeEmail(id, { newEmail: 'not an address', currentPassword: PASSWORD })).reason, 'invalid');
    assert.equal((await accounts.changeEmail(id, { newEmail: email, currentPassword: PASSWORD })).reason, 'invalid', 'the same address is not a change');
    assert.equal((await accounts.changeEmail(id, { newEmail: 'BOB@example.com', currentPassword: PASSWORD })).reason, 'email-taken');
    assert.equal((await accounts.store.get(id)).email, email, 'every refusal leaves the address alone');

    const done = await accounts.changeEmail(id, { newEmail: 'Ann.New@Example.com', currentPassword: PASSWORD });
    assert.equal(done.ok, true);
    assert.equal(done.account.email, 'ann.new@example.com', 'stored in the same lowercase form sign-up uses');
    assert.equal(done.account.emailVerified, false);

    assert.equal((await accounts.signIn({ email, password: PASSWORD })).ok, false, 'the old address no longer signs in');
    assert.equal((await accounts.signIn({ email: 'ann.new@example.com', password: PASSWORD })).ok, true);
    assert.ok(await accounts.resolveSession(token), 'the session survives an address change');
    assert.equal(await accounts.store.emailTaken(email), false, 'the old address is free again');

    const notice = mailer.sent.at(-1);
    assert.equal(notice.to, email, 'the OLD address is the one told');
    assert.match(notice.text, /ann\.new@example\.com/);
  });

  /* ── Sessions ────────────────────────────────────────────────────────────────────────── */

  test(name('the security page can list sessions, revoke one, and sign out the rest'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, token } = await signedUp(accounts);
    const b = await accounts.startSession(id);
    const c = await accounts.startSession(id);

    const list = await accounts.listSessions(id, { currentToken: token });
    assert.equal(list.length, 3);
    assert.equal(list.filter((s) => s.current).length, 1);
    assert.ok(!JSON.stringify(list).includes(token), 'no token is ever listed');

    const bId = list.find((s) => !s.current).id;
    const currentId = list.find((s) => s.current).id;
    assert.equal(await accounts.revokeSession(id, currentId, { keepToken: token }), false, 'the asking session is not revoked here');
    assert.equal(await accounts.revokeSession(id, bId, { keepToken: token }), true);
    assert.equal(await accounts.revokeSession(id, 'no-such-session', { keepToken: token }), false);

    assert.equal(await accounts.signOutOthers(id, { keepToken: token }), 1);
    assert.ok(await accounts.resolveSession(token));
    assert.equal((await accounts.listSessions(id, { currentToken: token })).length, 1);
    void b; void c;
  });

  /* ── Pictures ────────────────────────────────────────────────────────────────────────── */

  test(name('a picture reference is recorded, replaced, and cleared; a foreign key is refused'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id } = await signedUp(accounts);
    const other = await signedUp(accounts, 'bob@example.com');

    const first = newAvatarKey(id);
    assert.equal((await accounts.setAvatar(id, { objectKey: first, contentType: 'image/png', size: 100 })).previous, null);
    const second = newAvatarKey(id);
    const replaced = await accounts.setAvatar(id, { objectKey: second, contentType: 'image/webp', size: 90 });
    assert.equal(replaced.previous.objectKey, first, 'the caller is told which object to delete');
    assert.equal((await accounts.getAvatar(id)).objectKey, second);

    assert.equal((await accounts.setAvatar(id, { objectKey: newAvatarKey(other.id), contentType: 'image/png', size: 1 })).ok, false, "another account's key");
    assert.equal((await accounts.setAvatar(id, { objectKey: '../../etc/passwd', contentType: 'image/png', size: 1 })).ok, false);
    assert.equal((await accounts.setAvatar(id, { objectKey: newAvatarKey(id), contentType: 'text/html', size: 1 })).ok, false);
    assert.equal((await accounts.getAvatar(id)).objectKey, second, 'refusals change nothing');

    assert.equal((await accounts.clearAvatar(id)).objectKey, second);
    assert.equal(await accounts.getAvatar(id), null);
  });

  /* ── Deletion ────────────────────────────────────────────────────────────────────────── */

  test(name('deleting an account needs the password AND the address typed, and refusals delete nothing'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, token, email } = await signedUp(accounts);

    assert.equal((await accounts.deleteAccount(id, { currentPassword: 'nope', confirmEmail: email })).reason, 'wrong-password');
    assert.equal((await accounts.deleteAccount(id, { currentPassword: PASSWORD, confirmEmail: 'someone@else.com' })).reason, 'not-confirmed');
    assert.equal((await accounts.deleteAccount(id, { currentPassword: PASSWORD })).reason, 'not-confirmed');
    assert.ok(await accounts.resolveSession(token), 'the account is still there after every refusal');
    assert.equal((await accounts.signIn({ email, password: PASSWORD })).ok, true);
  });

  test(name('a deleted account is gone everywhere, and its address can be used again'), async (t) => {
    const { accounts, mailer } = await build(t, backend);
    const { id, token, email } = await signedUp(accounts);
    const key = newAvatarKey(id);
    await accounts.setAvatar(id, { objectKey: key, contentType: 'image/png', size: 5 });
    await accounts.sync.put?.(id, 'atlas', { baseVersion: 0, document: { a: 1 } }).catch(() => {});

    const done = await accounts.deleteAccount(id, { currentPassword: PASSWORD, confirmEmail: ' ANN@example.com ' });
    assert.equal(done.ok, true);
    assert.equal(done.avatar.objectKey, key, 'the caller is handed the object to delete');

    assert.equal(await accounts.store.get(id), null);
    assert.equal(await accounts.store.getByEmail(email), null);
    assert.equal(await accounts.resolveSession(token), null, 'the old cookie no longer means anything');
    assert.equal((await accounts.signIn({ email, password: PASSWORD })).ok, false);
    assert.equal(await accounts.getAvatar(id), null);
    assert.match(mailer.sent.at(-1).subject, /was deleted/);

    const again = await accounts.register({ email, password: PASSWORD, passwordConfirm: PASSWORD });
    assert.equal(again.ok, true, 'the address can be registered again');
    assert.notEqual(again.account.id, id, 'and it is a NEW account, not the old one back');
  });
}

/* ── D1 only: the same-transaction hook the ticket cleanup relies on ─────────────────────── */

test('deletion runs the caller\'s statements in the same transaction, and a failure deletes nothing', async (t) => {
  const { accounts, db } = await build(t, 'd1');
  await db.exec('CREATE TABLE scratch (owner TEXT, note TEXT)');
  const { id, email } = await signedUp(accounts);
  await db.prepare('INSERT INTO scratch (owner, note) VALUES (?, ?)').bind(id, 'mine').run();

  // A hook that cannot succeed: the batch must roll back, so the account survives.
  const failing = await accounts.deleteAccount(id, { currentPassword: PASSWORD, confirmEmail: email }, {
    beforeDelete: (d) => [d.prepare("UPDATE scratch SET note = 'changed' WHERE owner = ?").bind(id), d.prepare('UPDATE no_such_table SET x = 1')],
  }).then(() => 'resolved', () => 'threw');
  assert.equal(failing, 'threw');
  assert.ok(await accounts.store.get(id), 'the account is still there');
  assert.equal((await db.prepare('SELECT note FROM scratch WHERE owner = ?').bind(id).first('note')), 'mine', 'and the earlier statement was rolled back');

  const done = await accounts.deleteAccount(id, { currentPassword: PASSWORD, confirmEmail: email }, {
    beforeDelete: (d) => [d.prepare("UPDATE scratch SET owner = NULL, note = 'anonymised' WHERE owner = ?").bind(id)],
  });
  assert.equal(done.ok, true);
  assert.equal(await accounts.store.get(id), null);
  assert.equal(await db.prepare("SELECT note FROM scratch WHERE note = 'anonymised'").first('note'), 'anonymised');
});

test('deleting an account cascades through every table that hangs off it', async (t) => {
  const { accounts, db } = await build(t, 'd1');
  const { id, email } = await signedUp(accounts);
  await accounts.requestPasswordReset({ email }, { link: (raw) => `https://x.test/r?token=${raw}` });
  await accounts.setAvatar(id, { objectKey: newAvatarKey(id), contentType: 'image/png', size: 5 });
  await accounts.deleteAccount(id, { currentPassword: PASSWORD, confirmEmail: email });

  for (const table of ['accounts', 'account_sessions', 'account_identities', 'account_products', 'account_password_resets', 'account_sync_documents', 'account_avatars']) {
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n');
    assert.equal(Number(left), 0, `${table} is empty`);
  }
});

/* ── Picture validation: the type comes from the bytes ───────────────────────────────────── */

const pad = (bytes, to = 64) => Uint8Array.from([...bytes, ...new Array(Math.max(0, to - bytes.length)).fill(0)]);
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >>> 8) & 255, n & 255];
const le32 = (n) => be32(n).reverse();
const le16 = (n) => be16(n).reverse();
const text = (s) => [...s].map((c) => c.charCodeAt(0));

const png = (w, h) => pad([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
const jpeg = (w, h) => pad([0xff, 0xd8, 0xff, 0xe0, ...be16(16), ...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3]);
const webpX = (w, h) => pad([...text('RIFF'), ...le32(50), ...text('WEBP'), ...text('VP8X'), ...le32(10), 0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]);
const webpLossy = (w, h) => pad([...text('RIFF'), ...le32(50), ...text('WEBP'), ...text('VP8 '), ...le32(30), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
const webpLossless = (w, h) => pad([...text('RIFF'), ...le32(50), ...text('WEBP'), ...text('VP8L'), ...le32(10), 0x2f, ...le32(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14))]);

test('PNG, JPEG and every WebP flavour are recognised by their bytes, with their real size', () => {
  for (const [label, bytes, type] of [
    ['png', png(256, 128), 'image/png'],
    ['jpeg', jpeg(300, 200), 'image/jpeg'],
    ['webp extended', webpX(256, 256), 'image/webp'],
    ['webp lossy', webpLossy(180, 90), 'image/webp'],
    ['webp lossless', webpLossless(64, 32), 'image/webp'],
  ]) {
    const checked = validateAvatar(bytes);
    assert.equal(checked.ok, true, label);
    assert.equal(checked.image.contentType, type, label);
  }
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(validateAvatar(webpLossless(64, 32)).image),
    { width: 64, height: 32 },
  );
});

test('anything that is not one of those three is refused, whatever it is called', () => {
  const html = pad(text('<!doctype html><script>alert(1)</script>'));
  const svg = pad(text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  const gif = pad([...text('GIF89a'), 1, 0, 1, 0]);
  const exe = pad([0x4d, 0x5a, 0x90, 0]);
  for (const [label, bytes] of [['html', html], ['svg', svg], ['gif', gif], ['exe', exe], ['empty', new Uint8Array(0)], ['tiny', new Uint8Array(4)]]) {
    assert.equal(validateAvatar(bytes).ok, false, label);
  }
});

test('a PNG signature with no header, and a truncated JPEG, are refused', () => {
  assert.equal(validateAvatar(pad([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a])).ok, false);
  assert.equal(validateAvatar(pad([0xff, 0xd8, 0xff, 0xe0])).ok, false);
});

test('a picture that is too large, in bytes or in pixels, is refused', () => {
  assert.equal(validateAvatar(png(4000, 4000)).ok, false, 'pixels');
  assert.equal(validateAvatar(png(0, 10)).ok, false, 'zero width');
  const big = new Uint8Array(300 * 1024);
  big.set(png(100, 100));
  assert.equal(validateAvatar(big).ok, false, 'bytes');
});

test('object keys are generated, per account, and cannot be forged', () => {
  const a = 'NA-4T7K-9QW2-H30X';
  const key = newAvatarKey(a);
  assert.match(key, /^avatars\/NA-4T7K-9QW2-H30X\/[0-9a-f]{48}$/);
  assert.notEqual(newAvatarKey(a), key, 'never reused');
  assert.equal(isAvatarKeyFor(a, key), true);
  assert.equal(isAvatarKeyFor('NA-AAAA-AAAA-AAAA', key), false, 'another account');
  for (const bad of ['tickets/abc/def', 'avatars/../x', `${key}/extra`, `${key}.png`, '', null, `avatars/${a}/../../x`]) {
    assert.equal(isAvatarKeyFor(a, bad), false, String(bad));
  }
});

test('before the avatar migration is applied, the account still works and can be deleted', async (t) => {
  const { accounts, db } = await build(t, 'd1');
  await db.exec('DROP TABLE account_avatars');
  const { id, token, email } = await signedUp(accounts);

  assert.equal(await accounts.getAvatar(id), null, 'no table means no picture, not an error');
  assert.ok(await accounts.resolveSession(token));
  const done = await accounts.deleteAccount(id, { currentPassword: PASSWORD, confirmEmail: email });
  assert.equal(done.ok, true, 'deletion does not depend on the new table');
  assert.equal(done.avatar, null);
});

test('a real D1 counts cascaded rows in `changes`, and deletion still reports success', async (t) => {
  // Found on wrangler's real runtime: `changes` was 4 (the account plus its cascaded rows), and a
  // store that demanded exactly 1 answered "no such account" AFTER the account had been deleted.
  const { accounts, db } = await build(t, 'd1');
  const realBatch = db.batch.bind(db);
  db.batch = async (statements) => {
    const results = await realBatch(statements);
    const last = results.at(-1);
    return [...results.slice(0, -1), { ...last, meta: { ...last.meta, changes: last.meta.changes + 3 } }];
  };
  const { id, email } = await signedUp(accounts);
  const done = await accounts.deleteAccount(id, { currentPassword: PASSWORD, confirmEmail: email });
  assert.equal(done.ok, true);
  assert.equal(await accounts.store.get(id), null);
});
