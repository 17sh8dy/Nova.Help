/**
 * The catalog — the read model over everything in data/.
 *
 * Two jobs:
 *
 * 1. INDEX. Pages, the API and the ticket validator all need to answer "is this a real issue
 *    type, and what does it say about priority?" without walking three nested arrays. The
 *    index is built once at import and is immutable afterwards.
 *
 * 2. VALIDATE AT BOOT. A duplicate id or a dangling article reference is a data mistake, and
 *    the only sane time to find it is at startup — not when a reporter is halfway through the
 *    form. `assertValid()` throws, `server/check.mjs` calls it, and index.mjs calls it before
 *    it binds the port. Nothing downstream re-checks the shape of the catalog.
 *
 * 3. GUARANTEE THE ESCAPE HATCH. Every category ends with a "Something else" issue type,
 *    appended here rather than written into 41 data files by hand. See CATCH_ALL below.
 *
 * Nothing in here writes. Nothing in here knows about HTTP.
 */
import { projects as rawProjects } from '../../data/projects/index.js';
import { articles as rawArticles } from '../../data/articles.js';
import { statuses, transitions, DEFAULT_STATUS } from '../../data/statuses.js';
import { priorities, DEFAULT_PRIORITY } from '../../data/priorities.js';

const freeze = (o) => Object.freeze(o);

/* ── The escape hatch ──────────────────────────────────────────────────────────────────── */

/**
 * Every category ends with "Something else".
 *
 * WHY IT IS SYNTHESISED HERE AND NOT WRITTEN INTO data/. There are 41 categories today and
 * there will be more; an escape hatch that has to be remembered 41 times is an escape hatch
 * that is missing from the one category where somebody needed it. Appending it in the index
 * means a category added next year has one without anybody deciding to add it, and means it
 * cannot drift in wording between products.
 *
 * IT IS A REAL ISSUE TYPE, not a special case. It resolves through `getIssueType`, validates
 * through `validateTicketInput`, appears in the JSON API, and lands on the ordinary ticket
 * form — so choosing it takes the reporter STRAIGHT to the page where they describe the
 * problem, which is the entire point. Nothing downstream needs to know it is different, and
 * the `catchAll` flag exists only so the form can change its wording.
 *
 * IT INHERITS THE CATEGORY'S SENSITIVITY, and that is load-bearing. "Something else" inside
 * Account & security is still an account-and-security request, so it must route to a person
 * like its neighbours; if it did not, it would also flip the category itself out of sensitive
 * (a category is sensitive when *every* route out of it ends with a human), quietly removing
 * the human-only notice from the whole area.
 */
export const CATCH_ALL_ID = 'something-else';

const catchAll = (sensitive) => ({
  id: CATCH_ALL_ID,
  label: 'Something else',
  blurb: 'None of these fit. Describe it in your own words on the next screen.',
  priorityMode: 'ask',
  priority: DEFAULT_PRIORITY,
  sensitive,
  articles: [],
  catchAll: true,
});

/** `project/category/issue` — the one form of a selection used in URLs, tickets and the API. */
export const pathOf = (projectId, categoryId, issueTypeId) =>
  [projectId, categoryId, issueTypeId].filter(Boolean).join('/');

/* ── Index ─────────────────────────────────────────────────────────────────────────────── */

const projectIndex = new Map();
const categoryIndex = new Map(); // "project/category"
const issueIndex = new Map(); // "project/category/issue"
const articleIndex = new Map();

for (const a of rawArticles) articleIndex.set(a.id, freeze({ ...a, steps: freeze([...a.steps]) }));

for (const p of rawProjects) {
  const categories = p.categories.map((c) => {
    const build = (t) => {
      const issue = freeze({
        catchAll: false,
        ...t,
        priorityMode: t.priorityMode ?? 'ask',
        priority: t.priority ?? DEFAULT_PRIORITY,
        sensitive: t.sensitive === true,
        articles: freeze([...(t.articles ?? [])]),
        projectId: p.id,
        categoryId: c.id,
        path: pathOf(p.id, c.id, t.id),
      });
      issueIndex.set(issue.path, issue);
      return issue;
    };

    const declared = c.issueTypes.map(build);

    /* Decided from the DECLARED issue types, before the escape hatch is appended, so that the
       hatch can inherit the answer instead of changing it. */
    const sensitive = declared.length > 0 && declared.every((t) => t.sensitive);
    const issueTypes = [...declared, build(catchAll(sensitive))];

    const category = freeze({
      ...c,
      issueTypes: freeze(issueTypes),
      projectId: p.id,
      path: pathOf(p.id, c.id),
      /** True when every route out of this category ends with a human. Drives the UI notice. */
      sensitive,
    });
    categoryIndex.set(category.path, category);
    return category;
  });

  const project = freeze({
    ...p,
    environment: freeze({ collect: false, platforms: [], ...(p.environment ?? {}) }),
    categories: freeze(categories),
    path: p.id,
  });
  projectIndex.set(project.id, project);
}

export const projects = freeze([...projectIndex.values()]);
export const articles = freeze([...articleIndex.values()]);
export { statuses, priorities, transitions, DEFAULT_STATUS, DEFAULT_PRIORITY };

/* ── Lookups. Every one returns undefined rather than throwing; callers decide what a miss means. */

export const getProject = (id) => projectIndex.get(id);
export const getCategory = (projectId, categoryId) => categoryIndex.get(pathOf(projectId, categoryId));
export const getIssueType = (projectId, categoryId, issueTypeId) =>
  issueIndex.get(pathOf(projectId, categoryId, issueTypeId));
export const getArticle = (id) => articleIndex.get(id);
export const getStatus = (id) => statuses.find((s) => s.id === id);
export const getPriority = (id) => priorities.find((p) => p.id === id);

/** Articles for an issue type, silently dropping ids that no longer exist. */
export const articlesFor = (issueType) =>
  (issueType?.articles ?? []).map((id) => articleIndex.get(id)).filter(Boolean);

/**
 * Resolve a whole selection at once. Returns what it could resolve plus the first level that
 * failed, so a page can render "that category does not exist in Online Earth" rather than a
 * bare 404.
 */
export function resolveSelection({ project: projectId, category: categoryId, issueType: issueTypeId }) {
  const project = projectId ? getProject(projectId) : undefined;
  if (projectId && !project) return { ok: false, missing: 'project' };
  const category = categoryId && project ? getCategory(project.id, categoryId) : undefined;
  if (categoryId && !category) return { ok: false, missing: 'category', project };
  const issueType = issueTypeId && category ? getIssueType(project.id, category.id, issueTypeId) : undefined;
  if (issueTypeId && !issueType) return { ok: false, missing: 'issueType', project, category };
  return { ok: true, project, category, issueType };
}

/** Is `to` a legal next status for `from`? The one place transition rules are read. */
export const canTransition = (from, to) => Boolean(transitions[from]?.includes(to));

/* ── Boot-time validation ──────────────────────────────────────────────────────────────── */

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Collect every structural problem in the catalog. Empty array means the data is sound. */
export function validate() {
  const errors = [];
  const seenProjects = new Set();

  if (!rawProjects.length) errors.push('No projects are registered.');

  for (const p of rawProjects) {
    const where = `project "${p.id}"`;
    if (!ID.test(p.id ?? '')) errors.push(`${where}: id must be kebab-case.`);
    if (seenProjects.has(p.id)) errors.push(`${where}: duplicate project id.`);
    seenProjects.add(p.id);
    if (!p.name) errors.push(`${where}: missing name.`);
    if (!p.categories?.length) errors.push(`${where}: has no categories.`);

    const seenCategories = new Set();
    for (const c of p.categories ?? []) {
      const cWhere = `${where} category "${c.id}"`;
      if (!ID.test(c.id ?? '')) errors.push(`${cWhere}: id must be kebab-case.`);
      if (seenCategories.has(c.id)) errors.push(`${cWhere}: duplicate category id.`);
      seenCategories.add(c.id);
      if (!c.label) errors.push(`${cWhere}: missing label.`);
      if (!c.issueTypes?.length) errors.push(`${cWhere}: has no issue types.`);

      const seenIssues = new Set();
      for (const t of c.issueTypes ?? []) {
        const tWhere = `${cWhere} issue "${t.id}"`;
        if (!ID.test(t.id ?? '')) errors.push(`${tWhere}: id must be kebab-case.`);
        if (t.id === CATCH_ALL_ID)
          errors.push(`${tWhere}: "${CATCH_ALL_ID}" is reserved — the catalog appends it to every category.`);
        if (seenIssues.has(t.id)) errors.push(`${tWhere}: duplicate issue type id.`);
        seenIssues.add(t.id);
        if (!t.label) errors.push(`${tWhere}: missing label.`);
        if (t.priorityMode && !['ask', 'fixed'].includes(t.priorityMode))
          errors.push(`${tWhere}: priorityMode must be "ask" or "fixed".`);
        if (t.priority && !priorities.some((x) => x.id === t.priority))
          errors.push(`${tWhere}: unknown priority "${t.priority}".`);
        for (const a of t.articles ?? [])
          if (!articleIndex.has(a)) errors.push(`${tWhere}: references unknown article "${a}".`);
      }
    }
  }

  const seenArticles = new Set();
  for (const a of rawArticles) {
    if (seenArticles.has(a.id)) errors.push(`article "${a.id}": duplicate id.`);
    seenArticles.add(a.id);
    if (!a.title || !a.summary) errors.push(`article "${a.id}": needs a title and a summary.`);
  }

  if (!statuses.some((s) => s.id === DEFAULT_STATUS))
    errors.push(`DEFAULT_STATUS "${DEFAULT_STATUS}" is not a defined status.`);
  if (!priorities.some((p) => p.id === DEFAULT_PRIORITY))
    errors.push(`DEFAULT_PRIORITY "${DEFAULT_PRIORITY}" is not a defined priority.`);
  for (const [from, tos] of Object.entries(transitions)) {
    if (!statuses.some((s) => s.id === from)) errors.push(`transitions: unknown source status "${from}".`);
    for (const to of tos)
      if (!statuses.some((s) => s.id === to)) errors.push(`transitions: "${from}" -> unknown status "${to}".`);
  }

  return errors;
}

/** Throw on the first sight of a broken catalog, with every problem listed at once. */
export function assertValid() {
  const errors = validate();
  if (errors.length) {
    throw new Error(`Support catalog is invalid:\n  - ${errors.join('\n  - ')}`);
  }
}

/** Counts for the homepage. Derived, never stored. */
export const stats = freeze({
  projects: projects.length,
  categories: categoryIndex.size,
  /** Every issue type a reporter can pick, including one "Something else" per category. */
  issueTypes: issueIndex.size,
  /** Only the ones written in data/ — what a person editing the catalog is responsible for. */
  declaredIssueTypes: issueIndex.size - categoryIndex.size,
  catchAll: categoryIndex.size,
  articles: articleIndex.size,
});
