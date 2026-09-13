/**
 * The one outbound message tickets.mjs sends: a plain-text staff notification for a newly
 * filed ticket. Kept separate from tickets.mjs itself so the message shape can be tested
 * without touching the store, and separate from packages/nova-accounts/mail.mjs because it is
 * a ticket concern, not an account one — the two message builders share a transport interface
 * (`{ send({ to, subject, text }) }`), never a file.
 *
 * NEVER THE ONLY RECORD. This mail exists so a human notices a new ticket quickly; the ticket
 * itself is already durably saved by store.create() before this is ever built (see
 * tickets.mjs's create()). Losing this message loses a notification, not the report.
 */

/** en-GB-ish "Sept. 13, 2026" — short, unambiguous, and matches how the ticket portal itself dates things. */
const formatDate = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).replace(/^(\w{3})\w* /, '$1. ');

export function ticketCreatedMessage({ to, ticket, projectLabel, categoryLabel, issueTypeLabel }) {
  const lines = [
    `Category: ${categoryLabel ?? ticket.category}${issueTypeLabel ? ` — ${issueTypeLabel}` : ''}`,
    `Project: ${projectLabel ?? ticket.project}`,
    `User: ${ticket.requester.email}${ticket.accountId ? ` (Nova Account ${ticket.accountId})` : ' (guest — no Nova Account)'}`,
    `Priority: ${ticket.priority}`,
    '',
    `Subject: ${ticket.subject}`,
    '',
    ticket.description,
    '',
    `Submitted: ${formatDate(ticket.createdAt)}`,
    `Ticket ID: ${ticket.id}`,
  ];

  return {
    to,
    subject: `New Nova.Help ticket ${ticket.id}: ${ticket.subject}`,
    text: lines.join('\n'),
  };
}
