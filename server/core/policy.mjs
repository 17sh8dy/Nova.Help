/**
 * Support policy — the rules that decide who is allowed to act on a ticket.
 *
 * This module exists now, before there is any assistant, because the guarantee it encodes is
 * the one that is expensive to add later: some decisions are never made by software.
 *
 * A ticket is HUMAN-ONLY when its issue type is marked `sensitive` in the catalog, or when it
 * arrives at urgent severity. Account ownership and recovery, suspensions, security reports,
 * payments and legal requests are all marked sensitive in data/shared.js and the project
 * files, so the set is edited as data rather than as a condition buried in a route.
 *
 * WHAT THE FUTURE ASSISTANT MUST DO WITH THIS. When retrieval and drafting are added, they go
 * through `assistantScope(ticket)`:
 *
 *   - `suggest: false` means do not offer an answer at all, not even a cautious one. The
 *     reporter is told a person will handle it, and that is the whole interaction.
 *   - `autoRespond` is false everywhere in this version by design. Nothing here promises a
 *     reply written without a person reading it.
 *   - `mayDraftInternal` allows a summary or a suggested category that a human reads before
 *     acting. That is the only automated writing this policy contemplates.
 *
 * The flags are computed from the ticket, so a ticket reclassified into a sensitive category
 * later becomes human-only at that moment without anything having to remember to re-run.
 */
import { getIssueType } from './catalog.mjs';

/** Severities that pull a ticket onto the human path regardless of category. */
const ALWAYS_HUMAN_PRIORITIES = new Set(['urgent']);

/** Why a ticket is human-only, in words a reporter can read. */
const REASONS = {
  sensitive:
    'This kind of request affects account ownership, security, payments or legal rights, so it is always reviewed by a person.',
  urgent: 'You marked this urgent, so it goes to a person rather than to any automated triage.',
};

/**
 * Classify a ticket (or a selection about to become one).
 * Accepts either a stored ticket or a plain `{ project, category, issueType, priority }`.
 */
export function classify(subject) {
  const issueType = getIssueType(subject.project, subject.category, subject.issueType);
  const sensitive = issueType?.sensitive === true;
  const urgent = ALWAYS_HUMAN_PRIORITIES.has(subject.priority);
  const humanOnly = sensitive || urgent;
  const reason = sensitive ? REASONS.sensitive : urgent ? REASONS.urgent : null;
  return { sensitive, humanOnly, reason };
}

/**
 * What an automated assistant is permitted to do with this ticket.
 * Every consumer of this must treat a missing flag as "not permitted".
 */
export function assistantScope(subject) {
  const { humanOnly, sensitive, reason } = classify(subject);
  return {
    /** May propose self-help content to the reporter. */
    suggest: !humanOnly,
    /** May classify into project / category / issue type as a suggestion. */
    mayClassify: true,
    /** May write an internal summary a human reads before acting. */
    mayDraftInternal: true,
    /** May reply to the reporter with no human in the loop. False in this version, always. */
    autoRespond: false,
    /** May change status, assignee or priority. Never. Those are human actions. */
    mayDecide: false,
    humanOnly,
    sensitive,
    reason,
  };
}

/** True when the ticket must be routed to a person on arrival. */
export const requiresHuman = (subject) => classify(subject).humanOnly;
