/**
 * Sending mail — the seam, and the two messages Nova Accounts needs to send.
 *
 * THIS IS THE FIRST THING IN NOVA.HELP THAT SENDS MAIL, and several comments elsewhere in this
 * codebase say plainly that nothing does. Those comments are about what a Nova Account's
 * `emailVerified` flag may be trusted to mean and about why a provider identity is never
 * matched on an address; adding a reset flow does not change either of them, and the reasoning
 * in service.mjs is unchanged and still correct. What changes is that there is now one
 * outbound message, and therefore a seam it goes through.
 *
 * A TRANSPORT IS `{ send({ to, subject, text }) }` AND NOTHING MORE. It is injected into
 * `createAccounts`, never imported, because server/accounts/ may not reach outside itself and
 * because the transport is a deployment's choice: Cloudflare Email Sending on Workers, an SMTP
 * relay under Node, a captured array in a test. Nothing above this file knows which.
 *
 * ⚠ WITHOUT A CONFIGURED TRANSPORT, PASSWORD RESET DOES NOT WORK. It fails in the safest
 * direction — the page still says the same neutral thing it says for an address with no
 * account, so nothing is disclosed — but no mail leaves the building and nobody can reset
 * anything. `createNullMailer` therefore logs loudly every single time, and app.mjs warns once
 * at boot. This is stated here rather than discovered from a support ticket about support.
 *
 * A FAILED SEND IS NOT AN ERROR THE VISITOR SEES. If the transport throws, the request still
 * answers exactly as it would have; the failure is logged. The alternative is a 500 that tells
 * a stranger their address is one we tried to send to, which is the enumeration hole the whole
 * flow is arranged to avoid.
 */

/**
 * A transport that sends nothing and says so, every time.
 *
 * The default, so that a deployment which has not configured mail is obvious in its logs from
 * the first reset request rather than silently broken.
 */
export function createNullMailer({ logger = console } = {}) {
  return {
    configured: false,
    async send(message) {
      logger.warn?.(
        `[nova.accounts] NO MAIL TRANSPORT CONFIGURED — dropping "${message.subject}" addressed to a ` +
          'Nova Account. Password reset cannot work until one is set. See docs/PASSWORD-RESET.md.',
      );
      return { ok: false, reason: 'no-transport' };
    },
  };
}

/**
 * A transport that writes the whole message to the log, for local development.
 *
 * It prints the reset link, which is the only way to complete the flow on a machine with no
 * mail. That is a development convenience and a production disaster, so it announces itself,
 * and app.mjs will not select it when NODE_ENV is production.
 */
export function createLogMailer({ logger = console } = {}) {
  return {
    configured: true,
    async send({ to, subject, text }) {
      logger.warn?.(
        `\n[nova.accounts] ── DEVELOPMENT MAIL ─────────────────────────────────────────\n` +
          `To:      ${to}\nSubject: ${subject}\n\n${text}\n` +
          `[nova.accounts] ────────────────────────────────────────────────────────────\n`,
      );
      return { ok: true };
    },
  };
}

/**
 * A transport that keeps messages in an array. For tests, and for nothing else — it is here
 * rather than in the test directory so that the shape a transport must have is defined once,
 * beside the interface it implements.
 */
export function createMemoryMailer() {
  const sent = [];
  return {
    configured: true,
    sent,
    async send(message) {
      sent.push({ ...message, at: new Date().toISOString() });
      return { ok: true };
    },
  };
}

/* ── The messages ────────────────────────────────────────────────────────────────────────
 *
 * Plain text, and short. Two rules they both follow:
 *
 *   - THEY NAME THE PRODUCT AND THE ACTION, and never the account's own details. A reset mail
 *     that quotes back a display name or a ticket is a reset mail that leaks to whoever ended
 *     up with the address by mistake.
 *   - THEY TELL SOMEBODY WHO DID NOT ASK WHAT TO DO. For the reset mail that is "ignore this";
 *     for the changed mail it is "this was not you, act now", because by then it matters.
 */

/** The mail carrying the reset link. */
export const passwordResetMessage = ({ to, link, ttlMinutes, productName = 'Nova' }) => ({
  to,
  subject: `Reset your ${productName} Account password`,
  text: [
    `Somebody asked to reset the password for the ${productName} Account at ${to}.`,
    '',
    'To choose a new one, open this link:',
    link,
    '',
    `The link works once and expires in ${ttlMinutes} minutes.`,
    '',
    'If you did not ask for this, you can ignore this message — your password has not',
    'changed and nobody has been given access to your account. The link expires on its own.',
  ].join('\n'),
});

/**
 * The mail sent after a password actually changes.
 *
 * This is the one that matters for somebody whose address was taken over: it is the moment
 * they find out, so it says what happened, when, and what to do about it.
 */
export const passwordChangedMessage = ({ to, at, productName = 'Nova', supportUrl = null }) => ({
  to,
  subject: `Your ${productName} Account password was changed`,
  text: [
    `The password for the ${productName} Account at ${to} was changed on ${at}.`,
    '',
    'Everything that was signed in has been signed out, on every device.',
    '',
    'If this was you, there is nothing to do.',
    '',
    'If it was NOT you, somebody has access to this email address. Reset the password again',
    'straight away to lock them out, and secure the mailbox itself.',
    ...(supportUrl ? ['', `Get help: ${supportUrl}`] : []),
  ].join('\n'),
});
