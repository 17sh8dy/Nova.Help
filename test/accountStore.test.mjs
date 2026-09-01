/**
 * Every account store, held to the same contract.
 *
 * The contract is in helpers/accountStoreContract.mjs. This file says which implementations
 * exist and stands each one up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAccountStore } from '@nova/accounts/store';
import { createD1AccountStore } from '@nova/accounts/d1Store';
import { createSqliteD1 } from '../server/store/sqliteD1.mjs';
import { applyAccountSchema } from '../server/store/migrate.mjs';
import { anAccount, anIdentity, describeAccountStore } from './helpers/accountStoreContract.mjs';

describeAccountStore('fileStore', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novaacct-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createAccountStore({ dir });
  await store.init();
  return store;
});

describeAccountStore('d1Store', async (t) => {
  const db = createSqliteD1();
  t.after(() => db.close());
  await applyAccountSchema(db);
  const store = createD1AccountStore({ db });
  await store.init();
  return store;
});

/* ── Behaviour specific to D1 ───────────────────────────────────────────────────────────── */

async function d1(t) {
  const db = createSqliteD1();
  t.after(() => db.close());
  await applyAccountSchema(db);
  const store = createD1AccountStore({ db });
  await store.init();
  return { db, store };
}

const version = (db, id) =>
  db.prepare('SELECT version FROM accounts WHERE id = ?').bind(id).first('version');

test('[d1Store] opening a session does not bump the version, so sign-ins never contend', async (t) => {
  const { db, store } = await d1(t);
  await store.create(anAccount({ id: 'acct_a' }));
  assert.equal(await version(db, 'acct_a'), 1);

  await store.update('acct_a', (doc) => {
    doc.sessions = [{ id: 'sess_1', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', product: 'nova.help' }];
    doc.updatedAt = '2026-01-02T00:00:00.000Z';
    return doc;
  });
  assert.equal(await version(db, 'acct_a'), 1, 'a session is a fact');

  await store.update('acct_a', (doc) => {
    doc.password = 'scrypt$N=2048,r=8,p=1$c2FsdA$bmV3';
    return doc;
  });
  assert.equal(await version(db, 'acct_a'), 2, 'a password change is a decision');
});

test('[d1Store] a decision made against a stale version is retried against fresh state', async (t) => {
  const { db, store } = await d1(t);
  await store.create(anAccount({ id: 'acct_a' }));

  let attempts = 0;
  const seen = [];
  await store.update('acct_a', (doc) => {
    attempts += 1;
    seen.push(doc.status);
    if (attempts === 1) {
      return (async () => {
        await db
          .prepare('UPDATE accounts SET status = ?, version = version + 1 WHERE id = ?')
          .bind('disabled', 'acct_a')
          .run();
        doc.displayName = 'Renamed';
        return doc;
      })();
    }
    doc.displayName = 'Renamed';
    return doc;
  });

  assert.equal(attempts, 2);
  assert.deepEqual(seen, ['active', 'disabled'], 'the second attempt saw the committed state');
  const final = await store.get('acct_a');
  assert.equal(final.displayName, 'Renamed');
  assert.equal(final.status, 'disabled', 'and did not undo what it lost to');
});

test('[d1Store] signing out everywhere kills a session opened while it was deciding', async (t) => {
  const { db, store } = await d1(t);
  await store.create(anAccount({ id: 'acct_a' }));

  /* The security-relevant one. A targeted diff would spare the session that appeared after
     this mutator read the account — exactly the session "that wasn't me" is aimed at. */
  await store.update('acct_a', (doc) => {
    doc.sessions = [];
    return (async () => {
      await db
        .prepare('INSERT INTO account_sessions (account_id, id, created_at, expires_at, product) VALUES (?,?,?,?,?)')
        .bind('acct_a', 'snuck_in', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'nova.help')
        .run();
      return doc;
    })();
  });

  assert.deepEqual((await store.get('acct_a')).sessions, [], 'everywhere means everywhere');
});

test('[d1Store] update refuses to claim or drop an identity behind the index', async (t) => {
  const { store } = await d1(t);
  await store.create(anAccount({ id: 'acct_a' }));
  await store.claimIdentity('acct_a', anIdentity());

  await assert.rejects(
    () =>
      store.update('acct_a', (doc) => {
        doc.identities = [...doc.identities, anIdentity({ provider: 'apple', subject: 'apple-1' })];
        return doc;
      }),
    /use claimIdentity/,
  );

  await assert.rejects(
    () =>
      store.update('acct_a', (doc) => {
        doc.identities = [];
        return doc;
      }),
    /use releaseIdentity/,
  );
});

test('[d1Store] update may refresh what an identity says about itself', async (t) => {
  const { store } = await d1(t);
  await store.create(anAccount({ id: 'acct_a' }));
  await store.claimIdentity('acct_a', anIdentity());

  await store.update('acct_a', (doc) => {
    doc.identities = doc.identities.map((i) => ({ ...i, email: 'moved@example.com', lastUsedAt: '2026-06-01T00:00:00.000Z' }));
    return doc;
  });

  const [identity] = (await store.get('acct_a')).identities;
  assert.equal(identity.email, 'moved@example.com');
  assert.equal(identity.lastUsedAt, '2026-06-01T00:00:00.000Z');
  assert.equal(identity.subject, '11223344', 'and the identity itself is unchanged');
});

test('[d1Store] moving an address onto one that is taken fails rather than reporting success', async (t) => {
  const { store } = await d1(t);
  await store.create(anAccount({ id: 'acct_a', email: 'a@example.com' }));
  await store.create(anAccount({ id: 'acct_b', email: 'b@example.com' }));

  await assert.rejects(
    () =>
      store.update('acct_a', (doc) => {
        doc.email = 'b@example.com';
        return doc;
      }),
    /email-taken/,
  );
  assert.equal((await store.get('acct_a')).email, 'a@example.com');
});

test('[d1Store] deleting an account takes its sessions, identities and products with it', async (t) => {
  const { db, store } = await d1(t);
  await store.create(
    anAccount({
      id: 'acct_a',
      sessions: [{ id: 's1', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', product: 'nova.help' }],
    }),
  );
  await store.claimIdentity('acct_a', anIdentity());

  await db.prepare('DELETE FROM accounts WHERE id = ?').bind('acct_a').run();

  for (const table of ['account_sessions', 'account_identities', 'account_products']) {
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).bind('acct_a').first('n');
    assert.equal(left, 0, `${table} was cascaded`);
  }
});

test('[package] @nova/accounts depends on nothing but the Node runtime', async () => {
  /* THE RULE THAT MAKES THIS PACKAGE SHARED RATHER THAN COPIED. Nova Accounts is now consumed
     by two front doors — Nova.Help and the Nova site — so "it must not reach outside itself"
     stopped being a convention about a directory and became the thing that lets one
     implementation serve both. A relative import escaping the package would break the Nova
     site's build; a bare dependency would have to be installed by every consumer.

     So this checks both: no relative import may leave the package, and the only bare
     specifiers allowed are node: builtins. */
  const { readFile, readdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(fileURLToPath(import.meta.resolve('@nova/accounts')));

  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith('.mjs')) out.push(full);
    }
    return out;
  };

  const files = await walk(root);
  assert.ok(files.length >= 10, `expected the package to have been found, saw ${files.length} files`);

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [, specifier] of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const where = path.relative(root, file);

      if (specifier.startsWith('.')) {
        const escapes = !path.resolve(path.dirname(file), specifier).startsWith(root);
        assert.equal(escapes, false, `${where} imports "${specifier}" from outside the package`);
        continue;
      }

      assert.ok(
        specifier.startsWith('node:'),
        `${where} imports "${specifier}" — @nova/accounts must have no dependencies, so every ` +
          'consumer can take it as it is. See the rule at the top of its index.mjs.',
      );
    }
  }
});
