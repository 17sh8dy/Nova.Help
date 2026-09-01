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

  /** Where the rest of the ecosystem lives. `null` hides the link entirely. */
  links: {
    nova: 'https://nova.example',
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
