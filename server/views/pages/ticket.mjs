/**
 * The ticket page — what the reporter sees after filing, and every time they come back.
 *
 * It renders from `publicEvents()`, never from the raw event list, so an internal note added
 * by staff cannot appear here by omission. Statuses are rendered with their description
 * attached, because "Waiting for User" means nothing on its own and everything when it says
 * what it is waiting for.
 *
 * The confirmation state is this same page with a banner rather than a separate screen, so
 * the ticket ID is on a page the reporter can bookmark on the spot instead of a dead end they
 * have to navigate away from.
 */
import { getStatus, getPriority } from '../../core/catalog.mjs';
import { publicEvents } from '../../core/tickets.mjs';
import { humanSize, isImage } from '../../core/attachments.mjs';
import { LIMITS } from '../../core/validation.mjs';
import { site } from '../../../data/site.js';
import { page, hero } from '../layout.mjs';
import { badge, button, esc, escUrl, icon, notice, paragraphs, textArea } from '../components.mjs';

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) ? '' : dateFormat.format(date);
};

const timeTag = (iso) => `<time datetime="${esc(iso)}">${esc(when(iso))}</time>`;

/** Who an event came from, in the reporter's language rather than the schema's. */
function actorLabel(event, ticket) {
  if (event.actor?.kind === 'staff') return event.actor.name ?? 'Nova Support';
  if (event.actor?.kind === 'assistant') return 'Nova.Help assistant';
  if (event.actor?.kind === 'system') return 'Automatic';
  return ticket.requester?.name || 'You';
}

function eventItem(event, ticket) {
  if (event.type === 'status_changed') {
    const to = getStatus(event.meta?.to);
    return `<li class="event event--meta">
      <span class="event__dot" aria-hidden="true">${icon('arrow', { size: 14 })}</span>
      <p class="event__line">
        Status changed to ${badge(to?.label ?? event.meta?.to ?? 'unknown', to?.tone ?? 'neutral')}
        <span class="event__when">${timeTag(event.at)}</span>
      </p>
      ${event.body ? `<div class="event__body">${paragraphs(event.body)}</div>` : ''}
    </li>`;
  }

  const isStaff = event.actor?.kind === 'staff';
  const attachments = event.meta?.attachments?.length ?? 0;

  return `<li class="event ${isStaff ? 'event--staff' : 'event--user'}">
    <span class="event__dot" aria-hidden="true">${icon(isStaff ? 'nova' : 'dot', { size: 14 })}</span>
    <p class="event__line">
      <strong>${esc(actorLabel(event, ticket))}</strong>
      <span class="event__when">${timeTag(event.at)}</span>
    </p>
    <div class="event__body">${paragraphs(event.body)}</div>
    ${attachments ? `<p class="event__note">${icon('clip', { size: 14 })} ${attachments} attachment${attachments === 1 ? '' : 's'}</p>` : ''}
  </li>`;
}

function attachmentList(ticket) {
  if (!ticket.attachments?.length) return '';
  const items = ticket.attachments
    .map(
      (attachment) => `<li class="attachment">
      <span class="attachment__icon">${icon(isImage(attachment) ? 'grid' : 'clip', { size: 16 })}</span>
      <a class="attachment__name" href="/tickets/${escUrl(ticket.id)}/attachments/${escUrl(attachment.id)}">${esc(attachment.filename)}</a>
      <span class="attachment__size">${esc(humanSize(attachment.size))}</span>
    </li>`,
    )
    .join('');
  return `<section class="card" aria-labelledby="attachments-heading">
    <h2 class="card__title" id="attachments-heading">${icon('clip', { size: 18 })} Attachments</h2>
    <ul class="attachments">${items}</ul>
  </section>`;
}

function detailRow(label, value) {
  return value ? `<div class="details__row"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>` : '';
}

export function ticketPage({ ticket, created = false, replyError = null, replyValue = '', replySent = false, account = null }) {
  const status = ticket.statusRef ?? getStatus(ticket.status);
  const priority = getPriority(ticket.priority);
  const events = publicEvents(ticket);
  const canReply = ticket.status !== 'closed';

  const banner = created
    ? notice(
        'success',
        `Ticket ${ticket.id} has been created`,
        `<p>Save this ID — with your email address it is how you open this page again. ${esc(site.responseTarget)}</p>`,
      )
    : replySent
      ? notice('success', 'Your reply was added', '<p>It is at the bottom of the conversation.</p>')
      : '';

  const replyBlock = canReply
    ? `<section class="card" aria-labelledby="reply-heading">
        <h2 class="card__title" id="reply-heading">${icon('arrow', { size: 18 })} Add to this ticket</h2>
        <form method="post" action="/tickets/${escUrl(ticket.id)}/replies" novalidate>
          ${textArea({
            id: 'body',
            label: 'Your reply',
            hint: status?.awaitsUser
              ? 'We are waiting on you — answering here moves the ticket back to us.'
              : 'Anything you have found out since, or new information we asked for.',
            value: replyValue,
            error: replyError,
            required: true,
            rows: 6,
            maxLength: LIMITS.reply.max,
          })}
          <div class="form__actions">${button('Send reply', { type: 'submit', variant: 'primary' })}</div>
        </form>
      </section>`
    : notice(
        'info',
        'This ticket is closed',
        '<p>Closed tickets cannot take new replies. If the problem is back, please open a new ticket and mention this ID.</p>',
      );

  const main = `<section class="section">
    <div class="wrap layout">
      <div class="layout__main">
        ${banner}

        <section class="card" aria-labelledby="ticket-heading">
          <div class="ticket__head">
            <div>
              <p class="ticket__id">${esc(ticket.id)}</p>
              <h2 class="ticket__subject" id="ticket-heading">${esc(ticket.subject)}</h2>
            </div>
            ${badge(status?.label ?? ticket.status, status?.tone ?? 'neutral', { title: status?.description })}
          </div>
          ${status?.description ? `<p class="ticket__status-note">${esc(status.description)}</p>` : ''}
          <div class="ticket__body">${paragraphs(ticket.description)}</div>
        </section>

        ${attachmentList(ticket)}

        <section class="card" aria-labelledby="history-heading">
          <h2 class="card__title" id="history-heading">${icon('clock', { size: 18 })} History</h2>
          <ol class="events">${events.map((event) => eventItem(event, ticket)).join('')}</ol>
        </section>

        ${replyBlock}
      </div>

      <aside class="layout__aside" aria-label="Ticket details">
        <div class="card card--quiet">
          <h2 class="card__title">Details</h2>
          <dl class="details">
            ${detailRow('Product', ticket.labels.project)}
            ${detailRow('Area', ticket.labels.category)}
            ${detailRow('Issue', ticket.labels.issueType)}
            <div class="details__row">
              <dt>Severity</dt>
              <dd>${badge(priority?.label ?? ticket.priority, priority?.tone ?? 'neutral')}</dd>
            </div>
            <div class="details__row"><dt>Opened</dt><dd>${timeTag(ticket.createdAt)}</dd></div>
            <div class="details__row"><dt>Updated</dt><dd>${timeTag(ticket.updatedAt)}</dd></div>
            ${detailRow('Platform', ticket.environment?.platform)}
            ${detailRow('Version', ticket.environment?.appVersion)}
            ${detailRow('Contact', ticket.requester?.email)}
          </dl>
        </div>
        ${
          ticket.routing?.humanOnly
            ? `<div class="card card--quiet">
                <h2 class="card__title">${icon('shield', { size: 18 })} Handled by a person</h2>
                <p class="card__body">${esc(ticket.routing.reason ?? '')}</p>
              </div>`
            : ''
        }
        ${
          ticket.accountId
            ? `<div class="card card--quiet">
                <h2 class="card__title">${icon('user', { size: 18 })} On your Nova Account</h2>
                <p class="card__body">
                  This ticket is listed under <a href="/account">your account</a>. Sign in on any
                  device and it is there — you do not need to keep the ID
                  (<strong>${esc(ticket.id)}</strong>) to find it again.
                </p>
              </div>`
            : `<div class="card card--quiet">
                <h2 class="card__title">Keep this link</h2>
                <p class="card__body">
                  This page stays available on this device for two weeks. After that, open it again
                  from <a href="/tickets">Check a ticket</a> with ID <strong>${esc(ticket.id)}</strong>.
                </p>
              </div>`
        }
      </aside>
    </div>
  </section>`;

  return page({
    account,
    title: `${ticket.id} — ${ticket.subject}`,
    description: 'A Nova support ticket.',
    path: `/tickets/${ticket.id}`,
    noindex: true,
    hero: hero({
      eyebrow: 'Your ticket',
      title: ticket.labels.project,
      lede: `${ticket.labels.category} · ${ticket.labels.issueType}`,
    }),
    main,
  });
}
