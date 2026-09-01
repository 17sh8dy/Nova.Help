/**
 * The forgotten-password pages: ask for a link, and choose a new password with one.
 *
 * ONE RULE GOVERNS THE FIRST PAGE AND IT IS NOT NEGOTIABLE: the confirmation says the same
 * thing whether or not the address has an account. Not a different sentence, not a different
 * status code, not a subtly different layout — the same page. Anything else turns this form
 * into a way to test a list of addresses for who has signed up, and it is the one form on the
 * site that invites a stranger to type somebody else's address into it.
 *
 * So `requestSentPage` takes no argument saying whether anything was sent, because there is
 * nothing it could correctly do with one.
 *
 * The second page is the opposite problem: somebody arriving with a dead link should be told
 * so BEFORE they choose a password and type it twice, not after. `resetPasswordPage` therefore
 * renders either a form or an explanation, and the explanation always offers the way back.
 */
import { ACCOUNT_LIMITS } from '@nova/accounts';
import { page, hero } from '../layout.mjs';
import { button, esc, icon, notice, textField } from '../components.mjs';

/** The line that keeps the promise: an account was never required to get help. */
const guestWayOut = `<div class="card card--quiet">
  <p class="card__lede">
    You do not need an account to get help. You can
    <a href="/">open a ticket as a guest</a> at any time, and check it later with the ticket ID
    and the address you used.
  </p>
</div>`;

/* ── Step one: ask for a link ────────────────────────────────────────────────────────────── */

export function forgotPasswordPage({ values = {}, errors = {}, rateLimited = null } = {}) {
  const problem = rateLimited
    ? notice(
        'warning',
        'Too many attempts',
        `<p>Wait ${esc(rateLimited)} seconds and try again. If you are locked out and in a hurry, you can still open a ticket as a guest.</p>`,
      )
    : '';

  const main = `<section class="section">
    <div class="wrap narrow">
      ${problem}
      <form class="card form" method="post" action="/account/forgot" novalidate>
        <h2 class="card__title">${icon('key', { size: 20 })} Reset your password</h2>
        <p class="card__lede">
          Type the address on your Nova Account and we will send a link to choose a new
          password. The link works once and expires after an hour.
        </p>
        ${textField({
          id: 'email',
          label: 'Email address',
          type: 'email',
          value: values.email ?? '',
          error: errors.email,
          required: true,
          maxLength: ACCOUNT_LIMITS.email.max,
          autocomplete: 'email',
        })}
        <div class="form__actions">
          ${button('Send the link', { type: 'submit', variant: 'primary', iconName: 'mail' })}
          <a class="btn btn--ghost" href="/account/sign-in">Back to sign in</a>
        </div>
        <p class="form__fineprint">
          If your account was created with Google and has never had a password, this is also how
          you set one.
        </p>
      </form>
      ${guestWayOut}
    </div>
  </section>`;

  return page({
    title: 'Reset your password',
    path: '/account/forgot',
    hero: hero({
      eyebrow: 'Nova Account',
      title: 'Forgotten your password?',
      lede: 'It happens. Tell us the address and we will send you a way back in.',
    }),
    main,
  });
}

/**
 * The confirmation.
 *
 * Deliberately parameterless past the address that was typed. It is shown for an address with
 * an account and for one without, and the wording has to be true in both cases — hence "if
 * there is an account", which is honest rather than coy, and does not pretend a mail was sent.
 */
export function resetRequestedPage({ email = '' } = {}) {
  const main = `<section class="section">
    <div class="wrap narrow">
      <div class="card">
        <h2 class="card__title">${icon('mail', { size: 20 })} Check your email</h2>
        <p class="card__lede">
          If there is a Nova Account for <strong>${esc(email)}</strong>, a link to choose a new
          password is on its way. It works once and expires after an hour.
        </p>
        <p class="card__lede">
          Nothing has arrived after a few minutes? Check the spam folder, and make sure that is
          the address you signed up with. You can
          <a href="/account/forgot">ask for another link</a> — asking again replaces the
          previous one.
        </p>
        <div class="form__actions">
          ${button('Back to sign in', { href: '/account/sign-in', variant: 'secondary', iconName: 'arrow' })}
        </div>
      </div>
      ${guestWayOut}
    </div>
  </section>`;

  return page({
    title: 'Check your email',
    path: '/account/forgot',
    hero: hero({
      eyebrow: 'Nova Account',
      title: 'Check your email',
      lede: 'The next step is in your inbox.',
    }),
    main,
  });
}

/* ── Step two: choose a new password ─────────────────────────────────────────────────────── */

/** What to say about a link that cannot be used, and how to get a working one. */
const deadLink = (reason) => {
  const [title, body] =
    reason === 'expired'
      ? [
          'That link has expired',
          '<p>Reset links last an hour, so this one has lapsed. Ask for another and it will arrive with a fresh hour on it.</p>',
        ]
      : [
          'That link cannot be used',
          '<p>It may have been used already, replaced by a newer one, or copied incompletely from the email. Whichever it is, asking for another will fix it.</p>',
        ];

  return `<section class="section">
    <div class="wrap narrow">
      ${notice('error', title, body)}
      <div class="card">
        <h2 class="card__title">${icon('key', { size: 20 })} Get a new link</h2>
        <p class="card__lede">
          Your password has not been changed and your account is untouched.
        </p>
        <div class="form__actions">
          ${button('Ask for another link', { href: '/account/forgot', variant: 'primary', iconName: 'mail' })}
          <a class="btn btn--ghost" href="/account/sign-in">Back to sign in</a>
        </div>
      </div>
      ${guestWayOut}
    </div>
  </section>`;
};

/**
 * The form, or the explanation of why there is no form.
 *
 * `token` is carried in a hidden field rather than left in the query string of the POST, so it
 * does not end up in a server access log for the request that spends it. It is still in the URL
 * of the GET — it has to be, it arrived in an email — which is why it is single-use and short
 * lived rather than merely secret.
 */
export function resetPasswordPage({
  token = '',
  email = '',
  errors = {},
  invalid = null,
  rateLimited = null,
} = {}) {
  if (invalid) {
    return page({
      title: 'Reset your password',
      path: '/account/reset',
      hero: hero({ eyebrow: 'Nova Account', title: 'Reset your password', lede: 'This link did not work.' }),
      main: deadLink(invalid),
    });
  }

  const problem = rateLimited
    ? notice(
        'warning',
        'Too many attempts',
        `<p>Wait ${esc(rateLimited)} seconds and try again.</p>`,
      )
    : '';

  const main = `<section class="section">
    <div class="wrap narrow">
      ${problem}
      <form class="card form" method="post" action="/account/reset" novalidate>
        <h2 class="card__title">${icon('key', { size: 20 })} Choose a new password</h2>
        <p class="card__lede">
          ${email ? `For <strong>${esc(email)}</strong>. ` : ''}Everything currently signed in
          will be signed out once you save it.
        </p>
        <input type="hidden" name="token" value="${esc(token)}" />
        ${textField({
          id: 'password',
          label: 'New password',
          type: 'password',
          error: errors.password,
          required: true,
          maxLength: ACCOUNT_LIMITS.password.max,
          autocomplete: 'new-password',
          hint: `At least ${ACCOUNT_LIMITS.password.min} characters. A short sentence is easier to remember and harder to guess.`,
        })}
        ${textField({
          id: 'passwordConfirm',
          label: 'New password again',
          type: 'password',
          error: errors.passwordConfirm,
          required: true,
          maxLength: ACCOUNT_LIMITS.password.max,
          autocomplete: 'new-password',
        })}
        <div class="form__actions">
          ${button('Save the new password', { type: 'submit', variant: 'primary', iconName: 'check' })}
        </div>
      </form>
    </div>
  </section>`;

  return page({
    title: 'Choose a new password',
    path: '/account/reset',
    hero: hero({
      eyebrow: 'Nova Account',
      title: 'Choose a new password',
      lede: 'One more step and you are back in.',
    }),
    main,
  });
}
