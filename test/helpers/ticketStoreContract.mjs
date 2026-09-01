/**
 * The ticket store contract — one suite, run against every implementation of the seam.
 *
 * server/store/fileStore.mjs says at the top that swapping in a database means "writing a
 * module with the same six methods". This file is what makes that claim checkable instead of
 * aspirational: it is the definition of what those six methods mean, and both the JSON store
 * and the D1 store are held to it, character for character, by the same assertions.
 *
 * A test that belongs here answers "what must ANY ticket store do?". A test about temp files
 * or SQL belongs in that implementation's own file.
 *
 * The documents below are realistic ones — the shape core/tickets.mjs actually writes. That
 * matters, because the JSON store is schemaless and the D1 store is not: a contract exercised
 * with `{ id, status }` would pass everywhere and prove nothing about the shape that ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let counter = 0;

/** A complete ticket document, matching the shape documented in core/tickets.mjs. */
export function aTicket(overrides = {}) {
  counter += 1;
  const at = overrides.createdAt ?? `2026-01-${String((counter % 28) + 1).padStart(2, '0')}T00:00:00.000Z`;
  return {
    id: overrides.id ?? `NH-TEST-${String(counter).padStart(4, '0')}`,
    schemaVersion: 2,
    createdAt: at,
    updatedAt: at,
    project: 'open-cut',
    category: 'export',
    issueType: 'export-fails',
    subject: 'Export stops at 40%',
    description: 'It gets to about 40% and then the app stops responding.',
    priority: 'normal',
    status: 'open',
    requester: { name: 'Ann', email: 'ann@example.com' },
    accountId: null,
    environment: { platform: 'windows', appVersion: '1.0.0' },
    attachments: [],
    assignee: null,
    tags: [],
    routing: { humanOnly: false, reason: null },
    source: { channel: 'web', ip: '203.0.113.7' },
    events: [
      {
        id: `evt_${counter}_0`,
        at,
        type: 'created',
        actor: { kind: 'user', name: 'Ann' },
        visibility: 'public',
        body: 'It gets to about 40% and then the app stops responding.',
        meta: { attachments: [] },
      },
    ],
    ...overrides,
  };
}

const anEvent = (overrides = {}) => ({
  id: `evt_${Math.random().toString(36).slice(2, 10)}`,
  at: '2026-02-01T12:00:00.000Z',
  type: 'reply',
  actor: { kind: 'user', name: 'Ann' },
  visibility: 'public',
  body: 'Any news?',
  meta: null,
  ...overrides,
});

/**
 * Register the contract against one implementation.
 *
 * `makeStore(t)` returns an initialised store bound to throwaway storage, and registers its
 * own cleanup on `t`.
 */
export function describeTicketStore(label, makeStore) {
  const name = (what) => `[${label}] ${what}`;

  /* ── Creating and reading ────────────────────────────────────────────────────────────── */

  test(name('a created ticket comes back exactly as it was stored'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    assert.deepEqual(await store.get(ticket.id), ticket);
  });

  test(name('a ticket that does not exist reads as null, not as a throw'), async (t) => {
    const store = await makeStore(t);
    assert.equal(await store.get('NH-NOPE-0000'), null);
  });

  test(name('has() answers for both a stored and an unknown id'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    assert.equal(await store.has(ticket.id), true);
    assert.equal(await store.has('NH-NOPE-0000'), false);
  });

  test(name('creating over an existing id is refused, and leaves the original alone'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    await assert.rejects(() => store.create(aTicket({ id: ticket.id, subject: 'Different' })));
    assert.equal((await store.get(ticket.id)).subject, ticket.subject);
  });

  test(name('what get() returns cannot be mutated back into the store'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    const first = await store.get(ticket.id);
    first.subject = 'Tampered';
    first.events.push(anEvent());
    first.tags.push('injected');

    const second = await store.get(ticket.id);
    assert.equal(second.subject, ticket.subject);
    assert.equal(second.events.length, 1);
    assert.deepEqual(second.tags, []);
  });

  test(name('every documented field survives a round trip, including the awkward ones'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket({
      accountId: 'acct_7Q2W',
      assignee: 'staff:jo',
      tags: ['vip', 'regression'],
      requester: { name: null, email: 'no-name@example.com' },
      environment: { platform: null, appVersion: null },
      routing: { humanOnly: true, reason: 'account-security' },
      source: { channel: 'assistant', ip: null },
      attachments: [
        { id: 'att_1', filename: 'log.txt', declaredType: 'text/plain', size: 40, uploadedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'att_2', filename: 'shot.png', declaredType: null, size: 900, uploadedAt: '2026-01-01T00:00:01.000Z' },
      ],
    });
    await store.create(ticket);

    assert.deepEqual(await store.get(ticket.id), ticket);
  });

  /* ── Updating ────────────────────────────────────────────────────────────────────────── */

  test(name('update applies the mutation and returns the new document'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    const event = anEvent();
    const returned = await store.update(ticket.id, (doc) => {
      doc.events.push(event);
      doc.status = 'in_progress';
      doc.updatedAt = '2026-02-01T12:00:00.000Z';
      return doc;
    });

    assert.equal(returned.status, 'in_progress');
    assert.equal(returned.events.length, 2);
    assert.deepEqual(returned.events[1], event);
    assert.deepEqual(await store.get(ticket.id), returned);
  });

  test(name('a mutator returning nothing aborts the update and changes nothing'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    const returned = await store.update(ticket.id, (doc) => {
      doc.status = 'closed';
      doc.events.push(anEvent());
      return null;
    });

    assert.equal(returned, null);
    assert.deepEqual(await store.get(ticket.id), ticket);
  });

  test(name('updating a ticket that does not exist is null, not a throw'), async (t) => {
    const store = await makeStore(t);
    let ran = false;
    const returned = await store.update('NH-NOPE-0000', (doc) => {
      ran = true;
      return doc;
    });
    assert.equal(returned, null);
    assert.equal(ran, false, 'the mutator is not run for a ticket that is not there');
  });

  test(name('the mutator receives a copy, so abandoning it leaves no trace'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    await store.update(ticket.id, (doc) => {
      doc.subject = 'Half-written';
      return null;
    });
    await store.update(ticket.id, (doc) => {
      assert.equal(doc.subject, ticket.subject, 'the abandoned edit is not visible');
      return doc;
    });
  });

  test(name('an update survives being read back through a fresh handle'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);
    await store.update(ticket.id, (doc) => {
      doc.events.push(anEvent({ body: 'persisted?' }));
      return doc;
    });

    const reopened = await store.reopen?.();
    if (!reopened) return; // an implementation with no separate handle has nothing to prove
    const found = await reopened.get(ticket.id);
    assert.equal(found.events.length, 2);
    assert.equal(found.events[1].body, 'persisted?');
  });

  /* ── Events are append-only ──────────────────────────────────────────────────────────── */

  test(name('appended events keep their order and their full shape'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    for (let i = 0; i < 5; i += 1) {
      await store.update(ticket.id, (doc) => {
        doc.events.push(
          anEvent({
            id: `evt_ordered_${i}`,
            body: `reply ${i}`,
            visibility: i % 2 ? 'internal' : 'public',
            actor: { kind: i % 2 ? 'staff' : 'user', name: i % 2 ? 'Jo' : null },
            meta: i === 3 ? { from: 'open', to: 'resolved' } : null,
          }),
        );
        return doc;
      });
    }

    const final = await store.get(ticket.id);
    assert.equal(final.events.length, 6);
    assert.deepEqual(
      final.events.slice(1).map((e) => e.id),
      ['evt_ordered_0', 'evt_ordered_1', 'evt_ordered_2', 'evt_ordered_3', 'evt_ordered_4'],
    );
    assert.deepEqual(final.events[4].meta, { from: 'open', to: 'resolved' });
    assert.equal(final.events[2].visibility, 'internal');
    assert.equal(final.events[2].actor.kind, 'staff');
  });

  /* ── Listing ─────────────────────────────────────────────────────────────────────────── */

  const seedForListing = async (store) => {
    await store.create(
      aTicket({ id: 'NH-LIST-0001', createdAt: '2026-03-01T00:00:00.000Z', status: 'open', project: 'open-cut' }),
    );
    await store.create(
      aTicket({
        id: 'NH-LIST-0002',
        createdAt: '2026-03-02T00:00:00.000Z',
        status: 'resolved',
        project: 'atlas',
        accountId: 'acct_AAA',
        requester: { name: 'Bo', email: 'bo@example.com' },
      }),
    );
    await store.create(
      aTicket({
        id: 'NH-LIST-0003',
        createdAt: '2026-03-03T00:00:00.000Z',
        status: 'open',
        project: 'atlas',
        accountId: 'acct_AAA',
        requester: { name: 'Bo', email: 'BO@Example.COM ' },
      }),
    );
  };

  test(name('an unfiltered list is newest first and reports the true total'), async (t) => {
    const store = await makeStore(t);
    await seedForListing(store);

    const { total, tickets } = await store.list();
    assert.equal(total, 3);
    assert.deepEqual(
      tickets.map((ticket) => ticket.id),
      ['NH-LIST-0003', 'NH-LIST-0002', 'NH-LIST-0001'],
    );
  });

  test(name('filters match exactly, and combine'), async (t) => {
    const store = await makeStore(t);
    await seedForListing(store);

    assert.deepEqual((await store.list({ status: 'open' })).tickets.map((x) => x.id), [
      'NH-LIST-0003',
      'NH-LIST-0001',
    ]);
    assert.deepEqual((await store.list({ project: 'atlas' })).tickets.map((x) => x.id), [
      'NH-LIST-0003',
      'NH-LIST-0002',
    ]);
    assert.deepEqual((await store.list({ project: 'atlas', status: 'open' })).tickets.map((x) => x.id), [
      'NH-LIST-0003',
    ]);
    assert.equal((await store.list({ project: 'nothing-here' })).total, 0);
  });

  test(name('an account id matches only itself, and never a guest ticket'), async (t) => {
    const store = await makeStore(t);
    await seedForListing(store);

    assert.deepEqual((await store.list({ accountId: 'acct_AAA' })).tickets.map((x) => x.id), [
      'NH-LIST-0003',
      'NH-LIST-0002',
    ]);
    assert.equal((await store.list({ accountId: 'acct_OTHER' })).total, 0);
    /* The rule the whole access model rests on: a guest ticket has no account and can never be
       matched into one. See docs/NOVA-ACCOUNTS.md. */
    assert.equal(
      (await store.list({ accountId: 'acct_AAA' })).tickets.some((x) => x.id === 'NH-LIST-0001'),
      false,
    );
  });

  test(name('an address matches regardless of case or surrounding space'), async (t) => {
    const store = await makeStore(t);
    await seedForListing(store);

    const found = await store.list({ email: '  Bo@EXAMPLE.com ' });
    assert.equal(found.total, 2);
    assert.deepEqual(found.tickets.map((x) => x.id), ['NH-LIST-0003', 'NH-LIST-0002']);
    assert.equal((await store.list({ email: 'nobody@example.com' })).total, 0);
  });

  test(name('limit and offset page through a stable order without skipping or repeating'), async (t) => {
    const store = await makeStore(t);
    await seedForListing(store);

    const first = await store.list({ limit: 2, offset: 0 });
    const second = await store.list({ limit: 2, offset: 2 });

    assert.equal(first.total, 3, 'total is the size of the match, not of the page');
    assert.equal(second.total, 3);
    assert.deepEqual(first.tickets.map((x) => x.id), ['NH-LIST-0003', 'NH-LIST-0002']);
    assert.deepEqual(second.tickets.map((x) => x.id), ['NH-LIST-0001']);
  });

  test(name('tickets created in the same instant still page deterministically'), async (t) => {
    const store = await makeStore(t);
    const at = '2026-04-01T00:00:00.000Z';
    for (const id of ['NH-TIE-0001', 'NH-TIE-0002', 'NH-TIE-0003']) {
      await store.create(aTicket({ id, createdAt: at }));
    }

    const pageOne = await store.list({ limit: 2, offset: 0 });
    const pageTwo = await store.list({ limit: 2, offset: 2 });
    const seen = [...pageOne.tickets, ...pageTwo.tickets].map((x) => x.id);

    assert.equal(new Set(seen).size, 3, 'three distinct tickets across two pages');
    assert.deepEqual(seen, (await store.list()).tickets.map((x) => x.id), 'paging matches the whole list');
  });

  test(name('a listed ticket is a full document, and a copy'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    const { tickets } = await store.list();
    assert.deepEqual(tickets[0], ticket);

    tickets[0].subject = 'Tampered';
    assert.equal((await store.get(ticket.id)).subject, ticket.subject);
  });

  /* ── Counting ────────────────────────────────────────────────────────────────────────── */

  test(name('counts are derived from what is stored, by status'), async (t) => {
    const store = await makeStore(t);
    assert.deepEqual(await store.counts(), { total: 0, byStatus: {} });

    await seedForListing(store);
    assert.deepEqual(await store.counts(), { total: 3, byStatus: { open: 2, resolved: 1 } });

    await store.update('NH-LIST-0001', (doc) => {
      doc.status = 'closed';
      return doc;
    });
    assert.deepEqual(await store.counts(), { total: 3, byStatus: { open: 1, resolved: 1, closed: 1 } });
  });

  /* ── Concurrency ─────────────────────────────────────────────────────────────────────── */

  test(name('concurrent replies to one ticket all land'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.update(ticket.id, (doc) => {
          doc.events.push(anEvent({ id: `evt_race_${i}`, body: `reply ${i}` }));
          doc.updatedAt = new Date().toISOString();
          return doc;
        }),
      ),
    );

    const final = await store.get(ticket.id);
    assert.equal(final.events.length, 13, 'no reply was lost');
    assert.equal(new Set(final.events.map((e) => e.id)).size, 13, 'and none was duplicated');
  });

  test(name('a guarded transition decided under concurrency is decided against fresh state'), async (t) => {
    const store = await makeStore(t);
    const ticket = aTicket();
    await store.create(ticket);

    /* Two members of staff move the same open ticket at once. Whichever runs second must see
       the first one's status, not the one it read before queuing — otherwise it validates its
       transition against a state that no longer exists and writes an impossible history. */
    const attempt = (to) =>
      store.update(ticket.id, (doc) => {
        if (doc.status !== 'open') return null;
        doc.events.push(anEvent({ type: 'status_changed', meta: { from: doc.status, to } }));
        doc.status = to;
        return doc;
      });

    const results = await Promise.all([attempt('resolved'), attempt('closed')]);
    assert.equal(results.filter(Boolean).length, 1, 'exactly one transition was allowed');

    const final = await store.get(ticket.id);
    assert.equal(final.events.length, 2);
    assert.equal(final.events[1].meta.from, 'open');
    assert.equal(final.events[1].meta.to, final.status);
  });

  test(name('concurrent creates of different tickets all survive'), async (t) => {
    const store = await makeStore(t);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.create(aTicket({ id: `NH-PAR-${i}` }))));

    assert.equal((await store.counts()).total, 10);
    assert.equal((await store.list({ limit: 100 })).tickets.length, 10);
  });

  test(name('updates to different tickets do not block or corrupt each other'), async (t) => {
    const store = await makeStore(t);
    for (let i = 0; i < 6; i += 1) await store.create(aTicket({ id: `NH-IND-${i}` }));

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.update(`NH-IND-${i}`, (doc) => {
          doc.events.push(anEvent({ id: `evt_ind_${i}` }));
          doc.subject = `Subject ${i}`;
          return doc;
        }),
      ),
    );

    for (let i = 0; i < 6; i += 1) {
      const found = await store.get(`NH-IND-${i}`);
      assert.equal(found.subject, `Subject ${i}`);
      assert.equal(found.events.at(-1).id, `evt_ind_${i}`);
    }
  });
}
