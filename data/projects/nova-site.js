import { accountCategory, otherCategory } from '../shared.js';

/**
 * Nova Site — nova.example itself, and anything about Nova the studio rather than a product.
 * It gets no "Bugs & feedback" category: a broken page is a website issue, and product
 * feedback belongs against the product it is about.
 */
export const project = {
  id: 'nova-site',
  name: 'Nova Site',
  blurb: 'The Nova website, the studio, and anything that is not a specific product.',
  kind: 'Website',
  icon: 'nova',
  environment: { collect: false },
  categories: [
    {
      id: 'website',
      label: 'Website problem',
      blurb: 'Something on the site is broken, missing or wrong.',
      icon: 'browser',
      issueTypes: [
        { id: 'page-error', label: 'A page is broken or will not load', priorityMode: 'ask', priority: 'normal' },
        { id: 'broken-link', label: 'A link or download is wrong', priorityMode: 'fixed', priority: 'low' },
        { id: 'content-error', label: 'Some information is out of date or incorrect', priorityMode: 'fixed', priority: 'low' },
        { id: 'accessibility', label: 'An accessibility problem', blurb: 'Screen reader, keyboard, contrast or motion.', priorityMode: 'ask', priority: 'high' },
      ],
    },
    {
      id: 'legal',
      label: 'Legal & privacy',
      blurb: 'Privacy requests, terms, trademarks and content reports.',
      icon: 'shield',
      issueTypes: [
        { id: 'privacy-request', label: 'A privacy request about my data', priorityMode: 'fixed', priority: 'normal', sensitive: true },
        { id: 'report-content', label: 'Report content or misuse of Nova branding', priorityMode: 'fixed', priority: 'high', sensitive: true },
        { id: 'security-report', label: 'Report a security vulnerability', blurb: 'Please do not include a working exploit in the first message.', priorityMode: 'fixed', priority: 'urgent', sensitive: true },
        { id: 'legal-other', label: 'Another legal question', priorityMode: 'fixed', priority: 'normal', sensitive: true },
      ],
    },
    {
      id: 'business',
      label: 'Press & business',
      blurb: 'Media enquiries, partnerships and anything commercial.',
      icon: 'card',
      issueTypes: [
        { id: 'press', label: 'Press or media enquiry', priorityMode: 'fixed', priority: 'normal' },
        { id: 'partnership', label: 'Partnership or business enquiry', priorityMode: 'fixed', priority: 'low' },
        { id: 'careers', label: 'A question about working at Nova', priorityMode: 'fixed', priority: 'low' },
      ],
    },
    accountCategory(),
    otherCategory(),
  ],
};
