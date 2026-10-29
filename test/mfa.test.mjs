/**
 * Two-step verification: an authenticator app (TOTP) plus recovery codes.
 *
 * The arithmetic is checked against the RFCs' own published vectors; the account behaviour is run
 * against BOTH stores, because the file store and the D1 store keep the record in completely
 * different ways and the guarantees (counted guesses, one-time codes, nothing on until proven)
 * must hold identically in each.
 *
 * What the tests care most about is what must NOT happen:
 *   - a correct password must never be enough to get a session once two-step is on
 *   - two-step must not switch on until a real code from the app has been shown
 *   - a code, once accepted, must not be accepted again; a recovery code works exactly once
 *   - guessing must be counted on the account, not on whatever ticket or session made the guess
 *   - the secret must not be readable from the stored record, nor move to another account
 *   - it must not be possible to turn it off, or replace the recovery codes, on a session alone
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAccounts, createMemoryMailer, qrSvg } from '@nova/accounts';
import { createD1AccountStore } from '@nova/accounts/d1Store';
import { base32Decode, base32Encode, hotp, otpauthUri, totpAt, verifyTotp } from '../packages/nova-accounts/totp.mjs';
import { createMfaVault } from '../packages/nova-accounts/mfa.mjs';
import { encodeQr } from '../packages/nova-accounts/qr.mjs';
import { createSqliteD1 } from '../server/store/sqliteD1.mjs';
import { applyAccountSchema } from '../server/store/migrate.mjs';

const CHEAP = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'a passphrase nobody guesses';
const SECRET = 'a-test-signing-secret-of-sufficient-length';
const T0 = Date.parse('2026-10-28T12:00:00Z');

/* ── The arithmetic ──────────────────────────────────────────────────────────────────────────── */

test('HOTP matches the RFC 4226 appendix D vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(hotp(secret, counter), code));
});

test('TOTP matches the RFC 6238 SHA-1 vectors (last six digits of the eight-digit values)', () => {
  const secret = Buffer.from('12345678901234567890');
  const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];
  for (const [seconds, code] of vectors) assert.equal(totpAt(secret, seconds * 1000), code, `t=${seconds}`);
});

test('base32 round-trips, and tolerates the way people type a secret', () => {
  const bytes = Buffer.from('12345678901234567890');
  assert.equal(base32Encode(bytes), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq GEZDGNBVGY3TQOJQ=='), bytes);
  assert.equal(base32Decode('not*base32'), null);
  assert.equal(base32Decode(''), null);
});

test('verification accepts one step either side, refuses further, and refuses non-codes', () => {
  const secret = Buffer.from('12345678901234567890');
  const at = (offset) => hotp(secret, Math.floor(T0 / 30000) + offset);
  assert.equal(verifyTotp(secret, at(0), { now: T0 }).ok, true);
  assert.equal(verifyTotp(secret, at(-1), { now: T0 }).ok, true);
  assert.equal(verifyTotp(secret, at(1), { now: T0 }).ok, true);
  assert.equal(verifyTotp(secret, at(2), { now: T0 }).ok, false);
  assert.equal(verifyTotp(secret, at(-2), { now: T0 }).ok, false);
  for (const junk of ['', '12345', '1234567', 'abcdef', null, undefined, '12 34 5']) {
    assert.equal(verifyTotp(secret, junk, { now: T0 }).ok, false, String(junk));
  }
  // Spaces and a dash between the halves are how an app displays it.
  assert.equal(verifyTotp(secret, `${at(0).slice(0, 3)} ${at(0).slice(3)}`, { now: T0 }).ok, true);
});

test('a code at or before the last accepted step is refused (no replay)', () => {
  const secret = Buffer.from('12345678901234567890');
  const code = totpAt(secret, T0);
  const first = verifyTotp(secret, code, { now: T0 });
  assert.equal(first.ok, true);
  assert.equal(verifyTotp(secret, code, { now: T0, notAfter: first.step }).ok, false);
  // The next step's code is still fine.
  assert.equal(verifyTotp(secret, hotp(secret, first.step + 1), { now: T0 + 30000, notAfter: first.step }).ok, true);
});

test('the setup URI carries what authenticator apps read', () => {
  const uri = otpauthUri({ secret: Buffer.from('12345678901234567890'), account: 'ann@example.com', issuer: 'Nova' });
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.host, 'totp');
  assert.equal(decodeURIComponent(parsed.pathname), '/Nova:ann@example.com');
  assert.equal(parsed.searchParams.get('secret'), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(parsed.searchParams.get('issuer'), 'Nova');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
});

/* ── The vault ───────────────────────────────────────────────────────────────────────────────── */

test('a sealed secret opens for its own account and for nobody else', () => {
  const vault = createMfaVault({ secret: SECRET });
  const raw = Buffer.from('12345678901234567890');
  const sealed = vault.seal('acct-1', raw);
  assert.ok(!sealed.includes(raw.toString('base64url')), 'the plaintext is not in the sealed form');
  assert.deepEqual(vault.open('acct-1', sealed), raw);
  assert.equal(vault.open('acct-2', sealed), null, 'moved onto another account it will not open');
  assert.equal(createMfaVault({ secret: SECRET + 'x' }).open('acct-1', sealed), null, 'nor under another key');
  const parts = sealed.split('.');
  parts[2] = Buffer.from('tampered tampered tampered').toString('base64url');
  assert.equal(vault.open('acct-1', parts.join('.')), null);
  assert.equal(vault.open('acct-1', 'garbage'), null);
});

test('recovery codes are distinct, hashed, forgiving of typing, and match exactly one', () => {
  const vault = createMfaVault({ secret: SECRET });
  const codes = vault.newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);

  const hashes = codes.map((c) => vault.hashRecovery(c));
  assert.ok(hashes.every((h) => !codes.some((c) => h.includes(c.replace('-', '')))), 'no plaintext in a hash');
  assert.equal(vault.matchRecovery(hashes, codes[3]), 3);
  assert.equal(vault.matchRecovery(hashes, codes[3].toLowerCase().replace('-', ' ')), 3, 'case, dash and space are forgiven');
  assert.equal(vault.matchRecovery(hashes, 'AAAAA-AAAAA'), -1);
  assert.equal(vault.matchRecovery(hashes, ''), -1);
  assert.equal(vault.matchRecovery(hashes, '123456'), -1, 'a six digit code is not a recovery code');
});

test('a sign-in ticket verifies, expires, and cannot be altered or forged', () => {
  const vault = createMfaVault({ secret: SECRET });
  const ticket = vault.issueTicket('acct-1', { now: T0 });
  assert.equal(vault.readTicket(ticket, { now: T0 + 60_000 }), 'acct-1');
  assert.equal(vault.readTicket(ticket, { now: T0 + 6 * 60_000 }), null, 'five minutes, then dead');
  const [id, expiry, sig] = ticket.split('.');
  assert.equal(vault.readTicket(`acct-2.${expiry}.${sig}`, { now: T0 }), null, 'another account id');
  assert.equal(vault.readTicket(`${id}.${Number(expiry) + 999}.${sig}`, { now: T0 }), null, 'a longer life');
  assert.equal(createMfaVault({ secret: SECRET + 'x' }).readTicket(ticket, { now: T0 }), null);
  assert.equal(vault.readTicket('', { now: T0 }), null);
  assert.equal(vault.readTicket(undefined, { now: T0 }), null);
});

/* ── The QR code ─────────────────────────────────────────────────────────────────────────────── */

test('the QR encoder produces a square of the right size for the version, with finder patterns', () => {
  const uri = otpauthUri({ secret: Buffer.alloc(20, 7), account: 'ann@example.com', issuer: 'Nova' });
  const m = encodeQr(uri);
  assert.equal(m.length, m[0].length);
  assert.equal((m.length - 17) % 4, 0, 'size is 17 + 4 x version');
  // The top-left finder: a dark ring, a light ring, a dark 3x3 core.
  assert.equal(m[0][0] && m[0][6] && m[6][0] && m[6][6], true);
  assert.equal(m[1][1] || m[1][5] || m[5][1] || m[5][5], false);
  assert.equal(m[2][2] && m[3][3] && m[4][4], true);
  assert.throws(() => encodeQr('x'.repeat(300)), /too long/);
});

test('the SVG is inline, self-contained and escapes its label', () => {
  const svg = qrSvg('otpauth://totp/Nova:a@b.c?secret=ABC', { label: 'a "label" <b>' });
  assert.match(svg, /^<svg /);
  assert.ok(!svg.includes('<b>') && !svg.includes('"label"'));
  assert.ok(!/href=|<script|<image/i.test(svg), 'nothing in it reaches out');
});

/* ── The account ─────────────────────────────────────────────────────────────────────────────── */

async function build(t, backend) {
  const mailer = createMemoryMailer();
  const logger = { warn() {}, error() {}, info() {} };
  if (backend === 'd1') {
    const db = createSqliteD1();
    await applyAccountSchema(db);
    t.after(() => db.close());
    const accounts = await createAccounts({ secret: SECRET, cost: CHEAP, mailer, logger, store: createD1AccountStore({ db }) });
    return { accounts, mailer, db };
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'novamfa-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accounts = await createAccounts({ dir, secret: SECRET, cost: CHEAP, mailer, logger });
  return { accounts, mailer, db: null };
}

async function signedUp(accounts, email = 'ann@example.com') {
  const made = await accounts.register({ email, displayName: 'Ann', password: PASSWORD, passwordConfirm: PASSWORD });
  assert.equal(made.ok, true, JSON.stringify(made));
  return { id: made.account.id, email };
}

/** Run setup to the end. Returns the secret bytes (what the phone holds) and the recovery codes. */
async function enrol(accounts, id, now = T0) {
  assert.equal((await accounts.beginMfaEnrollment(id, { currentPassword: PASSWORD }, { now })).ok, true);
  const setup = await accounts.pendingMfaSetup(id, { now });
  const secret = base32Decode(new URL(setup.uri).searchParams.get('secret'));
  const done = await accounts.confirmMfaEnrollment(id, totpAt(secret, now), { now });
  assert.equal(done.ok, true, JSON.stringify(done));
  return { secret, recoveryCodes: done.recoveryCodes };
}

for (const backend of ['file', 'd1']) {
  const name = (text) => `[${backend}] ${text}`;

  test(name('setup needs the password, and nothing is on until a real code is shown'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, email } = await signedUp(accounts);

    const wrong = await accounts.beginMfaEnrollment(id, { currentPassword: 'not it' }, { now: T0 });
    assert.equal(wrong.ok, false);
    assert.equal((await accounts.pendingMfaSetup(id, { now: T0 })), null, 'a refused start leaves nothing pending');

    assert.equal((await accounts.beginMfaEnrollment(id, { currentPassword: PASSWORD }, { now: T0 })).ok, true);
    assert.equal((await accounts.mfaStatus(id, { now: T0 })).enabled, false, 'started is not enabled');
    assert.equal((await accounts.signIn({ email, password: PASSWORD })).ok, true, 'and sign-in still needs no code');

    const setup = await accounts.pendingMfaSetup(id, { now: T0 });
    assert.match(setup.uri, /^otpauth:\/\/totp\/Nova:ann%40example\.com\?/);
    assert.match(setup.secret, /^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/);

    const bad = await accounts.confirmMfaEnrollment(id, '000000', { now: T0 });
    assert.equal(bad.ok, false);
    assert.equal((await accounts.mfaStatus(id, { now: T0 })).enabled, false, 'a wrong first code does not switch it on');
  });

  test(name('confirming switches it on, returns ten recovery codes once, and tells the owner'), async (t) => {
    const { accounts, mailer } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    const { recoveryCodes } = await enrol(accounts, id);

    assert.equal(recoveryCodes.length, 10);
    const status = await accounts.mfaStatus(id, { now: T0 });
    assert.deepEqual([status.enabled, status.recoveryRemaining, status.pending], [true, 10, false]);
    assert.equal(await accounts.pendingMfaSetup(id, { now: T0 }), null, 'the secret is no longer shown');

    const note = mailer.sent.find((m) => /ON/.test(m.subject));
    assert.ok(note, 'a mail went out');
    assert.equal(note.to, email);
    assert.ok(!recoveryCodes.some((c) => note.text.includes(c)), 'and the codes are not in it');
  });

  test(name('starting setup again cannot replace an enabled secret'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id } = await signedUp(accounts);
    await enrol(accounts, id);
    const again = await accounts.beginMfaEnrollment(id, { currentPassword: PASSWORD }, { now: T0 });
    assert.deepEqual([again.ok, again.reason], [false, 'already-enabled']);
    assert.equal((await accounts.mfaStatus(id, { now: T0 })).enabled, true);
  });

  test(name('an abandoned setup expires, and too many wrong first codes discard it'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id } = await signedUp(accounts);

    await accounts.beginMfaEnrollment(id, { currentPassword: PASSWORD }, { now: T0 });
    assert.equal(await accounts.pendingMfaSetup(id, { now: T0 + 16 * 60_000 }), null, 'fifteen minutes, then gone');

    await accounts.beginMfaEnrollment(id, { currentPassword: PASSWORD }, { now: T0 });
    const setup = await accounts.pendingMfaSetup(id, { now: T0 });
    const secret = base32Decode(new URL(setup.uri).searchParams.get('secret'));
    let last;
    for (let i = 0; i < 5; i += 1) last = await accounts.confirmMfaEnrollment(id, '000000', { now: T0 });
    assert.equal(last.reason, 'start-over');
    const right = await accounts.confirmMfaEnrollment(id, totpAt(secret, T0), { now: T0 });
    assert.equal(right.ok, false, 'even the right code is useless once the secret was thrown away');
  });

  test(name('a correct password is NOT a sign-in once two-step is on'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    await enrol(accounts, id);

    const attempt = await accounts.signIn({ email, password: PASSWORD });
    assert.equal(attempt.ok, false, 'signIn must not report success');
    assert.equal(attempt.reason, 'mfa-required');
    assert.ok(attempt.ticket);
    assert.equal(attempt.account, undefined, 'and hands back no account to open a session for');

    const wrong = await accounts.signIn({ email, password: 'wrong' });
    assert.equal(wrong.reason, 'invalid', 'a wrong password never reaches the second step, or reveals that one exists');
    assert.equal(wrong.ticket, undefined);
  });

  test(name('the second step opens the door once, with the app code'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    const { secret } = await enrol(accounts, id);

    const { ticket } = await accounts.signIn({ email, password: PASSWORD });
    const later = T0 + 31_000; // the next step: the enrolment code is spent
    const done = await accounts.completeMfaSignIn({ ticket, code: totpAt(secret, later) }, { now: later });
    assert.equal(done.ok, true);
    assert.equal(done.account.id, id);
    assert.equal(done.via, 'totp');

    const replay = await accounts.completeMfaSignIn({ ticket, code: totpAt(secret, later) }, { now: later });
    assert.equal(replay.ok, false, 'the same code cannot be used twice');
  });

  test(name('the code that finished enrolment cannot also be used to sign in'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    const { secret } = await enrol(accounts, id);
    const { ticket } = await accounts.signIn({ email, password: PASSWORD });
    const same = await accounts.completeMfaSignIn({ ticket, code: totpAt(secret, T0) }, { now: T0 });
    assert.equal(same.ok, false);
  });

  test(name('a wrong, malformed or missing code does not sign in, and a dead ticket says so'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    await enrol(accounts, id);
    const { ticket } = await accounts.signIn({ email, password: PASSWORD });
    for (const code of ['000000', '', undefined, 'abc', '12345678901']) {
      const r = await accounts.completeMfaSignIn({ ticket, code }, { now: T0 + 31_000 });
      assert.equal(r.ok, false, String(code));
    }
    for (const bad of [undefined, '', 'x.y.z', ticket.slice(0, -2)]) {
      const r = await accounts.completeMfaSignIn({ ticket: bad, code: '123456' });
      assert.deepEqual([r.ok, r.reason], [false, 'expired']);
    }
    const stale = await accounts.completeMfaSignIn({ ticket, code: '123456' }, { now: Date.now() + 10 * 60_000 });
    assert.equal(stale.reason, 'expired');
  });

  test(name('five wrong codes lock the second step for the ACCOUNT, whatever ticket they came on'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    const { secret } = await enrol(accounts, id);
    const now = T0 + 31_000;

    let last;
    for (let i = 0; i < 5; i += 1) {
      const { ticket } = await accounts.signIn({ email, password: PASSWORD }); // a fresh ticket every time
      last = await accounts.completeMfaSignIn({ ticket, code: '000000' }, { now });
    }
    assert.equal(last.reason, 'locked');
    assert.ok(last.retryAfter > 0);

    const { ticket } = await accounts.signIn({ email, password: PASSWORD });
    const locked = await accounts.completeMfaSignIn({ ticket, code: totpAt(secret, now) }, { now });
    assert.equal(locked.reason, 'locked', 'even the RIGHT code is refused while locked');
    assert.ok((await accounts.mfaStatus(id, { now })).lockedUntil);

    const fresh = mfaTicket(accounts, id, now + 16 * 60_000);
    const open = await accounts.completeMfaSignIn({ ticket: fresh, code: totpAt(secret, now + 16 * 60_000) }, { now: now + 16 * 60_000 });
    assert.equal(open.ok, true, 'and the lock lifts after fifteen minutes');
  });

  test(name('simultaneous wrong guesses are all counted'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    await enrol(accounts, id);
    const now = T0 + 31_000;
    const { ticket } = await accounts.signIn({ email, password: PASSWORD });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => accounts.completeMfaSignIn({ ticket, code: '000000' }, { now })),
    );
    assert.equal(results.filter((r) => r.reason === 'locked').length >= 4, true, JSON.stringify(results.map((r) => r.reason)));
    assert.ok((await accounts.mfaStatus(id, { now })).lockedUntil, 'it ended up locked, not at "one failure"');
  });

  test(name('a recovery code signs in exactly once, tells the owner, and is then gone'), async (t) => {
    const { accounts, mailer } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    const { recoveryCodes } = await enrol(accounts, id);
    const now = T0 + 60_000;

    const { ticket } = await accounts.signIn({ email, password: PASSWORD });
    const used = await accounts.completeMfaSignIn({ ticket, code: recoveryCodes[0].toLowerCase() }, { now });
    assert.deepEqual([used.ok, used.via], [true, 'recovery']);
    assert.equal((await accounts.mfaStatus(id, { now })).recoveryRemaining, 9);
    assert.ok(mailer.sent.some((m) => /recovery code was used/.test(m.subject)));

    const again = await accounts.completeMfaSignIn({ ticket, code: recoveryCodes[0] }, { now });
    assert.equal(again.ok, false, 'a spent code is spent');
    const other = await accounts.completeMfaSignIn({ ticket, code: recoveryCodes[1] }, { now });
    assert.equal(other.ok, true, 'the rest still work');
  });

  test(name('the stored record holds no secret, no recovery code, and no way to read either'), async (t) => {
    const { accounts, db } = await build(t, backend);
    const { id } = await signedUp(accounts);
    const { secret, recoveryCodes } = await enrol(accounts, id);

    const record = await accounts.store.getMfa(id);
    const dump = JSON.stringify(record);
    assert.ok(!dump.includes(base32Encode(secret)), 'not the base32 secret');
    assert.ok(!dump.includes(secret.toString('base64url')) && !dump.includes(secret.toString('hex')));
    for (const code of recoveryCodes) assert.ok(!dump.includes(code) && !dump.includes(code.replace('-', '')));
    assert.ok(!JSON.stringify(await accounts.get(id)).includes('sealed'), 'the public view carries none of it');
    if (db) {
      const row = await db.prepare('SELECT data FROM account_mfa WHERE account_id = ?').bind(id).first();
      assert.ok(!row.data.includes(base32Encode(secret)));
    }
  });

  test(name('turning it off needs the password AND a code, and leaves it on if either is missing'), async (t) => {
    const { accounts, mailer } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    const { secret, recoveryCodes } = await enrol(accounts, id);
    const now = T0 + 31_000;

    const noCode = await accounts.disableMfa(id, { currentPassword: PASSWORD, code: '' }, { now });
    assert.equal(noCode.ok, false);
    const noPassword = await accounts.disableMfa(id, { currentPassword: 'nope', code: totpAt(secret, now) }, { now });
    assert.equal(noPassword.ok, false);
    assert.equal((await accounts.mfaStatus(id, { now })).enabled, true, 'refused twice, still on');

    const ok = await accounts.disableMfa(id, { currentPassword: PASSWORD, code: recoveryCodes[2] }, { now });
    assert.equal(ok.ok, true, 'a recovery code is an acceptable second proof');
    assert.equal((await accounts.mfaStatus(id, { now })).enabled, false);
    assert.equal((await accounts.signIn({ email, password: PASSWORD })).ok, true, 'and sign-in needs no code again');
    assert.ok(mailer.sent.some((m) => /OFF/.test(m.subject)));
  });

  test(name('wrong codes while trying to turn it off count towards the same lock'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id } = await signedUp(accounts);
    await enrol(accounts, id);
    const now = T0 + 31_000;
    let last;
    for (let i = 0; i < 5; i += 1) last = await accounts.disableMfa(id, { currentPassword: PASSWORD, code: '000000' }, { now });
    assert.equal(last.reason, 'locked');
    assert.equal((await accounts.mfaStatus(id, { now })).enabled, true);
  });

  test(name('replacing recovery codes needs both proofs, invalidates the old set, and tells the owner'), async (t) => {
    const { accounts, mailer } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    const { secret, recoveryCodes } = await enrol(accounts, id);
    const now = T0 + 31_000;

    assert.equal((await accounts.regenerateRecoveryCodes(id, { currentPassword: PASSWORD, code: '111111' }, { now })).ok, false);
    const fresh = await accounts.regenerateRecoveryCodes(id, { currentPassword: PASSWORD, code: totpAt(secret, now) }, { now });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.recoveryCodes.length, 10);
    assert.ok(fresh.recoveryCodes.every((c) => !recoveryCodes.includes(c)));
    assert.ok(mailer.sent.some((m) => /recovery codes .* replaced/.test(m.subject)));

    const { ticket } = await accounts.signIn({ email, password: PASSWORD });
    const old = await accounts.completeMfaSignIn({ ticket, code: recoveryCodes[0] }, { now: now + 31_000 });
    assert.equal(old.ok, false, 'an old code no longer works');
    const next = await accounts.completeMfaSignIn({ ticket, code: fresh.recoveryCodes[0] }, { now: now + 31_000 });
    assert.equal(next.ok, true);
  });

  test(name('an account that is not enrolled cannot be disabled, regenerated, or checked into'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id } = await signedUp(accounts);
    assert.equal((await accounts.disableMfa(id, { currentPassword: PASSWORD, code: '123456' })).reason, 'not-enabled');
    assert.equal((await accounts.regenerateRecoveryCodes(id, { currentPassword: PASSWORD, code: '123456' })).reason, 'not-enabled');
    const ticket = mfaTicket(accounts, id, Date.now());
    assert.equal((await accounts.completeMfaSignIn({ ticket, code: '123456' })).ok, false, 'a ticket cannot enrol anyone');
  });

  test(name('an account with no password cannot start setup (nothing to prove with)'), async (t) => {
    const { accounts } = await build(t, backend);
    const made = await accounts.withProviderIdentity({
      provider: 'google', subject: 'g-1', email: 'gee@example.com', emailVerified: true, displayName: 'Gee',
    });
    const r = await accounts.beginMfaEnrollment(made.account.id, { currentPassword: PASSWORD });
    assert.deepEqual([r.ok, r.reason], [false, 'no-password']);
  });

  test(name('deleting the account removes the two-step record'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id } = await signedUp(accounts);
    await enrol(accounts, id);
    const gone = await accounts.deleteAccount(id, { currentPassword: PASSWORD, confirmEmail: 'ann@example.com' });
    assert.equal(gone.ok, true);
    assert.equal(await accounts.store.getMfa(id), null);
  });

  test(name('the same recovery code redeemed by simultaneous requests works exactly once'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    const { recoveryCodes } = await enrol(accounts, id);
    const { ticket } = await accounts.signIn({ email, password: PASSWORD });
    const now = T0 + 60_000;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => accounts.completeMfaSignIn({ ticket, code: recoveryCodes[0] }, { now })),
    );
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => r.ok)));
    assert.equal((await accounts.mfaStatus(id, { now })).recoveryRemaining, 9);
  });

  test(name('a Google sign-in into an enrolled account needs the second step too'), async (t) => {
    const { accounts } = await build(t, backend);
    const { id, email } = await signedUp(accounts);
    const identity = { provider: 'google', subject: 'g-42', email, emailVerified: true, displayName: 'Ann' };
    assert.equal((await accounts.withProviderIdentity(identity, { currentAccountId: id })).outcome, 'linked');
    assert.equal((await accounts.withProviderIdentity(identity)).ok, true, 'without two-step, Google alone signs in');

    const { secret } = await enrol(accounts, id);
    const viaGoogle = await accounts.withProviderIdentity(identity);
    assert.equal(viaGoogle.ok, false);
    assert.equal(viaGoogle.reason, 'mfa-required');
    assert.equal(viaGoogle.account, undefined);

    const now = T0 + 31_000;
    const done = await accounts.completeMfaSignIn({ ticket: viaGoogle.ticket, code: totpAt(secret, now) }, { now });
    assert.equal(done.ok, true);
    assert.equal(done.account.id, id);
  });

  test(name('two accounts keep separate secrets and separate locks'), async (t) => {
    const { accounts } = await build(t, backend);
    const a = await signedUp(accounts, 'a@example.com');
    const b = await signedUp(accounts, 'b@example.com');
    const ea = await enrol(accounts, a.id);
    const eb = await enrol(accounts, b.id);
    assert.notDeepEqual(ea.secret, eb.secret);

    const now = T0 + 31_000;
    const { ticket } = await accounts.signIn({ email: 'b@example.com', password: PASSWORD });
    const crossed = await accounts.completeMfaSignIn({ ticket, code: totpAt(ea.secret, now) }, { now });
    assert.equal(crossed.ok, false, "A's code does not open B");
    assert.equal((await accounts.mfaStatus(a.id, { now })).lockedUntil, null, "and B's failures are not A's");
  });
}

/** A genuine ticket for an account, as `signIn` would have issued after a correct password. */
const mfaTicket = (accounts, id, now) => accounts.mfa.issueTicket(id, { now });
