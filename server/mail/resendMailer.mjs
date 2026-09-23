/**
 * A real mail transport for the Cloudflare Worker deployment — `server/mail/smtpMailer.mjs`'s
 * `node:net`/`node:tls` are not available inside a Worker isolate, and this deployment has no
 * verified domain for Cloudflare Email Sending (see wrangler.jsonc's own note on that), so
 * password reset and new-ticket notifications have sent nothing in production since either was
 * built — see docs/PASSWORD-RESET.md's own "provider like Resend/Postmark" note. This is that
 * provider: one HTTP POST per message, no dependency, `fetch` is all a Worker needs.
 *
 * Same `{ send({ to, subject, text }) }` shape every mailer in this codebase implements
 * (packages/nova-accounts/mail.mjs) — nothing above this file knows or cares which transport it
 * got.
 *
 * ⚠ NO VERIFIED SENDING DOMAIN YET. Without one, Resend only allows sending FROM
 * `onboarding@resend.dev` — fine for a low-volume internal notification landing in one person's
 * inbox (getnovasupport@gmail.com), not fine for anything that needs to look official to a
 * stranger. If nova.help (or any domain) is ever bought and verified with Resend, set `from` to
 * a real address on it and deliverability improves; until then this is the honest default.
 */

const RESEND_API = 'https://api.resend.com/emails';

export function createResendMailer({ apiKey, from = 'Nova.Help <onboarding@resend.dev>', fetchImpl = fetch, logger = console } = {}) {
  if (!apiKey) {
    throw new Error('createResendMailer needs an apiKey — a Resend API key, not a shared/unauthenticated relay.');
  }

  return {
    configured: true,
    async send({ to, subject, text }) {
      const response = await fetchImpl(RESEND_API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ from, to, subject, text }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Resend refused the message (${response.status}): ${body.slice(0, 300)}`);
      }

      const result = await response.json().catch(() => ({}));
      logger.info?.(`[nova.help] mail sent via Resend: "${subject}" -> ${to} (id ${result.id ?? 'unknown'})`);
      return { ok: true, id: result.id };
    },
  };
}
