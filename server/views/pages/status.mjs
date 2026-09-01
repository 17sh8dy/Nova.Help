/**
 * The pages nobody plans to see: not found, refused, rate limited, and the server error.
 *
 * They exist as real pages rather than as bare status codes because a support portal is where
 * people go when something has already gone wrong. A 404 that offers the way back to the
 * product list costs nothing and saves the ticket that would otherwise say "your site is
 * broken too".
 *
 * The 500 page never shows the underlying error. It shows what the reporter can do next.
 */
import { page, hero } from '../layout.mjs';
import { button, esc, notice } from '../components.mjs';

function shell({ title, heading, lede, bodyHtml, path = '/' }) {
  return page({
    title,
    path,
    noindex: true,
    hero: hero({ eyebrow: 'Nova.Help', title: heading, lede }),
    main: `<section class="section"><div class="wrap narrow">${bodyHtml}</div></section>`,
  });
}

export const notFoundPage = ({ what = 'That page' } = {}) =>
  shell({
    title: 'Not found',
    heading: 'We could not find that',
    lede: `${what} does not exist, or it has been renamed.`,
    bodyHtml: `<div class="card">
      <p class="card__body">Start again from the product list — it is three clicks from there to a ticket.</p>
      <div class="form__actions">
        ${button('Back to support', { href: '/', variant: 'primary' })}
        ${button('Check a ticket', { href: '/tickets', variant: 'ghost' })}
      </div>
    </div>`,
  });

export const forbiddenPage = () =>
  shell({
    title: 'Not available',
    heading: 'You need to open this ticket first',
    lede: 'Ticket pages are private to the person who filed them.',
    bodyHtml: `<div class="card">
      <p class="card__body">
        Access to a ticket lasts two weeks on the device that created it. To open it again,
        or from another device, use the ticket ID and the email address it was filed with.
      </p>
      <div class="form__actions">
        ${button('Check a ticket', { href: '/tickets', variant: 'primary' })}
        ${button('Back to support', { href: '/', variant: 'ghost' })}
      </div>
    </div>`,
  });

export const tooManyPage = ({ retryAfter = 60 } = {}) =>
  shell({
    title: 'Too many requests',
    heading: 'Slow down a moment',
    lede: 'Too many attempts came from here in a short time.',
    bodyHtml: `${notice('warning', `Try again in about ${esc(retryAfter)} seconds.`, '<p>This limit exists so the support queue stays usable for everyone.</p>')}
    <div class="card"><div class="form__actions">${button('Back to support', { href: '/', variant: 'secondary' })}</div></div>`,
  });

export const errorPage = ({ reference = null } = {}) =>
  shell({
    title: 'Something went wrong',
    heading: 'Something went wrong at our end',
    lede: 'This one is ours, not yours.',
    bodyHtml: `<div class="card">
      <p class="card__body">
        Your last action may not have been saved. If you were submitting a ticket, check
        whether it arrived before sending it again.
      </p>
      ${reference ? `<p class="card__body">Quote <code>${esc(reference)}</code> if you tell us about this.</p>` : ''}
      <div class="form__actions">
        ${button('Back to support', { href: '/', variant: 'primary' })}
        ${button('Check a ticket', { href: '/tickets', variant: 'ghost' })}
      </div>
    </div>`,
  });
