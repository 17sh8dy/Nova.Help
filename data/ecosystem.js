/**
 * The Nova ecosystem, as links — THE one file to edit when a URL becomes real.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS SEPARATELY FROM data/projects/.
 *
 * `data/projects/` is the SUPPORT CATALOG: what can go wrong with each product and how a
 * ticket about it is routed. This is the PRODUCT DIRECTORY: what each product is, and where
 * it lives on the web. They change for different reasons and at different times — a product's
 * site going live is not a support-catalog edit — and keeping them apart means a person
 * filling in a URL never has to read a file full of issue types.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * `url: null` MEANS "NOT READY YET", AND IT IS THE HONEST DEFAULT.
 *
 * Most of these sites do not exist. Rather than inventing plausible addresses that would
 * later have to be hunted down and removed, every unbuilt one is `null` — and everything that
 * renders this list checks. A `null` product still appears, still says what it is, and simply
 * is not a link. So the page is complete and honest today, and turning one into a link later
 * is one edit here with no template to change.
 *
 * THE SUPPORT LINK IS DIFFERENT AND IS NEVER NULL. `/help/<id>` is a page on this very site;
 * it works now, it is generated from the catalog, and `npm run check` fails if the id does
 * not match a real project. That is the difference between the two columns: one is a promise
 * about somebody else's deployment, the other is a fact about this one.
 */

/**
 * Every Nova product, in the order they should be presented.
 *
 * `support` is a path on Nova.Help and must name a project in `data/projects/`.
 * `url` is the product's own site — `null` until one exists.
 */
export const products = [
  {
    id: 'nova',
    name: 'Nova',
    blurb: 'The front door to the ecosystem.',
    support: 'nova-site',
    url: null,
  },
  {
    id: 'online-earth',
    name: 'Online Earth',
    blurb: 'Explore the real world, and everything connected to it.',
    support: 'online-earth',
    url: null,
  },
  {
    id: 'open-cut',
    name: 'Open Cut',
    blurb: 'A video and photo editor that is free, and stays free.',
    support: 'open-cut',
    url: null,
  },
  {
    id: 'atlas',
    name: 'Atlas',
    blurb: 'A desktop assistant that runs on your machine.',
    support: 'atlas',
    url: null,
  },
  {
    id: 'replay-gg',
    name: 'Replay.GG',
    blurb: 'Capture the moment you did not know you wanted.',
    support: 'replay-gg',
    url: null,
  },
  {
    id: 'nova-engine',
    name: 'Nova Engine',
    blurb: 'The engine the games are built on.',
    support: 'nova-engine',
    url: null,
  },
];

/**
 * Where the community is.
 *
 * Discord is REAL and is the one link in this file that is not a placeholder — which is
 * exactly why it is worth having a place where the difference is visible at a glance.
 * A `null` here hides its control rather than rendering a dead one.
 */
export const community = {
  discord: 'https://discord.gg/XBhER9Z6EB',
};

/** The products that have a site to link to. What every "other Nova products" list renders. */
export const linkedProducts = () => products.filter((product) => product.url);

/** A product by id, or null. */
export const getEcosystemProduct = (id) => products.find((product) => product.id === id) ?? null;

/** The product entry whose support catalog is this project id, or null. */
export const forSupportProject = (projectId) =>
  products.find((product) => product.support === projectId) ?? null;
