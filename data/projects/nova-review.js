import { accountCategory, otherCategory } from '../shared.js';

/**
 * Nova.Review — nova-review.shadylabs.workers.dev, where people leave reviews and suggestions
 * for the public Nova products.
 *
 * Two things deliberately do NOT live here:
 *  - REPORTING someone else's review or suggestion. That is the ⋯ → Report menu on Nova.Review
 *    itself, which reaches an admin directly and never removes anything automatically. A support
 *    ticket is for "the site is broken for me", not for moderating other people's posts.
 *  - A "Bugs & feedback" category. Feedback about a Nova product is a *suggestion* on Nova.Review
 *    (that is what it is for); a broken page here is a website problem, as for Nova Site.
 *
 * NO `logo`: it has no mark of its own yet, so it uses the fallback glyph system.
 */
export const project = {
  id: 'nova-review',
  name: 'Nova.Review',
  blurb: 'Reviews and suggestions for Nova products.',
  kind: 'Website',
  icon: 'spark',
  environment: { collect: false },
  categories: [
    {
      id: 'website',
      label: "Something isn't working",
      blurb: "Posting, voting or loading pages on Nova.Review isn't working for you.",
      icon: 'browser',
      issueTypes: [
        { id: 'page-error', label: 'A page is broken or will not load', priorityMode: 'ask', priority: 'normal' },
        { id: 'cant-post', label: "I can't post a review or suggestion", blurb: 'Including a verification check that will not pass.', priorityMode: 'ask', priority: 'normal' },
        { id: 'sign-in', label: 'Signing in with Nova does not work here', priorityMode: 'ask', priority: 'normal' },
        { id: 'accessibility', label: 'An accessibility problem', blurb: 'Screen reader, keyboard, contrast or motion.', priorityMode: 'ask', priority: 'high' },
      ],
    },
    {
      id: 'my-content',
      label: 'My reviews and suggestions',
      blurb: 'A question about something you posted, or something a moderator removed.',
      icon: 'flag',
      issueTypes: [
        { id: 'removed', label: 'A question about a removed review or suggestion', blurb: 'The reason, if one was given, is in your Nova.Review settings.', priorityMode: 'fixed', priority: 'normal' },
        { id: 'cant-edit', label: "I can't edit or delete my review", priorityMode: 'fixed', priority: 'normal' },
        { id: 'privacy-request', label: 'A privacy request about what I posted', priorityMode: 'fixed', priority: 'normal', sensitive: true },
      ],
    },
    accountCategory(),
    otherCategory(),
  ],
};
