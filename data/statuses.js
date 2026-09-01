/**
 * Ticket statuses.
 *
 * `tone` maps to the palette (neutral / progress / attention / good / muted) rather than to a
 * colour, so restyling never means editing this file. `terminal` marks a status a ticket does
 * not leave on its own. `awaitsUser` marks the one status where the ball is in the reporter's
 * court — the ticket list and the reply box both key off it rather than off the id.
 */
export const statuses = [
  {
    id: 'open',
    label: 'Open',
    tone: 'progress',
    description: 'Received and waiting to be picked up.',
    terminal: false,
    awaitsUser: false,
  },
  {
    id: 'in_progress',
    label: 'In Progress',
    tone: 'progress',
    description: 'Someone is actively working on it.',
    terminal: false,
    awaitsUser: false,
  },
  {
    id: 'waiting_user',
    label: 'Waiting for User',
    tone: 'attention',
    description: 'We need something from you before we can continue.',
    terminal: false,
    awaitsUser: true,
  },
  {
    id: 'resolved',
    label: 'Resolved',
    tone: 'good',
    description: 'We believe this is fixed. Reply if it is not.',
    terminal: false,
    awaitsUser: false,
  },
  {
    id: 'closed',
    label: 'Closed',
    tone: 'muted',
    description: 'No further action is planned.',
    terminal: true,
    awaitsUser: false,
  },
];

/** The status every new ticket starts in. */
export const DEFAULT_STATUS = 'open';

/**
 * Allowed transitions. The service layer refuses anything not listed here, so a future staff
 * console — or the future AI — cannot walk a ticket into a state the UI has no words for.
 */
export const transitions = {
  open: ['in_progress', 'waiting_user', 'resolved', 'closed'],
  in_progress: ['waiting_user', 'resolved', 'closed', 'open'],
  waiting_user: ['in_progress', 'open', 'resolved', 'closed'],
  resolved: ['closed', 'in_progress', 'open'],
  closed: ['open'],
};
