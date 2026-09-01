/**
 * Steps two and three of the guided flow: the areas inside a product, then the issues inside
 * an area.
 *
 * Both pages are the same shape — a heading, breadcrumbs, a step indicator, and a list of
 * choice cards — because they are the same act performed twice, and making them look
 * different would only tell the reporter they are somewhere new when they are not.
 *
 * The sensitivity notice on an issue card is not decoration. Someone about to report a
 * compromised account should know before they type that a person will read it.
 */
import { page, hero } from '../layout.mjs';
import { breadcrumbs, choiceCard, steps, esc, escUrl, notice, emptyState } from '../components.mjs';

const HUMAN_NOTE = 'Always handled by a person';

export function projectPage(project, { account = null } = {}) {
  const cards = project.categories
    .map((category) =>
      choiceCard({
        href: `/help/${escUrl(project.id)}/${escUrl(category.id)}`,
        iconName: category.icon,
        title: category.label,
        blurb: category.blurb,
        meta: `${category.issueTypes.length}`,
        note: category.sensitive ? HUMAN_NOTE : null,
      }),
    )
    .join('');

  const main = `<section class="section section--flush">
    <div class="wrap">
      <h2 class="sr-only">Choose an area of ${esc(project.name)}</h2>
      <div class="choices">${cards}</div>
    </div>
  </section>`;

  return page({
    account,
    title: `${project.name} support`,
    description: `Get help with ${project.name}: ${project.blurb}`,
    path: `/help/${project.id}`,
    hero: hero({
      crumbs: breadcrumbs([
        { href: '/', label: 'Support' },
        { label: project.name },
      ]),
      steps: steps(2),
      eyebrow: project.name,
      title: 'Which part is it about?',
      lede: 'Pick the closest area. You can change it on the next screen if it turns out to be somewhere else.',
    }),
    main,
  });
}

/**
 * Step three, with its escape hatch.
 *
 * "Something else" is the last card and is set slightly apart from the listed issues, because
 * it is a different kind of answer: the others say what is wrong, this one says the list does
 * not cover it. It leads to exactly the same ticket form as every other card — the reporter is
 * never asked to pick again from a second list, they just get the page where they describe the
 * problem. The catalog guarantees it exists in every category; this page only has to place it.
 */
export function categoryPage(project, category, { account = null } = {}) {
  const card = (issueType) =>
    choiceCard({
      href: `/help/${escUrl(project.id)}/${escUrl(category.id)}/${escUrl(issueType.id)}`,
      iconName: issueType.catchAll ? 'help' : undefined,
      title: issueType.label,
      blurb: issueType.blurb,
      note: issueType.sensitive ? HUMAN_NOTE : null,
      variant: issueType.catchAll ? 'catch-all' : undefined,
    });

  const listed = category.issueTypes.filter((t) => !t.catchAll);
  const hatch = category.issueTypes.find((t) => t.catchAll);

  const body = `${
    listed.length
      ? `<div class="choices choices--tight">${listed.map(card).join('')}</div>`
      : emptyState({
          title: 'Nothing is listed under this area yet.',
          body: 'You can still tell us about it — choose "Something else" below.',
          action: { label: `Back to ${project.name}`, href: `/help/${project.id}` },
        })
  }${hatch ? `<div class="choices choices--hatch">${card(hatch)}</div>` : ''}`;

  const main = `<section class="section section--flush">
    <div class="wrap">
      <h2 class="sr-only">Choose an issue in ${esc(category.label)}</h2>
      ${body}
      ${
        category.sensitive
          ? notice(
              'info',
              'These requests go straight to a person',
              '<p>Account ownership, security, payments and legal requests are never decided automatically.</p>',
            )
          : ''
      }
    </div>
  </section>`;

  return page({
    account,
    title: `${category.label} — ${project.name}`,
    description: `${project.name} support: ${category.blurb ?? category.label}`,
    path: `/help/${project.id}/${category.id}`,
    hero: hero({
      crumbs: breadcrumbs([
        { href: '/', label: 'Support' },
        { href: `/help/${project.id}`, label: project.name },
        { label: category.label },
      ]),
      steps: steps(3),
      eyebrow: `${project.name} · ${category.label}`,
      title: 'What is happening?',
      lede: 'Choose the closest description. The next screen is the ticket itself.',
    }),
    main,
  });
}
