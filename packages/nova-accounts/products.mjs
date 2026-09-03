/**
 * The Nova product registry — who may ask for an account, and for what.
 *
 * WHY THIS FILE EXISTS. Until now "which product is this" was a free-form string: whatever the
 * caller passed as `product` got written onto a session and into `account.products`. That is
 * fine while the only callers are two front doors in this repository. It stops being fine the
 * moment a *desktop* product asks for a token over the network, because then the product name
 * arrives from outside and decides what the token opens. An unregistered name must be refused
 * rather than recorded, and the scopes a product may ask for must be a fact written down here
 * rather than a parameter the asker supplies.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * SCOPES ARE THE ANSWER TO "each product should only see what it needs".
 *
 * A Nova.Help session sees an address because it files tickets to it. Open Cut does not need
 * one to put a name in the corner of a title bar, and Replay.GG does not need one at all.
 * So a product token carries scopes, `resolveProductToken` returns a view narrowed to them,
 * and a product that never asks for `email` cannot be handed one by a later refactor.
 *
 *   identity   who you are: account id and display name. Always granted; a token that
 *              cannot say whose it is has no use.
 *   email      the address on the account.
 *   support    file and read Nova.Help tickets as this account.
 *   sync       read and write THIS PRODUCT'S sync document. Never another product's; the
 *              bucket is keyed on the product the token was issued to, so the scope cannot
 *              be widened by asking nicely.
 *
 * `identity` is not listed on a product below because it is implied. Everything else is
 * opt-in per product, and the list is deliberately short — a scope nobody has a use for is a
 * scope that gets granted by habit.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ADDING A PRODUCT IS ONE ENTRY. That is the whole point: the ecosystem seam that
 * `account.products` has carried since day one is now enforceable, and a new Nova product is
 * a row here plus whatever UI it wants — no change to the service, the store or the schema.
 *
 * `kind` is not decoration. `web` products sign in with a cookie at their own origin; `device`
 * products cannot hold a cookie or a client secret and use the device grant instead. A product
 * that is not `device` is refused by `startDeviceAuthorization`, so a browser page cannot walk
 * itself through a flow designed for a television.
 */

/** Every scope that exists. A product may not request one that is not in here. */
export const SCOPES = Object.freeze(['identity', 'email', 'support', 'sync']);

/** Granted to every token, because a token that cannot name its owner is not an identity. */
export const IMPLIED_SCOPES = Object.freeze(['identity']);

const define = ({ scopes = [], kind = 'web', ...rest }) =>
  Object.freeze({
    ...rest,
    kind,
    scopes: Object.freeze([...new Set([...IMPLIED_SCOPES, ...scopes])]),
  });

/**
 * The Nova ecosystem, as far as identity is concerned.
 *
 * The ids match the `product` strings already written onto sessions and `account.products`
 * (`nova`, `nova.help`), so nothing on disk has to be rewritten for this registry to become
 * the authority on them.
 */
export const PRODUCTS = Object.freeze({
  nova: define({
    id: 'nova',
    name: 'Nova',
    kind: 'web',
    scopes: ['email'],
    summary: 'The Nova site — the front door to the ecosystem.',
  }),

  'nova.help': define({
    id: 'nova.help',
    name: 'Nova.Help',
    kind: 'web',
    scopes: ['email', 'support'],
    summary: 'Support for every Nova product.',
  }),

  'open-cut': define({
    id: 'open-cut',
    name: 'Open Cut',
    kind: 'device',
    scopes: ['support', 'sync'],
    summary: 'The video and photo editor.',
  }),

  'online-earth': define({
    id: 'online-earth',
    name: 'Online Earth',
    kind: 'device',
    scopes: ['support', 'sync'],
    summary: 'The spatial platform.',
  }),

  'replay-gg': define({
    id: 'replay-gg',
    name: 'Replay.GG',
    kind: 'device',
    scopes: ['support'],
    summary: 'Gameplay capture and clipping.',
  }),

  atlas: define({
    id: 'atlas',
    name: 'Atlas',
    kind: 'device',
    scopes: ['support', 'sync'],
    summary: 'The desktop assistant.',
  }),
});

/** A product by id, or null. Never throws — the id usually came from a request. */
export const getProduct = (id) =>
  Object.prototype.hasOwnProperty.call(PRODUCTS, String(id ?? '')) ? PRODUCTS[String(id)] : null;

/** True when this id names a registered Nova product. */
export const isProduct = (id) => getProduct(id) !== null;

/**
 * Narrow a requested scope list to what this product is actually allowed.
 *
 * INTERSECTION, NOT VALIDATION. An asker that requests `email` when it may not have it gets a
 * token without `email` rather than an error, because the alternative — refusing the whole
 * sign-in — turns a scope list the product's author got slightly wrong into a product nobody
 * can sign in to. What it can never do is come back with more than the registry allows.
 */
export function grantableScopes(productId, requested) {
  const product = getProduct(productId);
  if (!product) return [];
  const allowed = new Set(product.scopes);
  const asked = Array.isArray(requested) ? requested : String(requested ?? '').split(/[\s,]+/);
  const granted = asked.map((s) => String(s).trim()).filter((s) => allowed.has(s));
  return [...new Set([...IMPLIED_SCOPES, ...granted])];
}
