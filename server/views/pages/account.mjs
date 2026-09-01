/**
 * The Nova Account pages: sign in, create an account, and the account itself.
 *
 * THREE THINGS ARE DELIBERATE HERE.
 *
 * 1. NEITHER FORM EVER ECHOES A PASSWORD BACK. A failed sign-up re-renders with the address
 *    and the name still filled in and both password boxes empty. Re-rendering a password into
 *    a `value=` attribute puts it in the page source, in the browser's back/forward cache, and
 *    in any proxy that logs response bodies; making the person type it again is the cheaper
 *    of the two costs.
 *
 * 2. A FAILED SIGN-IN SAYS ONE THING. "Unknown address" and "wrong password" produce the same
 *    sentence and the same status code, because a form that distinguishes them tells a
 *    stranger which of a list of addresses have Nova Accounts. The service equalises the
 *    timing; this page equalises the wording.
 *
 * 3. THE ACCOUNT IS NEVER PRESENTED AS THE WAY TO GET SUPPORT. Every one of these pages says
 *    somewhere that a ticket can be filed without one, and links to the way to do it. That
 *    sentence is the whole difference between an account being a convenience and an account
 *    being a gate.
 */
import { ACCOUNT_LIMITS } from '../../accounts/index.mjs';
import { getStatus } from '../../core/catalog.mjs';
import { page, hero } from '../layout.mjs';
import { badge, button, esc, escUrl, icon, notice, textField } from '../components.mjs';

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) ? '' : dateFormat.format(date);
};

/** A hidden `next` field, so a POST keeps the destination the GET arrived with. */
const nextField = (next) => (next ? `<input type="hidden" name="next" value="${esc(next)}" />` : '');

const nextQuery = (next) => (next ? `?next=${escUrl(next)}` : '');

/** The line that keeps the promise: you never had to be here. */
const guestWayOut = `<div class="card card--quiet">
  <h2 class="card__title">${icon('ticket', { size: 18 })} You do not need an account</h2>
  <p class="card__body">
    Every part of Nova.Help works without one. You can
    <a href="/">open a ticket as a guest</a> with just an email address, or
    <a href="/tickets">check an existing ticket</a> with its ID and that address.
    An account only makes it faster the next time.
  </p>
</div>`;

/**
 * The provider buttons, above the password form.
 *
 * They go first because for somebody who has one, it is one click against six fields — and
 * because burying them under the form is how you end up with people making a second account
 * they did not need. `next` rides along so a provider round trip still lands where they were
 * going.
 *
 * Nothing renders when no provider is configured, and the "or" divider goes with them; a
 * deployment without a Google client sees exactly the form it saw before.
 */
function providerButtons(providers, { next, verb = 'Continue with' }) {
  if (!providers.length) return '';

  const buttons = providers
    .map(
      (provider) => `<a class="provider" href="/account/auth/${escUrl(provider.id)}${next ? `?next=${escUrl(next)}` : ''}">
        ${providerGlyph(provider.id)}
        <span>${esc(verb)} ${esc(provider.label)}</span>
      </a>`,
    )
    .join('');

  return `<div class="providers">${buttons}</div>
    <p class="providers__or"><span>or</span></p>`;
}

/**
 * A provider's own mark.
 *
 * Google's is drawn rather than linked, because the site's content security policy allows no
 * third-party origins at all and a favicon fetched from Google would be both a blocked request
 * and a beacon telling Google who is looking at this page before anybody has chosen to sign in.
 * The four brand colours are fixed, not tokens: this is somebody else's logo.
 */
function providerGlyph(id) {
  if (id !== 'google') return icon('user', { size: 18 });
  return `<svg class="provider__glyph" width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z"/>
    <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.5 46 24 46z"/>
    <path fill="#FBBC05" d="M11.8 28.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 17.1 2.1 20.4 2.1 24s.9 6.9 2.4 9.9l7.3-5.7z"/>
    <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 29.9 2 24 2 15.5 2 8.1 6.9 4.5 14.1l7.3 5.7c1.7-5.2 6.5-9 12.2-9z"/>
  </svg>`;
}

/**
 * What the callback needs to say when it could not sign somebody in.
 *
 * `email-has-account` is the one that matters, and it gets a full explanation rather than a
 * shrug: somebody has just been refused for a reason that is not their fault and is not
 * obvious, and the next thing they need is the way through, not an apology.
 */
function oauthNotice(kind) {
  if (kind === 'email-has-account') {
    return notice(
      'warning',
      'That address already has a Nova Account',
      `<p>
        The account was made with a password, and we have no way to confirm that the two belong
        to the same person — so we will not join them automatically. Sign in with your password
        below, then connect Google from your account page and it will work from then on.
      </p>
      <p>If you did not create that account, please <a href="/">open a ticket</a> and tell us.</p>`,
    );
  }
  if (kind === 'unverified') {
    return notice(
      'warning',
      'That account has no confirmed email address',
      '<p>The provider did not confirm an email address for it, and we will not create a Nova Account without one. You can still open a ticket as a guest, or create an account with a password below.</p>',
    );
  }
  if (kind === 'identity-taken') {
    return notice(
      'error',
      'That is already connected to another Nova Account',
      '<p>Sign in to that account to disconnect it first, or use a different one.</p>',
    );
  }
  if (kind === 'cancelled') {
    return notice('info', 'Sign-in cancelled', '<p>Nothing happened. You can try again, or use a password below.</p>');
  }
  if (kind === 'failed') {
    return notice(
      'error',
      'That sign-in could not be completed',
      '<p>It may have taken too long, or been interrupted. Please start it again.</p>',
    );
  }
  return '';
}

/* ── Sign in ───────────────────────────────────────────────────────────────────────────── */

export function signInPage({ values = {}, errors = {}, failed = false, rateLimited = null, next = '', providers = [], notice: oauth = null } = {}) {
  const problem = rateLimited
    ? notice(
        'warning',
        'Too many attempts',
        `<p>Wait ${esc(rateLimited)} seconds and try again. If you have forgotten which address you used, you can still open a ticket as a guest.</p>`,
      )
    : failed
      ? notice(
          'error',
          'That did not sign you in',
          '<p>Check the email address and password and try again. If you have never made a Nova Account, create one below.</p>',
        )
      : '';

  const main = `<section class="section">
    <div class="wrap narrow">
      ${oauthNotice(oauth)}
      ${problem}
      <form class="card form" method="post" action="/account/sign-in" novalidate>
        <h2 class="card__title">${icon('user', { size: 20 })} Sign in to Nova</h2>
        <p class="card__lede">One Nova Account, for Nova.Help and — in time — the rest of Nova.</p>
        ${providerButtons(providers, { next })}
        ${nextField(next)}
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
        ${textField({
          id: 'password',
          label: 'Password',
          type: 'password',
          error: errors.password,
          required: true,
          maxLength: ACCOUNT_LIMITS.password.max,
          autocomplete: 'current-password',
        })}
        <div class="form__actions">
          ${button('Sign in', { type: 'submit', variant: 'primary', iconName: 'arrow' })}
          <a class="btn btn--ghost" href="/account/new${nextQuery(next)}">Create an account</a>
        </div>
        <p class="form__fineprint">
          <a href="/account/forgot">Forgotten your password?</a> We will send a link to the
          address on the account.
        </p>
      </form>
      ${guestWayOut}
    </div>
  </section>`;

  return page({
    title: 'Sign in',
    description: 'Sign in to your Nova Account.',
    path: '/account/sign-in',
    noindex: true,
    hero: hero({
      eyebrow: 'Nova Account',
      title: 'Sign in',
      lede: 'Signing in is optional. It keeps your tickets together and saves typing your address every time.',
    }),
    main,
  });
}

/* ── Create an account ─────────────────────────────────────────────────────────────────── */

export function createAccountPage({ values = {}, errors = {}, rateLimited = null, next = '', providers = [] } = {}) {
  const problem = rateLimited
    ? notice(
        'warning',
        'Too many attempts',
        `<p>Wait ${esc(rateLimited)} seconds and try again. You can open a ticket as a guest in the meantime.</p>`,
      )
    : '';

  const main = `<section class="section">
    <div class="wrap narrow">
      ${problem}
      <form class="card form" method="post" action="/account/new" novalidate>
        <h2 class="card__title">${icon('nova', { size: 20 })} Create a Nova Account</h2>
        <p class="card__lede">
          One account for Nova products. Today it works with Nova.Help; other Nova products
          will use the same account rather than asking you to make another.
        </p>
        ${providerButtons(providers, { next, verb: 'Sign up with' })}
        ${nextField(next)}
        ${textField({
          id: 'email',
          label: 'Email address',
          type: 'email',
          hint: 'Where support replies go. We do not send anything else to it.',
          value: values.email ?? '',
          error: errors.email,
          required: true,
          maxLength: ACCOUNT_LIMITS.email.max,
          autocomplete: 'email',
        })}
        ${textField({
          id: 'displayName',
          label: 'Name',
          hint: 'What we call you in a reply. Optional.',
          value: values.displayName ?? '',
          error: errors.displayName,
          maxLength: ACCOUNT_LIMITS.displayName.max,
          autocomplete: 'name',
          placeholder: 'Optional',
        })}
        ${textField({
          id: 'password',
          label: 'Password',
          type: 'password',
          hint: `At least ${ACCOUNT_LIMITS.password.min} characters. A short sentence you will remember beats a short word you will not.`,
          error: errors.password,
          required: true,
          maxLength: ACCOUNT_LIMITS.password.max,
          autocomplete: 'new-password',
        })}
        ${textField({
          id: 'passwordConfirm',
          label: 'Password again',
          type: 'password',
          error: errors.passwordConfirm,
          required: true,
          maxLength: ACCOUNT_LIMITS.password.max,
          autocomplete: 'new-password',
        })}
        <div class="form__actions">
          ${button('Create account', { type: 'submit', variant: 'primary', iconName: 'arrow' })}
          <a class="btn btn--ghost" href="/account/sign-in${nextQuery(next)}">I already have one</a>
        </div>
        <p class="form__fineprint">
          Your password is stored only as a slow one-way hash. Nobody at Nova can read it, and
          nobody will ever ask you for it.
        </p>
      </form>
      ${guestWayOut}
    </div>
  </section>`;

  return page({
    title: 'Create a Nova Account',
    description: 'Create a Nova Account to keep your support tickets together.',
    path: '/account/new',
    noindex: true,
    hero: hero({
      eyebrow: 'Nova Account',
      title: 'Create a Nova Account',
      lede: 'Optional, and quick. It exists so you do not type your email address into every ticket.',
    }),
    main,
  });
}

/* ── The account itself ────────────────────────────────────────────────────────────────── */

function ticketRow(ticket) {
  const status = getStatus(ticket.status);
  return `<li class="mine">
    <a class="mine__link" href="/tickets/${escUrl(ticket.id)}">
      <span class="mine__head">
        <span class="mine__id">${esc(ticket.id)}</span>
        ${badge(status?.label ?? ticket.status, status?.tone ?? 'neutral', { title: status?.description })}
      </span>
      <span class="mine__subject">${esc(ticket.subject)}</span>
      <span class="mine__meta">${esc(ticket.labels.project)} · ${esc(ticket.labels.category)} · opened ${esc(when(ticket.createdAt))}</span>
    </a>
  </li>`;
}

export function accountPage({ account, tickets = [], total = 0, banner = null, providers = [], problem = null } = {}) {
  const list = tickets.length
    ? `<ul class="mines">${tickets.map(ticketRow).join('')}</ul>`
    : `<p class="card__body">
        No tickets on this account yet. Anything you file while signed in appears here.
        ${'' /* Tickets filed as a guest are not listed; see docs/NOVA-ACCOUNTS.md. */}
      </p>`;

  /**
   * Connected sign-in methods.
   *
   * DISCONNECT IS WITHHELD WHEN IT WOULD LOCK THE PERSON OUT — an account with no password
   * whose only way in is this provider. The service refuses it too; the button is hidden so
   * that nobody is offered a door that is then slammed, and a line of text says why instead of
   * leaving a control mysteriously absent.
   */
  const connections = providers.length
    ? `<section class="card card--quiet" aria-labelledby="connections-heading">
        <h2 class="card__title" id="connections-heading">${icon('key', { size: 18 })} Sign-in methods</h2>
        <ul class="connections">
          <li class="connection">
            <span class="connection__glyph">${icon('key', { size: 18 })}</span>
            <span class="connection__text">
              <span class="connection__name">Password</span>
              <span class="connection__state">${account.hasPassword ? 'Set' : 'Not set — you sign in with a provider'}</span>
            </span>
          </li>
          ${providers
            .map((provider) => {
              const linked = account.identities.find((i) => i.provider === provider.id);
              const onlyWayIn = Boolean(linked) && !account.hasPassword && account.identities.length <= 1;
              return `<li class="connection">
                <span class="connection__glyph">${providerGlyph(provider.id)}</span>
                <span class="connection__text">
                  <span class="connection__name">${esc(provider.label)}</span>
                  <span class="connection__state">${
                    linked
                      ? `Connected${linked.email ? ` as ${esc(linked.email)}` : ''}`
                      : 'Not connected'
                  }</span>
                </span>
                ${
                  linked
                    ? onlyWayIn
                      ? '<span class="connection__note">Your only way in</span>'
                      : `<form method="post" action="/account/unlink/${escUrl(provider.id)}">
                          ${button('Disconnect', { type: 'submit', variant: 'ghost', size: 'sm' })}
                        </form>`
                    : `<form method="post" action="/account/auth/${escUrl(provider.id)}">
                        ${button('Connect', { type: 'submit', variant: 'secondary', size: 'sm' })}
                      </form>`
                }
              </li>`;
            })
            .join('')}
        </ul>
        <p class="card__body card__body--fine">
          Connecting one of these is a convenience, not a second account. It is the same Nova
          Account either way.
        </p>
      </section>`
    : '';

  const problemHtml =
    problem === 'last-way-in'
      ? notice(
          'error',
          'That is your only way to sign in',
          '<p>Disconnecting it would lock you out, because this account has no password. Set one first — until password changes exist, open a ticket and we will sort it out.</p>',
        )
      : problem === 'identity-taken'
        ? oauthNotice('identity-taken')
        : problem
          ? oauthNotice('failed')
          : '';

  const bannerHtml =
    banner === 'created'
      ? notice('success', 'Your Nova Account is ready', '<p>You are signed in. Tickets you file from now on will be listed here.</p>')
      : banner === 'signed-in'
        ? notice('success', 'Signed in', '<p>Welcome back.</p>')
        : banner === 'signed-out-everywhere'
          ? notice('success', 'Signed out everywhere else', '<p>Every other session on this account has been ended. This one is still open.</p>')
          : banner === 'linked'
            ? notice('success', 'Connected', '<p>You can now sign in with it. It is the same Nova Account, not a second one.</p>')
            : banner === 'unlinked'
              ? notice('success', 'Disconnected', '<p>That sign-in method has been removed from this account.</p>')
              : banner === 'password-reset'
                ? notice(
                    'success',
                    'Your password has been changed',
                    '<p>You are signed in on this device. Everything else that was signed in has been signed out, so sign in again anywhere you use Nova. If you did not do this, change the password again immediately and secure your email account.</p>',
                  )
                : '';

  const main = `<section class="section">
    <div class="wrap layout">
      <div class="layout__main">
        ${bannerHtml}
        ${problemHtml}

        <section class="card" aria-labelledby="mine-heading">
          <h2 class="card__title" id="mine-heading">${icon('ticket', { size: 20 })} Your tickets</h2>
          <p class="card__lede">
            ${total === 1 ? 'One ticket' : `${esc(total)} tickets`} filed with this account.
            Opening one here needs no ticket ID.
          </p>
          ${list}
          <div class="form__actions">
            ${button('Open a new ticket', { href: '/', variant: 'primary', iconName: 'arrow' })}
          </div>
        </section>

        <section class="card card--quiet" aria-labelledby="guest-heading">
          <h2 class="card__title" id="guest-heading">${icon('search', { size: 18 })} Filed a ticket before you had an account?</h2>
          <p class="card__body">
            Tickets filed as a guest stay guest tickets, even when they used this address —
            open them from <a href="/tickets">Check a ticket</a> with the ticket ID. They are
            not moved here automatically, because until we can verify an email address,
            matching one would let anybody claim somebody else's tickets by registering their
            address.
          </p>
        </section>
      </div>

      <aside class="layout__aside" aria-label="Account details">
        <div class="card card--quiet">
          <h2 class="card__title">${icon('user', { size: 18 })} Account</h2>
          <dl class="details">
            ${account.displayName ? `<div class="details__row"><dt>Name</dt><dd>${esc(account.displayName)}</dd></div>` : ''}
            <div class="details__row"><dt>Email</dt><dd>${esc(account.email)}</dd></div>
            <div class="details__row"><dt>Created</dt><dd>${esc(when(account.createdAt))}</dd></div>
            <div class="details__row"><dt>Account ID</dt><dd><code>${esc(account.id)}</code></dd></div>
          </dl>
          <form method="post" action="/account/sign-out">
            <div class="form__actions">
              ${button('Sign out', { type: 'submit', variant: 'secondary', iconName: 'logout' })}
            </div>
          </form>
          <form method="post" action="/account/sign-out-everywhere">
            <div class="form__actions">
              ${button('Sign out everywhere else', { type: 'submit', variant: 'ghost', size: 'sm' })}
            </div>
          </form>
        </div>

        ${connections}

        <div class="card card--quiet">
          <h2 class="card__title">${icon('shield', { size: 18 })} One account, more of Nova later</h2>
          <p class="card__body">
            Nova.Help is the first Nova product to use Nova Accounts. Others — the Launcher,
            the Store, and the apps — are intended to use this same account rather than asking
            you to make a new one. Nothing else uses it yet.
          </p>
        </div>
      </aside>
    </div>
  </section>`;

  return page({
    account,
    title: 'Your Nova Account',
    description: 'Your Nova Account and the support tickets filed with it.',
    path: '/account',
    noindex: true,
    hero: hero({
      eyebrow: 'Nova Account',
      title: account.displayName ? `Hello, ${account.displayName}` : 'Your Nova Account',
      lede: 'Your support history, and the address we reply to.',
    }),
    main,
  });
}
