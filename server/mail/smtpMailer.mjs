/**
 * A real SMTP transport — the `{ send({ to, subject, text }) }` shape every mailer in this
 * codebase implements (see packages/nova-accounts/mail.mjs), backed by an actual SMTP
 * connection instead of a log line. One connection per message, STARTTLS, AUTH LOGIN. No
 * dependency: `node:net` and `node:tls` are enough for the handful of commands a plain text
 * email needs, and this codebase's rule elsewhere (packages/nova-account-client is "zero
 * dependencies") is worth keeping here too rather than pulling in a mail library for four verbs.
 *
 * BUILT FOR GMAIL FIRST, because that is what Nova.Help needs sending support-ticket
 * notifications right now: host defaults to smtp.gmail.com:587, and the From address defaults
 * to the authenticated user (Gmail requires the two to match, or to be an alias of the account).
 * Any STARTTLS/AUTH LOGIN server works the same way — override `host`/`port` for one.
 *
 * ⚠ A GMAIL ACCOUNT NEEDS AN APP PASSWORD HERE, NOT ITS LOGIN PASSWORD. Google has not accepted
 * a regular account password for SMTP since 2022's "less secure apps" removal on any account
 * with 2-Step Verification (which is required to even generate an app password). Create one at
 * myaccount.google.com/apppasswords and use that 16-character value as `pass`.
 *
 * NODE ONLY. This uses `node:net`/`node:tls`, which is not available the same way inside a
 * Cloudflare Worker — the Worker deployment (server/worker.mjs) does not wire this in, and mail
 * there remains unconfigured (see app.mjs's existing password-reset comment) until Cloudflare
 * Email Sending or an HTTP-based provider is chosen for that runtime specifically.
 */
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const CRLF = '\r\n';

/** Read SMTP responses line by line, resolving once a reply's LAST line (no `-` after the code) arrives. */
function readerFor(socket) {
  let buffer = '';
  const waiters = [];

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      const isFinal = /^\d{3}(?!-)/.test(line);
      if (isFinal && waiters.length) waiters.shift().resolve(line);
    }
  });
  socket.on('error', (error) => {
    while (waiters.length) waiters.shift().reject(error);
  });
  socket.on('close', () => {
    while (waiters.length) waiters.shift().reject(new Error('SMTP connection closed'));
  });

  return {
    /** The next final reply line, e.g. "250 OK" (the caller checks the leading status code). */
    next: () => new Promise((resolve, reject) => waiters.push({ resolve, reject })),
  };
}

const send = (socket, line) => socket.write(line + CRLF);

async function command(socket, reader, line, expect = '2') {
  send(socket, line);
  const reply = await reader.next();
  if (!reply.startsWith(expect)) throw new Error(`SMTP command failed — sent "${line.split(' ')[0]}", got "${reply}"`);
  return reply;
}

/** Dot-stuff lines that start with '.', per RFC 5321 — otherwise the server reads it as end-of-data. */
export const dotStuff = (text) => text.split(/\r\n|\n/).map((line) => (line.startsWith('.') ? `.${line}` : line)).join(CRLF);

export function createSmtpMailer({ host = 'smtp.gmail.com', port = 587, user, pass, from = user, logger = console } = {}) {
  if (!user || !pass) {
    throw new Error('createSmtpMailer needs both user and pass — an SMTP account and an app password, not a shared/unauthenticated relay.');
  }

  return {
    configured: true,
    async send({ to, subject, text }) {
      const socket = tcpConnect({ host, port });
      try {
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });

        let reader = readerFor(socket);
        const greeting = await reader.next();
        if (!greeting.startsWith('2')) throw new Error(`SMTP server refused the connection: "${greeting}"`);

        await command(socket, reader, `EHLO ${host}`);
        await command(socket, reader, 'STARTTLS');

        // Upgrade the same TCP stream to TLS. Nothing already buffered survives the swap — the
        // handshake above is required to be plaintext, and everything after is required not to
        // be, which is the whole point of STARTTLS existing as two steps rather than one.
        const secure = await new Promise((resolve, reject) => {
          const tlsSocket = tlsConnect({ socket, servername: host }, () => resolve(tlsSocket));
          tlsSocket.once('error', reject);
        });
        reader = readerFor(secure);

        await command(secure, reader, `EHLO ${host}`);
        // AUTH LOGIN is a three-step dance: 334 asks for the base64 username, another 334 asks
        // for the base64 password, and only the LAST reply is a 2xx-family code (235).
        await command(secure, reader, 'AUTH LOGIN', '3');
        await command(secure, reader, Buffer.from(user, 'utf8').toString('base64'), '3');
        await command(secure, reader, Buffer.from(pass, 'utf8').toString('base64'), '235');

        await command(secure, reader, `MAIL FROM:<${from}>`);
        await command(secure, reader, `RCPT TO:<${to}>`);
        await command(secure, reader, 'DATA', '3');

        const message = [
          `From: ${from}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          dotStuff(text),
          '.',
        ].join(CRLF);
        await command(secure, reader, message);

        await command(secure, reader, 'QUIT', '2').catch(() => {}); // best-effort; the send already succeeded
        secure.end();
        return { ok: true };
      } catch (error) {
        logger.error?.('[nova.help] SMTP send failed', error);
        return { ok: false, reason: 'send-failed', error };
      } finally {
        socket.destroy();
      }
    },
  };
}
