import { otherCategory } from '../shared.js';

/**
 * Atlas Website — atlas-website.shadylabs.workers.dev, the marketing and download site.
 * Same shape as Nova Site's own "website" category and the same reasoning: no account
 * category (the site has no accounts of its own) and no "Bugs & feedback" (a broken page here
 * is a website problem, not a product bug — Atlas the app has its own project for that).
 */
export const project = {
  id: 'atlas-website',
  name: 'Atlas Website',
  blurb: "Atlas's own site — features, downloads and documentation.",
  kind: 'Website',
  logo: 'atlas',
  environment: { collect: false },
  categories: [
    {
      id: 'website',
      label: 'Website problem',
      blurb: 'Something on the site is broken, missing or wrong.',
      icon: 'browser',
      issueTypes: [
        { id: 'page-error', label: "The site won't load", priorityMode: 'ask', priority: 'normal' },
        { id: 'content-error', label: 'Some information is out of date or incorrect', priorityMode: 'fixed', priority: 'low' },
        { id: 'broken-link', label: 'A link or download is wrong', priorityMode: 'fixed', priority: 'low' },
        {
          id: 'accessibility',
          label: 'An accessibility problem',
          blurb: 'Screen reader, keyboard, contrast or motion.',
          priorityMode: 'ask',
          priority: 'high',
        },
      ],
    },
    otherCategory(),
  ],
};
