/**
 * The homepage: one question, and the products as answers.
 *
 * The question is the page. Everything else — the ticket lookup, what happens next — sits
 * below the grid, because someone arriving here already knows what is wrong and only needs to
 * say which product it is wrong in.
 *
 * The grid is generated from the catalog. Adding a product to data/projects/ puts a card here
 * with no change to this file.
 */
import { projects } from '../../core/catalog.mjs';
import { site } from '../../../data/site.js';
import { page, hero } from '../layout.mjs';
import { esc, escUrl, icon, button } from '../components.mjs';

function projectCard(project) {
  const issueCount = project.categories.reduce((n, c) => n + c.issueTypes.length, 0);
  return `<a class="product" href="/help/${escUrl(project.id)}">
    <span class="product__icon">${icon(project.icon ?? 'dot', { size: 24 })}</span>
    <span class="product__body">
      <span class="product__head">
        <span class="product__name">${esc(project.name)}</span>
        ${project.subtitle ? `<span class="product__subtitle">${esc(project.subtitle)}</span>` : ''}
      </span>
      <span class="product__blurb">${esc(project.blurb)}</span>
    </span>
    <span class="product__foot">
      <span class="product__kind">${esc(project.kind)}</span>
      <span class="product__count">${project.categories.length} areas · ${issueCount} topics</span>
    </span>
    <span class="product__arrow" aria-hidden="true">${icon('arrow', { size: 18 })}</span>
  </a>`;
}

/**
 * The way out of the funnel, at the bottom of the page.
 *
 * It sits last on purpose: the guided flow gets somebody a ticket with the product, the area
 * and the environment already attached, and a mail address at the top would cost all of that.
 * Below the grid it is there for the two cases the flow does not serve — a business enquiry,
 * and a problem that did not fit any of the products.
 *
 * Rendered only when `site.contactEmail` is set, so an unstaffed deployment shows nothing
 * rather than inviting mail nobody reads.
 */
function contactBlock() {
  if (!site.contactEmail) return '';
  const address = esc(site.contactEmail);
  return `
  <section class="section">
    <div class="wrap">
      <div class="panel">
        <h2 class="panel__title">${icon('mail', { size: 20 })} Need more help?</h2>
        <p class="panel__body">
          For business inquiries or issues you couldn't resolve here, contact us directly at
          <!-- esc, not escUrl: an address is the whole point of a mailto and percent-encoding
               its "@" gives clients a link they show back as %40. -->
          <a href="mailto:${address}">${address}</a>.
        </p>
      </div>
    </div>
  </section>`;
}

export function homePage({ account = null } = {}) {
  const cards = projects.map(projectCard).join('');

  const main = `
  <section class="section section--flush">
    <div class="wrap">
      <h2 class="sr-only">Choose a product</h2>
      <div class="products">${cards}</div>
    </div>
  </section>

  <section class="section">
    <div class="wrap split">
      <div class="panel">
        <h2 class="panel__title">${icon('ticket', { size: 20 })} Already have a ticket?</h2>
        <p class="panel__body">
          Open it with your ticket ID and the email address you used. You can read replies,
          add information, and see where it stands.
        </p>
        ${button('Check a ticket', { href: '/tickets', variant: 'secondary', iconName: 'search' })}
      </div>
      <div class="panel">
        <h2 class="panel__title">${icon('clock', { size: 20 })} What happens after you file</h2>
        <ol class="numbered">
          <li>You get a ticket ID immediately. Keep it — it is how you reopen the ticket.</li>
          <li>A person reads the ticket and either answers it or asks for what is missing.</li>
          <li>The ticket stays open until you say it is done, or it is resolved and closed.</li>
        </ol>
      </div>
    </div>
  </section>
  ${contactBlock()}`;

  return page({
    account,
    title: 'Support',
    path: '/',
    hero: hero({
      eyebrow: 'Nova support',
      title: 'What do you need help with?',
      lede: 'Choose the product you are having trouble with. Three questions later you will be talking to us, with everything we need already attached.',
    }),
    main,
  });
}
