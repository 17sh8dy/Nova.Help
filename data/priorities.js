/**
 * Severity levels offered on the ticket form.
 *
 * An issue type either lets the reporter choose (`priorityMode: 'ask'`) or pins the value
 * (`priority: '...'`), because asking someone to rate the severity of a feature request is
 * noise, and asking someone to rate a suspected account compromise invites them to under-rate
 * it. Both behaviours are declared in the catalog, never in the form code.
 */
export const priorities = [
  {
    id: 'low',
    label: 'Low',
    tone: 'muted',
    hint: 'A question, or something minor I can work around.',
  },
  {
    id: 'normal',
    label: 'Normal',
    tone: 'neutral',
    hint: 'Something is wrong but I can still use the product.',
  },
  {
    id: 'high',
    label: 'High',
    tone: 'attention',
    hint: 'A core feature is unusable, or I am losing work.',
  },
  {
    id: 'urgent',
    label: 'Urgent',
    tone: 'bad',
    hint: 'Security, data loss, or account access. Nothing else works.',
  },
];

export const DEFAULT_PRIORITY = 'normal';
