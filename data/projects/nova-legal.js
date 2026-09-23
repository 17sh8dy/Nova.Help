import { otherCategory } from '../shared.js';

/**
 * Nova Legal — nova-legal.shadylabs.workers.dev, the terms/privacy/product-document site.
 * No account category (the site has no accounts) and no "Bugs & feedback" (the same reasoning
 * as Nova Site: a wrong document or a broken page here is a content or website problem, not a
 * product bug).
 *
 * NO `logo`: NovaLegal's own favicon and icon set draw the same generic Nova star this app
 * already has as `icon: 'nova'` — it is not a distinct mark for this product, so this project
 * uses the fallback glyph system instead of inventing a mark that does not exist.
 */
export const project = {
  id: 'nova-legal',
  name: 'Nova Legal',
  blurb: 'Terms, privacy and product-specific legal documents for the Nova ecosystem.',
  kind: 'Website',
  icon: 'book',
  environment: { collect: false },
  categories: [
    {
      id: 'documents',
      label: 'Finding a document',
      blurb: 'Locating the terms, the privacy policy, or a document for a specific product.',
      icon: 'browser',
      issueTypes: [
        { id: 'cant-find', label: "I can't find a document", priorityMode: 'fixed', priority: 'low' },
        { id: 'broken-link', label: 'A link is broken', priorityMode: 'fixed', priority: 'low' },
      ],
    },
    {
      id: 'accuracy',
      label: 'A document seems wrong',
      blurb: 'Out-of-date, incorrect or unclear content, or an accessibility problem.',
      icon: 'flag',
      issueTypes: [
        { id: 'outdated', label: 'A document seems wrong or out of date', priorityMode: 'fixed', priority: 'normal' },
        {
          id: 'accessibility',
          label: 'Report an accessibility issue',
          blurb: 'Screen reader, keyboard, contrast or motion.',
          priorityMode: 'ask',
          priority: 'high',
        },
      ],
    },
    otherCategory(),
  ],
};
