/**
 * Categories that every Nova product shares.
 *
 * These are functions, not constants, so a project can take the standard "Account & sign-in"
 * category and drop or relabel one issue type without mutating an object three other projects
 * are also using. Every project file composes its category list out of these plus its own.
 *
 * SENSITIVE ISSUE TYPES. `sensitive: true` marks the decisions an automated assistant must
 * never make on its own: account ownership and recovery, suspensions, security reports,
 * payments and legal requests. The policy layer (server/core/policy.mjs) reads this flag, pins
 * such tickets to human review, and the ticket form says so out loud. It is set here — in the
 * data — so the guarantee holds for issue types added later without anyone remembering a rule.
 */

/** Account, sign-in and ownership. Every issue type here is human-only by design. */
export const accountCategory = (overrides = {}) => ({
  id: 'account',
  label: 'Account & sign-in',
  blurb: 'Signing in, recovery, ownership and account security.',
  icon: 'key',
  issueTypes: [
    {
      id: 'cannot-sign-in',
      label: "I can't sign in",
      blurb: 'Password, email or verification code problems.',
      priorityMode: 'ask',
      priority: 'high',
      sensitive: true,
    },
    {
      id: 'account-recovery',
      label: 'Recover a lost account',
      blurb: 'No access to the email address or sign-in method.',
      priorityMode: 'fixed',
      priority: 'high',
      sensitive: true,
    },
    {
      id: 'account-security',
      label: 'Suspicious activity on my account',
      blurb: 'Unrecognised sign-ins, or you think someone else has access.',
      priorityMode: 'fixed',
      priority: 'urgent',
      sensitive: true,
    },
    {
      id: 'account-restricted',
      label: 'My account is restricted or suspended',
      priorityMode: 'fixed',
      priority: 'high',
      sensitive: true,
    },
    {
      id: 'account-data',
      label: 'Export or delete my data',
      blurb: 'Privacy requests about the information we hold.',
      priorityMode: 'fixed',
      priority: 'normal',
      sensitive: true,
    },
  ],
  ...overrides,
});

/** Bugs and feature requests — the catch-all every product needs. */
export const feedbackCategory = (overrides = {}) => ({
  id: 'feedback',
  label: 'Bugs & feedback',
  blurb: 'Report something broken, or ask for something new.',
  icon: 'flag',
  issueTypes: [
    {
      id: 'bug',
      label: 'Report a bug',
      blurb: 'Something behaves incorrectly and you can describe how to hit it.',
      priorityMode: 'ask',
      priority: 'normal',
    },
    {
      id: 'crash',
      label: 'It crashes or freezes',
      priorityMode: 'ask',
      priority: 'high',
      articles: ['collect-logs'],
    },
    {
      id: 'feature-request',
      label: 'Request a feature',
      blurb: 'An idea or an improvement. These are read, but not tracked as faults.',
      priorityMode: 'fixed',
      priority: 'low',
    },
    {
      id: 'feedback',
      label: 'General feedback',
      priorityMode: 'fixed',
      priority: 'low',
    },
  ],
  ...overrides,
});

/** The honest escape hatch. Without one, people file under the wrong category instead. */
export const otherCategory = (overrides = {}) => ({
  id: 'other',
  label: 'Something else',
  blurb: "Not sure where it fits? Start here and we'll route it.",
  icon: 'help',
  issueTypes: [
    {
      id: 'question',
      label: 'I have a question',
      priorityMode: 'ask',
      priority: 'normal',
    },
    {
      id: 'other',
      label: 'Something not listed here',
      priorityMode: 'ask',
      priority: 'normal',
    },
  ],
  ...overrides,
});

/** Payments. Only mounted by projects that actually take money. */
export const billingCategory = (overrides = {}) => ({
  id: 'billing',
  label: 'Payments & refunds',
  blurb: 'Charges, receipts, subscriptions and refund requests.',
  icon: 'card',
  issueTypes: [
    {
      id: 'refund',
      label: 'Request a refund',
      priorityMode: 'fixed',
      priority: 'normal',
      sensitive: true,
    },
    {
      id: 'charge-problem',
      label: 'A charge looks wrong',
      priorityMode: 'fixed',
      priority: 'high',
      sensitive: true,
    },
    {
      id: 'receipt',
      label: 'I need a receipt or invoice',
      priorityMode: 'fixed',
      priority: 'low',
      sensitive: true,
    },
  ],
  ...overrides,
});
