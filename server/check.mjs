/**
 * `npm run check` — validate the support catalog without starting the server.
 *
 * The point of a data-driven portal is that support content is edited by people who are not
 * editing the server. This is what they run afterwards: it prints every structural problem at
 * once and exits non-zero, so a broken catalog fails in a terminal rather than in front of
 * somebody trying to report a bug.
 */
import { projects, stats, validate, articles } from './core/catalog.mjs';

const errors = validate();

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
