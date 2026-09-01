/**
 * How Nova.Help handles what you send it.
 *
 * This page describes what the code in this repository actually does, and nothing else. If a
 * behaviour changes — analytics added, mail sent, an assistant reading tickets — this page
 * changes in the same commit. It is not a legal privacy policy for the Nova group; it is an
 * accurate description of one system, which is the part that is usually missing.
 */
import { site } from '../../../data/site.js';
import { ATTACHMENT_LIMITS, humanSize } from '../../core/attachments.mjs';
import { PASS_TTL_SECONDS } from '../../lib/access.mjs';
import { SESSION_TTL_SECONDS } from '../../accounts/index.mjs';
import { page, hero } from '../layout.mjs';
import { esc, icon } from '../components.mjs';

const days = Math.round(PASS_TTL_SECONDS / 86400);
const sessionDays = Math.round(SESSION_TTL_SECONDS / 86400);

export function privacyPage({ account = null } = {}) {
  const main = `<section class="section">
    <div class="wrap narrow prose">
      <div class="card">
        <h2 class="card__title">${icon('shield', { size: 20 })} What we store</h2>
        <ul class="bullets">
          <li>The ticket you write: product, area, issue, summary, description and severity.</li>
          <li>Your email address, and your name if you give one. The address is how we reply, and how you open the ticket again.</li>
          <li>Any files you attach, up to ${esc(humanSize(ATTACHMENT_LIMITS.maxBytesPerFile))} each.</li>
          <li>The platform and version you tell us about, when you fill those in.</li>
          <li>Every reply and status change, as a history on the ticket.</li>
          <li>The IP address a ticket was submitted from, to limit abuse of the form.</li>
        </ul>
      </div>

      <div class="card">
        <h2 class="card__title">${icon('key', { size: 20 })} How a ticket stays private</h2>
        <p class="card__body">
          Ticket IDs are random rather than sequential, so one ID reveals nothing about any
          other. Opening a ticket needs both the ID and the email address it was filed with.
          When you do, this site sets a cookie holding a signed pass for that single ticket,
          valid for ${esc(days)} days. It is not shared with anyone, and it grants access to
          nothing else — not to another ticket, and not to a Nova Account. Signing in sets a
          second cookie; those two are the only cookies this site sets.
        </p>
      </div>

      <div class="card">
        <h2 class="card__title">${icon('user', { size: 20 })} If you make a Nova Account</h2>
        <p class="card__body">
          An account is optional — every part of this site works without one. If you make one,
          we store the email address you gave, the name if you gave one, and your password as a
          slow one-way hash (scrypt, with a per-password salt). The password itself is never
          stored, never logged, and cannot be recovered from what we keep; nobody at Nova can
          read it, and nobody will ever ask you for it.
        </p>
        <p class="card__body">
          Signing in sets a second cookie holding a signed session token, for ${esc(sessionDays)}
          days. Signing out ends that session on the server as well as in your browser, so a
          copy of the cookie taken beforehand stops working immediately.
        </p>
        <ul class="bullets">
          <li>Tickets you file while signed in are linked to your account, and listed on it.</li>
          <li>Tickets you filed as a guest stay guest tickets. They are not attached to an account that happens to use the same address, because that address has not been verified — this site sends no mail.</li>
          <li>Your account is not shared with anyone. It is intended to work across other Nova products in future; nothing else uses it today.</li>
        </ul>
      </div>

      <div class="card">
        <h2 class="card__title">${icon('info', { size: 20 })} What we do not do</h2>
        <ul class="bullets">
          <li>No analytics, no tracking pixels, no advertising, and no third-party scripts. Every asset on this site is served from this site.</li>
          <li>Nothing you write is published, and no ticket page is indexed by search engines.</li>
          <li>We do not sell or share ticket contents.</li>
          <li>No automated assistant reads or answers tickets today. If that changes, this page says so before it ships, and decisions about accounts, security, payments and legal requests will still be made by a person.</li>
        </ul>
      </div>

      <div class="card">
        <h2 class="card__title">${icon('alert', { size: 20 })} Please do not send</h2>
        <p class="card__body">
          Passwords, recovery codes, payment card numbers, or anyone else's personal
          information. Support will never ask for them. If you have already sent one, tell us
          in the ticket and change the credential.
        </p>
      </div>

      <div class="card card--quiet">
        <h2 class="card__title">Asking for your data back</h2>
        <p class="card__body">
          Open a ticket under ${esc(site.name === 'Nova.Help' ? 'Nova Site → Legal & privacy' : 'Legal & privacy')}
          and say what you want exported or deleted. Those requests are handled by a person.
        </p>
      </div>
    </div>
  </section>`;

  return page({
    account,
    title: 'How we use your data',
    description: 'What Nova.Help stores when you open a support ticket, and what it does not do.',
    path: '/privacy',
    hero: hero({
      eyebrow: 'Nova.Help',
      title: 'How we use your data',
      lede: 'A plain description of what this support portal stores, and what it never does with it.',
    }),
    main,
  });
}
