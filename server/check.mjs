/**
 * `npm run check` — validate the support catalog without starting the server.
 *
 * The point of a data-driven portal is that support content is edited by people who are not
 * editing the server. This is what they run afterwards: it prints every structural problem at
 * once and exits non-zero, so a broken catalog fails in a terminal rather than in front of
 * somebody trying to report a bug.
 */
import { projects, stats, validate, articles } from './core/catalog.mjs';
import { products as ecosystemProducts } from '../data/ecosystem.js';

const errors = validate();

/**
 * The ecosystem directory is checked HERE rather than in core/catalog.mjs, because it is not
 * part of the support catalog — it is the product directory, and `npm run check` is the one
 * command a person editing data/ runs.
 *
 * TWO RULES, and the first is the one that would otherwise fail silently in a footer: every
 * entry's `support` must name a real project, or the ecosystem list renders a link to a 404.
 * A `url` of `null` is not an error — it is the honest default for a site that does not exist
 * yet — but a url that is not http(s) is, because it will end up in an href.
 */
const projectIds = new Set(projects.map((project) => project.id));
for (const product of ecosystemProducts) {
  if (!projectIds.has(product.support)) {
    errors.push(
      `data/ecosystem.js: "${product.id}" points at support project "${product.support}", ` +
        `which is not in data/projects/ (have: ${[...projectIds].join(', ')})`,
    );
  }
  if (product.url !== null && !/^https?:\/\//.test(String(product.url))) {
    errors.push(`data/ecosystem.js: "${product.id}" has a url that is not http(s): ${product.url}`);
  }
}

if (errors.length) {
  console.error(`Support catalog has ${errors.length} problem(s):\n`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('Support catalog is valid.\n');
console.log(`  projects     ${stats.projects}`);
console.log(`  categories   ${stats.categories}`);
console.log(`  issue types  ${stats.declaredIssueTypes} in data/ (+ ${stats.catchAll} "Something else", appended one per category)`);
console.log(`  articles     ${stats.articles}\n`);

for (const project of projects) {
  const issues = project.categories.reduce((n, c) => n + c.issueTypes.length, 0);
  const sensitive = project.categories.reduce(
    (n, c) => n + c.issueTypes.filter((t) => t.sensitive).length,
    0,
  );
  console.log(
    `  ${project.name.padEnd(14)} ${String(project.categories.length).padStart(2)} areas  ` +
      `${String(issues).padStart(3)} issues  ${String(sensitive).padStart(2)} human-only`,
  );
}

/* Articles nothing points at are not an error — they may be written ahead of the issue types
   that will use them — but they are worth seeing, because the usual cause is a typo. */
const referenced = new Set(
  projects.flatMap((p) => p.categories.flatMap((c) => c.issueTypes.flatMap((t) => [...t.articles]))),
);
const orphans = articles.filter((a) => !referenced.has(a.id));
if (orphans.length) {
  console.log(`\n  Note: ${orphans.length} article(s) are not referenced by any issue type:`);
  for (const article of orphans) console.log(`    - ${article.id}`);
}

/* The product directory, so somebody filling in a URL can see at a glance what is still
   waiting for one. This is a status line, not a warning: `null` is expected. */
const unlinked = ecosystemProducts.filter((product) => !product.url);
console.log(
  `
  ecosystem    ${ecosystemProducts.length} products, ` +
    `${ecosystemProducts.length - unlinked.length} with a website of their own`,
);
if (unlinked.length) {
  console.log(`    no website yet (data/ecosystem.js): ${unlinked.map((p) => p.id).join(', ')}`);
}
