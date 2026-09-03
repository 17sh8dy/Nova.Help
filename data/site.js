/**
 * Site-wide configuration.
 *
 * Anything a deployment needs to change — the origin, the support hours, whether a channel is
 * actually staffed — lives here rather than in page copy, so a claim can never outlive the
 * fact behind it. A `null` contact renders as "not available" instead of a dead link.
 */
export const site = {
  name: 'Nova.Help',
  shortName: 'Nova.Help',
  tagline: 'Support for the Nova ecosystem',
  description:
    'The support portal for Nova products — Online Earth, Atlas, Open Cut, Nova Engine and Replay.GG. Find an answer or open a ticket with a person.',
  origin: 'https://nova.help',

  /** Shown on the ticket confirmation. Keep honest: this is a target, not a guarantee. */
  responseTarget: 'We aim to reply within 2 business days.',

  /**
   * A staffed address, for business enquiries and anything the portal could not resolve.
   * `null` hides the block that shows it rather than printing a dead link.
   */
  contactEmail: 'getnovasupport@gmail.com',

  /**
   * Where the rest of the ecosystem lives. `null` hides the link entirely.
   *
   * ⚠ THE PRODUCT DIRECTORY IS NOT HERE — it is `data/ecosystem.js`, which is the one file to
   * edit when a Nova product's site goes live. This block is only for site-wide destinations
   * that are not products. `nova` was `https://nova.example`, which is not a real address;
   * it is `null` until there is one, so nothing renders a link nobody can follow.
   */
  links: {
    nova: null,
    status: null,
  },
};

/** Primary navigation. */
export const nav = [
  { href: '/', label: 'Get help' },
  { href: '/tickets', label: 'Check a ticket' },
];

export const footerLinks = [
  { href: '/', label: 'Get help' },
  { href: '/tickets', label: 'Check a ticket' },
  { href: '/account', label: 'Nova Account' },
  { href: '/privacy', label: 'How we use your data' },
];

/**
 * Nova.Help's own description of what a Nova Account is for, shown where a product asks.
 *
 * Kept as data because it is a PROMISE, and a promise that is restated in four templates is a
 * promise that ends up worded four ways. Every one of these has to stay true of every Nova
 * product, or it does not belong in the list.
 */
export const accountPromises = [
  'Every Nova product works without an account, and keeps working if you never make one.',
  'One account across Nova — never one per product.',
  'Signing in adds your identity. It never takes a feature away from somebody signed out.',
];
