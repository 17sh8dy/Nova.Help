/**
 * The document shell.
 *
 * Every page goes through `page()`, so a metadata or accessibility rule added here applies
 * everywhere at once. Three things in here are load-bearing:
 *
 * 1. THE SKIP LINK IS THE FIRST FOCUSABLE ELEMENT. A support portal is navigated by keyboard
 *    more than most sites, because people arrive at it frustrated and in a hurry.
 *
 * 2. THE SCRIPT IS DEFERRED AND OPTIONAL. Nothing on this site requires it: the guided flow
 *    is links, the form is a form post. The script adds counters and file previews.
 *
 * 3. THE PAGE DECLARES ITS OWN TITLE AND DESCRIPTION. Support pages get shared into chat
 *    windows and bug trackers constantly; a page whose title is just the site name is useless
 *    in a list of twenty open tabs.
 *
 * 4. THE ACCOUNT CONTROL IS PASSED IN, NOT LOOKED UP. `page()` renders whatever `account` it
 *    is handed and never resolves a session itself, so a page cannot accidentally become
 *    request-aware and no template can read an account it was not given.
 */
import { site, nav, footerLinks } from '../../data/site.js';
import { esc, icon } from './components.mjs';

/**
 * The Nova Nexus mark.
 *
 * One blade, drawn once and rotated 120° and 240° — the mark is exactly three-fold
 * symmetric, so writing it three times would be three chances to typo it. The geometry is
 * the artwork's own (`nova-nexus-*-v2.svg`), untouched.
 *
 * NO `fill` IS SET HERE, on purpose. `fill` inherits in SVG, so the paths take the colour of
 * the `.mark` rule in help.css — `var(--brand)`. That keeps the mark the same violet as every
 * button, badge and focus ring on the site rather than introducing a second, nearly-identical
 * one, and it means a brand-colour change is still a one-token edit. The artwork's own
 * monochrome variants (#0A0810 for light backgrounds, #7B5FBE for dark) are the right choice
 * on somebody else's page; on this one the token is.
 *
 * THE viewBox IS THE MARK'S BOUNDING BOX, NOT ITS ROTATION CENTRE. A trefoil with one blade up
 * and two down reaches 82 units above the origin and only 43 below it, so centring on the
 * origin would hang the mark visibly low beside the wordmark. `-80 -100 160 160` centres the
 * ink instead.
 */
const BLADE = 'M -2,-82 C 20,-62 26,-26 8,-8 C 4,-8 1,-9 0,-9 C -4,-11 -18,-40 -2,-82 Z';

const MARK = `<svg class="mark" viewBox="-80 -100 160 160" aria-hidden="true" focusable="false"><path d="${BLADE}"/><path d="${BLADE}" transform="rotate(120)"/><path d="${BLADE}" transform="rotate(240)"/></svg>`;

/**
 * The account control, at the right-hand end of the masthead beside "Check a ticket".
 *
 * Signed out it is one link, worded as an offer rather than a gate — nothing on this site
 * requires an account, and the header is the first place that promise is either kept or
 * broken. Signed in it is the person's own name, which doubles as the way to their tickets.
 *
 * It is hidden on the account pages themselves, where a "Sign in" link would point at the
 * page you are already reading.
 */
function accountControl(account, currentPath) {
  if (currentPath.startsWith('/account')) return '';

  if (account) {
    const label = account.displayName || account.email;
    const initial = String(label).trim().charAt(0).toUpperCase() || '?';
    return `<a class="account-chip" href="/account" aria-label="Your Nova Account — signed in as ${esc(account.email)}">
      <span class="account-chip__avatar" aria-hidden="true">${esc(initial)}</span>
      <span class="account-chip__text">${esc(label)}</span>
    </a>`;
  }

  const next = encodeURIComponent(currentPath || '/');
  return `<a class="account-chip account-chip--guest" href="/account/sign-in?next=${esc(next)}">
    ${icon('user', { size: 17 })}<span class="account-chip__text">Sign in</span>
  </a>`;
}

function header(currentPath, account) {
  const links = nav
    .map((item) => {
      const current = item.href === '/' ? currentPath === '/' : currentPath.startsWith(item.href);
      return `<a href="${esc(item.href)}"${current ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`;
    })
    .join('');

  return `<header class="masthead">
    <div class="wrap masthead__inner">
      <a class="wordmark" href="/" aria-label="${esc(site.name)} — home">
        ${MARK}
        <span class="wordmark__text">Nova<span class="wordmark__dot">.</span>Help</span>
      </a>
      <div class="masthead__end">
        <nav class="masthead__nav" aria-label="Primary">${links}</nav>
        ${accountControl(account, currentPath)}
      </div>
    </div>
  </header>`;
}

function footer() {
  const links = footerLinks
    .map((item) => `<a href="${esc(item.href)}">${esc(item.label)}</a>`)
    .join('');
  return `<footer class="footer">
    <div class="wrap footer__inner">
      <p class="footer__note">${esc(site.name)} — ${esc(site.tagline)}.</p>
      <nav class="footer__links" aria-label="Footer">${links}</nav>
    </div>
  </footer>`;
}

/**
 * Build a page.
 *
 * `hero` renders inside the header band; `main` is the page body. Both are HTML strings that
 * their callers have already escaped.
 */
export function page({
  title,
  description = site.description,
  path = '/',
  main,
  hero = '',
  noindex = false,
  bodyClass = '',
  account = null,
}) {
  const fullTitle = title ? `${title} — ${site.name}` : `${site.name} — ${site.tagline}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}" />
${noindex ? '<meta name="robots" content="noindex, nofollow" />' : ''}
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#0A0C13" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${esc(site.name)}" />
<meta property="og:title" content="${esc(fullTitle)}" />
<meta property="og:description" content="${esc(description)}" />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/assets/help.css" />
<script src="/assets/help.js" defer></script>
</head>
<body class="${esc(bodyClass)}">
<a class="skip-link" href="#main">Skip to content</a>
${header(path, account)}
${hero}
<main id="main" class="main" tabindex="-1">${main}</main>
${footer()}
</body>
</html>`;
}

/** The heading band at the top of a page. Kept here so every page's top edge is identical. */
export function hero({ eyebrow, title, lede, aside = '', crumbs = '', steps = '' }) {
  return `<section class="hero">
    <div class="wrap">
      ${crumbs}
      ${steps}
      <div class="hero__inner">
        <div class="hero__text">
          ${eyebrow ? `<p class="eyebrow">${icon('ticket', { size: 15 })}${esc(eyebrow)}</p>` : ''}
          <h1 class="hero__title">${esc(title)}</h1>
          ${lede ? `<p class="hero__lede">${esc(lede)}</p>` : ''}
        </div>
        ${aside ? `<div class="hero__aside">${aside}</div>` : ''}
      </div>
    </div>
  </section>`;
}
