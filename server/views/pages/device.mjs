/**
 * Connecting a Nova app to a Nova Account — the pages a person actually reads.
 *
 * This is the human half of the device grant (packages/nova-accounts/deviceService.mjs). An
 * app shows an eight-character code; this is where somebody types it and says yes.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE CONFIRMATION SCREEN IS A SECURITY CONTROL, NOT A COURTESY.
 *
 * The only thing between a person and approving a device somebody else is holding is whether
 * this page told them, plainly, what they are about to do. So it names the product, it lists
 * what the app will be able to do in sentences rather than in scope identifiers, and it says
 * out loud that if they did not start this, the answer is no.
 *
 * "Not now" is a real button of the same weight, not a link in small print — a confirmation
 * screen with one obvious action is a confirmation screen people click through.
 *
 * NOTHING HERE NAMES AN ACCOUNT IN A FIELD. Which account an approval attaches to is read
 * from the session on the server; a hidden field naming one would be a way to aim somebody
 * else's approval at an account of your choosing.
 */
import { esc, button, icon, notice, textField } from '../components.mjs';
import { hero, page } from '../layout.mjs';

/**
 * What each scope lets an app do, in the second person.
 *
 * WRITTEN OUT RATHER THAN SHOWN AS `sync` OR `support`, because "this app may read and write
 * the settings it saved to your account" is a sentence somebody can make a decision about and
 * `sync` is not. An unrecognised scope falls back to its own name rather than being hidden: a
 * permission this page cannot describe must still be visible.
 */
const SCOPE_WORDS = {
  identity: 'See that you are signed in, and your display name.',
  email: 'See the email address on your Nova Account.',
  support: 'File Nova.Help support tickets as you, and follow the ones it filed.',
  sync: 'Read and write the settings this app saves to your account — and nothing another app has saved.',
};

const scopeList = (scopes = []) =>
  `<ul class="scopes">${scopes
    .map(
      (scope) =>
        `<li class="scopes__item">${icon('check', { size: 17 })}<span>${esc(SCOPE_WORDS[scope] ?? scope)}</span></li>`,
    )
    .join('')}</ul>`;

/** The line that keeps the promise, on both screens: none of this was ever required. */
const optional = `<div class="card card--quiet">
  <h2 class="card__title">${icon('ticket', { size: 18 })} Connecting is optional</h2>
  <p class="card__body">
    Every Nova app works without a Nova Account, and stays working if you never connect one.
    Connecting adds your identity across Nova products — it does not switch anything on that
    was off before.
  </p>
</div>`;

/** The form somebody lands on from the app, with or without a code already in hand. */
export function deviceCodePage({ code = '', error = null, account = null, done = null } = {}) {
  const banner = done
    ? notice(
        done === 'approved' ? 'success' : 'info',
        done === 'approved' ? 'That app is connected.' : 'Nothing was connected.',
        done === 'approved'
          ? '<p>You can go back to it now. Sign it out again whenever you like, from <a href="/account">your Nova Account</a>.</p>'
          : '<p>The app was not given access to your account.</p>',
      )
    : '';

  const main = `<div class="wrap narrow">
    ${banner}
    ${
      error
        ? notice(
            'error',
            'That code did not work.',
            `<p>${esc(error)}</p><p>Codes last ten minutes. If yours has run out, the app will show you a new one.</p>`,
          )
        : ''
    }

    <form class="card form" method="post" action="/account/device/check">
      <p class="card__body">
        Your Nova app is showing an eight-character code. Type it here to connect it to your
        Nova Account.
      </p>
      ${textField({
        id: 'code',
        name: 'code',
        label: 'Code from the app',
        value: code,
        placeholder: 'KDMX-7QRT',
        hint: 'Upper or lower case, with or without the dash.',
        required: true,
        maxLength: 20,
        autocomplete: 'one-time-code',
      })}
      <div class="form__actions">${button('Continue', { type: 'submit' })}</div>
      ${
        account
          ? ''
          : '<p class="form__fineprint">You will be asked to sign in before anything is connected.</p>'
      }
    </form>

    ${optional}
  </div>`;

  return page({
    title: 'Connect an app',
    description: 'Connect a Nova app to your Nova Account.',
    path: '/account/device',
    noindex: true,
    account,
    hero: hero({
      eyebrow: 'Nova Account',
      title: 'Connect an app',
      lede: 'Type the code your app is showing.',
    }),
    main,
  });
}

/**
 * The confirmation. Everything on this screen exists so that the decision is an informed one.
 *
 * The decision is a POST carrying the code, so approving is never something a link — or a
 * page somebody else got you to open — can do on your behalf.
 */
export function deviceApprovePage({ grant, code, account }) {
  const main = `<div class="wrap narrow">
    <div class="card">
      <h2 class="card__title">${icon('cube', { size: 18 })} ${esc(grant.productName)}</h2>
      ${grant.productSummary ? `<p class="card__lede">${esc(grant.productSummary)}</p>` : ''}
      ${
        grant.deviceName
          ? `<p class="card__body">It says it is running on <strong>${esc(grant.deviceName)}</strong>.</p>`
          : ''
      }

      <p class="card__body"><strong>If you connect it, this app will be able to:</strong></p>
      ${scopeList(grant.scopes)}

      <p class="card__body card__body--fine">
        It will be signed in as ${esc(account.displayName || account.email)} until you sign it
        out, which you can do at any time from <a href="/account">your Nova Account</a>. It
        never sees your password.
      </p>

      <div class="form__actions">
        <form method="post" action="/account/device">
          <input type="hidden" name="code" value="${esc(code)}" />
          <input type="hidden" name="action" value="approve" />
          ${button('Connect this app', { type: 'submit' })}
        </form>
        <form method="post" action="/account/device">
          <input type="hidden" name="code" value="${esc(code)}" />
          <input type="hidden" name="action" value="deny" />
          ${button('Not now', { type: 'submit', variant: 'ghost' })}
        </form>
      </div>
    </div>

    ${notice(
      'warning',
      'Did you not start this yourself?',
      '<p>Choose <strong>Not now</strong>. Nothing can be connected to your account without somebody approving it on this page, so refusing is the whole of what you need to do.</p>',
    )}
  </div>`;

  return page({
    title: `Connect ${grant.productName}`,
    description: 'Confirm that this app may use your Nova Account.',
    path: '/account/device',
    noindex: true,
    account,
    hero: hero({
      eyebrow: 'Nova Account',
      title: 'Connect this app?',
      lede: 'Check that this is the app in front of you.',
    }),
    main,
  });
}
