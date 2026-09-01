/**
 * A Durable Object namespace over ordinary objects in this process, for tests and local runs.
 *
 * WHAT IT DOES AND DOES NOT PROVE, stated plainly because this is the weakest of the three
 * local drivers. sqliteD1.mjs runs the engine D1 is built on, so SQL proven against it is
 * proven. This one is a stand-in: it gives each name its own storage and its own instance, and
 * it runs the SAME window logic the real object runs, so the arithmetic, the return shape, the
 * key namespacing and the clear-on-success path are all genuinely exercised. What it cannot
 * show is anything about the platform — input gates, eviction, hibernation, alarms actually
 * firing, or that RPC method calls reach the object at all. `wrangler dev` settles those, and
 * the integration tests against it are not optional because of that.
 *
 * The storage it hands out implements the four operations rateLimitWindow.mjs uses, and no
 * more: `get`, `put`, `deleteAll`, `setAlarm`, plus `deleteAlarm`.
 */
import { clearWindow, hitWindow } from './rateLimitWindow.mjs';

/** One object's storage, with an alarm that actually fires so expiry can be tested. */
function createStorage({ onAlarm }) {
  const values = new Map();
  let alarm = null;

  return {
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
    async deleteAll() {
      values.clear();
    },
    async setAlarm(at) {
      if (alarm) clearTimeout(alarm);
      const delay = Math.max(0, at - Date.now());
      alarm = setTimeout(() => {
        alarm = null;
        onAlarm();
      }, delay);
      /* Node keeps the process alive for a pending timer; a rate-limit window an hour long
         would hold a test run open for an hour. The real platform has no such problem. */
      alarm.unref?.();
    },
    async deleteAlarm() {
      if (alarm) clearTimeout(alarm);
      alarm = null;
    },
    /** Test-only: run the alarm now instead of waiting for the window to end. */
    async runAlarm() {
      if (alarm) clearTimeout(alarm);
      alarm = null;
      onAlarm();
    },
  };
}

/**
 * A namespace exposing the parts of the Durable Object API this codebase uses:
 * `idFromName(name)` and `get(id)`, with the returned stub carrying the object's RPC methods.
 */
export function createLocalDurableObjects() {
  const instances = new Map();

  const instanceFor = (name) => {
    let instance = instances.get(name);
    if (instance) return instance;

    const storage = createStorage({ onAlarm: () => storage.deleteAll() });

    /**
     * The input gate, modelled.
     *
     * A Durable Object does not deliver a new event while a storage operation is in flight, so
     * `hitWindow`'s read-decide-write is atomic there without a lock. Nothing in this process
     * provides that for free, and without it the stub is not merely less faithful — it is
     * WRONG in the one direction that matters: ten concurrent hits against a maximum of four
     * would all be allowed and the count would finish at one, and the contract's burst test
     * would pass or fail on the timing of a hash rather than on the limiter being correct.
     */
    let gate = Promise.resolve();
    const gated = (work) => {
      const result = gate.then(work, work);
      gate = result.then(
        () => {},
        () => {},
      );
      return result;
    };

    instance = {
      name,
      storage,
      hit: (windowMs, max) => gated(() => hitWindow(storage, { windowMs, max })),
      clear: () => gated(() => clearWindow(storage)),
    };
    instances.set(name, instance);
    return instance;
  };

  return {
    /* A name IS the id here. The real implementation hashes it into a 64-hex id; nothing in
       this codebase looks at an id's value, only passes it straight back to `get`. */
    idFromName(name) {
      return { name, toString: () => name };
    },

    get(id) {
      return instanceFor(id.name);
    },

    /** Test-only: how many objects exist, to show that keys really are kept apart. */
    get size() {
      return instances.size;
    },

    /** Test-only: reach an instance by name to force its alarm. */
    peek(name) {
      return instances.get(name);
    },
  };
}
