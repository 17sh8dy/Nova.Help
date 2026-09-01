/**
 * Applying the SQL schemas to a D1 database.
 *
 * Wrangler has its own migrations system and that is what a deployment should use; this exists
 * for the two cases wrangler cannot serve: the test suite, which stands up a fresh database
 * per test against the local driver, and a local run against SQLite where there is no wrangler
 * in the loop at all. Both schemas are `CREATE TABLE IF NOT EXISTS`, so applying them to a
 * database that already has them is a no-op rather than an error.
 *
 * The account schema is deliberately reachable from here too, but it LIVES under
 * server/accounts/ and is only read from there. Nothing in this file may be imported by
 * anything under server/accounts/ -- see the rule at the top of accounts/index.mjs.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const read = (file) => readFile(file, 'utf8');

/** The tickets, events and attachments tables. */
export async function applyTicketSchema(db) {
  await db.exec(await read(path.join(here, 'schema.sql')));
}

/** The accounts, sessions and identities tables. */
export async function applyAccountSchema(db) {
  await db.exec(await read(path.join(repoRoot, 'server', 'accounts', 'schema.sql')));
}

/** Everything Nova.Help needs in one database. */
export async function applySchema(db) {
  await applyTicketSchema(db);
  await applyAccountSchema(db);
}
