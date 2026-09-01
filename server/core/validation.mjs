/**
 * Validation for everything a reporter submits.
 *
 * The rules live here rather than in the route so that the HTML form, the JSON API and any
 * future assistant filing on someone's behalf all get the same answer. The result carries
 * BOTH the errors and the cleaned values, because the form has to be re-rendered with what
 * the person typed still in it — losing a 600-word description to a missing email address is
 * the single most common way a support form loses a ticket.
 *
 * Errors are keyed by field name and phrased as instructions, not accusations.
 */
import { getIssueType, getPriority, getProject, getCategory, DEFAULT_PRIORITY } from './catalog.mjs';

export const LIMITS = {
  subject: { min: 5, max: 120 },
  description: { min: 20, max: 8000 },
  name: { max: 80 },
  email: { max: 254 },
  version: { max: 60 },
  platform: { max: 60 },
  reply: { min: 2, max: 8000 },
};

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const collapse = (v) => str(v).replace(/\s+/g, ' ');

/**
 * Deliberately permissive: one @, something either side, a dot in the domain. Anything
 * stricter rejects real addresses, and the only real test of an address is sending to it.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export const isEmail = (value) => EMAIL.test(str(value)) && str(value).length <= LIMITS.email.max;

/**
 * Validate a new ticket.
 *
 * `input` is the raw field bag from a form or a JSON body. Returns
 * `{ ok, values, errors }` — `values` is always populated, even when `ok` is false.
 */
export function validateTicketInput(input = {}) {
  const errors = {};

  const values = {
    project: str(input.project),
    category: str(input.category),
    issueType: str(input.issueType),
    subject: collapse(input.subject),
    description: str(input.description).replace(/\r\n/g, '\n'),
    priority: str(input.priority),
    name: collapse(input.name),
    email: str(input.email).toLowerCase(),
    platform: collapse(input.platform),
    appVersion: collapse(input.appVersion),
  };

  /* Selection. A ticket filed against a product that does not exist is unroutable, so these
     are hard failures rather than "we will sort it out later". */
  const project = getProject(values.project);
  if (!values.project) errors.project = 'Choose which Nova product this is about.';
  else if (!project) errors.project = 'That product is not one we support here.';

  const category = project ? getCategory(project.id, values.category) : undefined;
  if (project) {
    if (!values.category) errors.category = 'Choose a category.';
    else if (!category) errors.category = `That category does not exist in ${project.name}.`;
  }

  const issueType = category ? getIssueType(project.id, category.id, values.issueType) : undefined;
  if (category) {
    if (!values.issueType) errors.issueType = 'Choose the issue that fits best.';
    else if (!issueType) errors.issueType = `That issue type does not exist in ${category.label}.`;
  }

  /* Subject and description. */
  if (!values.subject) errors.subject = 'Give your ticket a one-line summary.';
  else if (values.subject.length < LIMITS.subject.min)
    errors.subject = `Please write at least ${LIMITS.subject.min} characters.`;
  else if (values.subject.length > LIMITS.subject.max)
    errors.subject = `Please keep the summary under ${LIMITS.subject.max} characters.`;

  if (!values.description) errors.description = 'Describe what happened.';
  else if (values.description.length < LIMITS.description.min)
    errors.description = `Please give us at least ${LIMITS.description.min} characters to work with.`;
  else if (values.description.length > LIMITS.description.max)
    errors.description = `That is longer than ${LIMITS.description.max} characters. Attach a file instead.`;

  /* Contact. The email address is how the ticket is reached again, so it is required even
     though nothing here sends mail yet — a ticket nobody can open again is a dead ticket. */
  if (!values.email) errors.email = 'We need an email address to reach you about this.';
  else if (!isEmail(values.email)) errors.email = 'That does not look like an email address.';

  if (values.name.length > LIMITS.name.max) errors.name = 'Please use a shorter name.';

  /* Severity. An issue type that pins its priority ignores whatever was submitted, so a
     tampered form cannot promote a feature request to urgent. */
  if (issueType) {
    if (issueType.priorityMode === 'fixed') {
      values.priority = issueType.priority;
    } else if (!values.priority) {
      values.priority = issueType.priority ?? DEFAULT_PRIORITY;
    } else if (!getPriority(values.priority)) {
      errors.priority = 'Choose one of the listed severities.';
    }
  } else if (values.priority && !getPriority(values.priority)) {
    errors.priority = 'Choose one of the listed severities.';
  }

  /* Environment. Optional everywhere, and only collected where the project asks for it. */
  if (project && !project.environment.collect) {
    values.platform = '';
    values.appVersion = '';
  }
  if (values.platform.length > LIMITS.platform.max) errors.platform = 'Please use a shorter value.';
  if (values.appVersion.length > LIMITS.version.max) errors.appVersion = 'Please use a shorter value.';

  return { ok: Object.keys(errors).length === 0, values, errors, project, category, issueType };
}

/** Validate a reply added to an existing ticket by the reporter. */
export function validateReplyInput(input = {}) {
  const errors = {};
  const values = { body: str(input.body).replace(/\r\n/g, '\n') };

  if (!values.body) errors.body = 'Write your reply before sending it.';
  else if (values.body.length < LIMITS.reply.min) errors.body = 'That reply is too short to send.';
  else if (values.body.length > LIMITS.reply.max)
    errors.body = `Replies are limited to ${LIMITS.reply.max} characters.`;

  return { ok: Object.keys(errors).length === 0, values, errors };
}

/** Validate the ticket lookup form: an id and the email address the ticket was filed with. */
export function validateLookupInput(input = {}) {
  const errors = {};
  const values = { ticketId: str(input.ticketId), email: str(input.email).toLowerCase() };

  if (!values.ticketId) errors.ticketId = 'Enter the ticket ID from your confirmation.';
  if (!values.email) errors.email = 'Enter the email address you used.';
  else if (!isEmail(values.email)) errors.email = 'That does not look like an email address.';

  return { ok: Object.keys(errors).length === 0, values, errors };
}
