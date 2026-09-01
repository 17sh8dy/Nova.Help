/**
 * The entry point: read the environment, build the app, bind the port.
 *
 * Nothing else in the codebase reads process.env, so the whole configuration surface of
 * Nova.Help is the table below.
 *
 *   PORT                  default 4400
 *   HOST                  default 127.0.0.1 — bind 0.0.0.0 explicitly to expose it
 *   NOVA_HELP_DATA        where tickets and attachments live; default ./var
 *   NOVA_HELP_SECRET      key for signing ticket passes; generated into ./var/secret if unset
 *   NOVA_HELP_TRUST_PROXY set when running behind a reverse proxy, so client IPs are real
 *   NOVA_HELP_ORIGIN      public origin, e.g. https://nova.help; used to build OAuth redirects
 *   NOVA_GOOGLE_CLIENT_ID     )  both must be set for "Continue with Google" to appear at all.
 *   NOVA_GOOGLE_SECRET        )  Unset, Nova.Help runs on email and password exactly as before.
 *   NODE_ENV              'production' turns on secure cookies and asset caching
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const port = Number(process.env.PORT ?? 4400);
const host = process.env.HOST ?? '127.0.0.1';
const dev = process.env.NODE_ENV !== 'production';
const dataDir = process.env.NOVA_HELP_DATA
  ? path.resolve(process.env.NOVA_HELP_DATA)
  : path.join(repoRoot, 'var');

const app = await createApp({
  dataDir,
  dev,
  trustProxy: process.env.NOVA_HELP_TRUST_PROXY === '1',
  origin: process.env.NOVA_HELP_ORIGIN ?? null,
  oauth: {
    ...(process.env.NOVA_GOOGLE_CLIENT_ID || process.env.NOVA_GOOGLE_SECRET
      ? {
          google: {
            clientId: process.env.NOVA_GOOGLE_CLIENT_ID,
            clientSecret: process.env.NOVA_GOOGLE_SECRET,
          },
        }
      : {}),
  },
});

const server = http.createServer((req, res) => {
  app.handle(req, res).catch((error) => {
    // createApp already handles route failures; reaching here means the handler itself broke.
    console.error('[nova.help] unhandled', error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal error');
  });
});

// Headers are small and always ours; a slow-header client should not hold a socket forever.
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;

server.listen(port, host, () => {
  const { loaded } = app;
  console.log(`[nova.help] listening on http://${host}:${port}`);
  console.log(`[nova.help] data in ${dataDir} — ${loaded.loaded} ticket(s) loaded${loaded.broken ? `, ${loaded.broken} unreadable` : ''}`);
  if (dev) console.log('[nova.help] development mode: assets are re-read on every request');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[nova.help] ${signal} — closing`);
    server.close(() => process.exit(0));
    // Tickets are written before their response is sent, so a hard exit loses nothing.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
