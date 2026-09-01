/**
 * "Check a ticket" — the way back in when the two-week pass has expired or you are on another
 * device.
 *
 * THE FAILURE MESSAGE IS DELIBERATELY VAGUE. A wrong id and a right id with the wrong email
 * address produce exactly the same sentence, because a message that distinguished them would
 * confirm that a ticket exists to anyone holding a list of ids. The rate limiter on this
 * route is the other half of that; without it the vagueness only slows an attacker down.
 *
 * THE ONE THING IT WILL SAY OUT LOUD is that a ticket belongs to a Nova Account — but only to
 * somebody who has already presented both the id and the right address, which is to say only
 * to somebody who has already proved as much as this form can ask for. Telling them to sign in
 * is the difference between a working route back and a dead end.
 */
import { page, hero } from '../layout.mjs';
import { button, esc, icon, notice, textField } from '../components.mjs';

export function lookupPage({ values = {}, errors = {}, failed = false, rateLimited = null, accountOwned = false, account = null } = {}) {
  const problem = rateLimited
    ? notice(
        'warning',
        'Too many attempts',
        `<p>Wait ${esc(rateLimited)} seconds and try again. If you have lost the ticket ID, open a new ticket and say so.</p>`,
      )
    : accountOwned
      ? notice(
          'info',
          'That ticket belongs to a Nova Account',
          `<p>It was filed while signed in, so it opens from the account rather than from an ID and address. <a href="/account/sign-in?next=%2Faccount">Sign in</a> and it will be listed under Your tickets.</p>`,
        )
    : failed
      ? notice(
          'error',
          'We could not open that ticket',
          '<p>Check the ID and the email address you filed it with. Both have to match. If the ticket was filed with a different address, use that one.</p>',
        )
      : '';

  const main = `<section class="section">
    <div class="wrap narrow">
      ${problem}
      <form class="card form" method="post" action="/tickets" novalidate>
        <h2 class="card__title">${icon('search', { size: 20 })} Open an existing ticket</h2>
        ${textField({
          id: 'ticketId',
          label: 'Ticket ID',
          hint: 'From your confirmation, in the form NH-0000-0000.',
          value: values.ticketId ?? '',
          error: errors.ticketId,
          required: true,
          placeholder: 'NH-',
          maxLength: 20,
        })}
        ${textField({
          id: 'email',
          label: 'Email address',
          type: 'email',
          hint: 'The address you used when you filed it.',
          value: values.email ?? '',
          error: errors.email,
          required: true,
          autocomplete: 'email',
        })}
        <div class="form__actions">
          ${button('Open ticket', { type: 'submit', variant: 'primary', iconName: 'arrow' })}
          <a class="btn btn--ghost" href="/">Get help instead</a>
        </div>
      </form>

      <div class="card card--quiet">
        <h2 class="card__title">${icon('info', { size: 18 })} Lost the ID?</h2>
        <p class="card__body">
          It is in the confirmation you saw when the ticket was created. If you cannot find it,
          open a new ticket describing the problem and mention that you filed one before — we
          can join them up at our end.
        </p>
      </div>
    </div>
  </section>`;

  return page({
    account,
    title: 'Check a ticket',
    description: 'Open an existing Nova support ticket with its ID and your email address.',
    path: '/tickets',
    noindex: true,
    hero: hero({
      eyebrow: 'Existing ticket',
      title: 'Check a ticket',
      lede: 'Your ticket ID and the email address you used will open it.',
    }),
    main,
  });
}
