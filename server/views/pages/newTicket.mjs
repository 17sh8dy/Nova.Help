/**
 * Step four: the ticket itself.
 *
 * Reaching this page is the third click, and the product, area and issue are already decided,
 * so the form only asks for what nobody could know for the reporter. Everything else is
 * carried in hidden fields and shown back as a summary they can change.
 *
 * THE SELF-HELP PANEL SITS ABOVE THE FORM RATHER THAN IN FRONT OF IT. An interstitial page of
 * suggested fixes would add a fourth click for everyone, including the people those fixes do
 * not apply to, and the ones it does help can read it without leaving the form. When an issue
 * type has no articles, nothing is shown — a panel that says "no suggestions" is worse than
 * silence. This panel is where retrieved answers will appear when there is an assistant to
 * retrieve them.
 *
 * THE ACCOUNT CHOICE IS THE FIRST THING IN THE FORM, AND IT IS AN OFFER. A Nova Account is
 * faster the second time and keeps your tickets together; an email address is enough. Both
 * paths reach the same queue and the same person, and the copy says so, because a support
 * form that makes you register first is a support form that loses the report. It sits above
 * the summary and description rather than beside the email field for one practical reason:
 * following the sign-in link leaves this page, and nobody should lose six paragraphs they
 * already typed to a link they met at the bottom of the form.
 *
 * ERRORS APPEAR TWICE, ON PURPOSE. A summary at the top of the form, announced and focusable
 * with links to each field, and a message beside every field that failed. One without the
 * other fails somebody: the summary alone makes you hunt, the inline message alone is
 * invisible to a screen reader that has just been told "submission failed".
 */
import { priorities } from '../../core/catalog.mjs';
import { LIMITS } from '../../core/validation.mjs';
import { ACCEPTED_EXTENSIONS, ATTACHMENT_LIMITS, humanSize } from '../../core/attachments.mjs';
import { assistantScope } from '../../core/policy.mjs';
import { page, hero } from '../layout.mjs';
import {
  breadcrumbs,
  button,
  esc,
  icon,
  notice,
  radioGroup,
  selectField,
  selectionSummary,
  steps,
  textArea,
  textField,
} from '../components.mjs';

/** Suggested reading for this issue type. Empty in, nothing out. */
function articlesPanel(articles) {
  if (!articles.length) return '';
  const items = articles
    .map(
      (article) => `<details class="article">
      <summary class="article__summary">
        <span class="article__title">${esc(article.title)}</span>
        <span class="article__hint">${esc(article.summary)}</span>
      </summary>
      <ol class="article__steps">${article.steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>
    </details>`,
    )
    .join('');

  return `<section class="card card--suggest" aria-labelledby="suggest-heading">
    <h2 class="card__title" id="suggest-heading">${icon('spark', { size: 20 })} Worth trying first</h2>
    <p class="card__lede">These fix this problem most of the time. If none of them do, the form below is still here.</p>
    ${items}
  </section>`;
}

/** The summary of everything that failed, linked to the fields that failed. */
function errorSummary(errors, attachmentErrors) {
  const fieldOrder = ['subject', 'description', 'email', 'name', 'priority', 'platform', 'appVersion', 'project', 'category', 'issueType'];
  const listed = fieldOrder
    .filter((field) => errors[field])
    .map((field) => `<li><a href="#${esc(field)}">${esc(errors[field])}</a></li>`);
  const files = attachmentErrors.map((message) => `<li><a href="#attachments">${esc(message)}</a></li>`);
  const all = [...listed, ...files];
  if (!all.length) return '';

  return `<div class="notice notice--error" role="alert" tabindex="-1" id="error-summary">
    <span class="notice__icon">${icon('alert', { size: 20 })}</span>
    <div class="notice__body">
      <p class="notice__title">Your ticket was not sent</p>
      <p>Fix the following and try again — nothing you typed has been lost.</p>
      <ul class="notice__list">${all.join('')}</ul>
    </div>
  </div>`;
}

/**
 * "How would you like to continue?" — shown only to someone who is not signed in.
 *
 * The Nova Account is offered first because it is the better option for anyone who will file
 * more than one ticket, and the guest path is stated in the same breath, in the same size of
 * text, as a complete answer rather than a fallback. `next` brings the reporter back to this
 * exact form.
 */
function continueChoice(formPath) {
  const next = encodeURIComponent(formPath);
  return `<section class="continue" aria-labelledby="continue-heading">
    <h3 class="continue__title" id="continue-heading">How would you like to continue?</h3>
    <div class="continue__options">
      <a class="continue__option continue__option--account" href="/account/sign-in?next=${esc(next)}">
        <span class="continue__icon">${icon('user', { size: 20 })}</span>
        <span class="continue__text">
          <span class="continue__label">Sign in or create a Nova Account</span>
          <span class="continue__hint">Your tickets stay together, and next time we already know how to reach you.</span>
        </span>
        <span class="continue__arrow" aria-hidden="true">${icon('chevron', { size: 18 })}</span>
      </a>
      <p class="continue__or">or</p>
      <div class="continue__option continue__option--guest">
        <span class="continue__icon">${icon('ticket', { size: 20 })}</span>
        <span class="continue__text">
          <span class="continue__label">Continue with your email</span>
          <span class="continue__hint">Fill in the form and give an email address at the bottom. No account needed.</span>
        </span>
      </div>
    </div>
  </section>`;
}

/** The contact block for someone who is already signed in: a statement, not a question. */
function filingAsAccount(account) {
  const label = account.displayName || account.email;
  const initial = String(label).trim().charAt(0).toUpperCase() || '?';
  return `<fieldset class="fieldset-group">
    <legend class="section__legend">How we reach you</legend>
    <div class="filing-as">
      <span class="filing-as__avatar" aria-hidden="true">${esc(initial)}</span>
      <div class="filing-as__text">
        <p class="filing-as__name">Filing as ${esc(label)}</p>
        <p class="filing-as__email">Replies go to ${esc(account.email)}, and this ticket will be listed in your account.</p>
      </div>
      <a class="filing-as__link" href="/account">Your account</a>
    </div>
  </fieldset>`;
}

export function newTicketPage({
  project,
  category,
  issueType,
  articles = [],
  values = {},
  errors = {},
  attachmentErrors = [],
  submitError = null,
  account = null,
}) {
  const scope = assistantScope({
    project: project.id,
    category: category.id,
    issueType: issueType.id,
    priority: values.priority ?? issueType.priority,
  });

  const action = `/help/${esc(project.id)}/${esc(category.id)}/${esc(issueType.id)}`;
  const askPriority = issueType.priorityMode !== 'fixed';
  const collectEnvironment = project.environment.collect;

  /* Arriving via "Something else" means the catalog had no words for this, so the form stops
     pretending it knows what happened and asks the open question instead. */
  const openEnded = issueType.catchAll === true;

  /* Signed in: no contact fields at all. The address is taken from the session on the server,
     never from a field on this page — a hidden input carrying an email address is a hidden
     input somebody can edit. */
  const continueBlock = account ? '' : continueChoice(action);
  const contactFields = account
    ? filingAsAccount(account)
    : `<fieldset class="fieldset-group">
        <legend class="section__legend">How we reach you</legend>
        <div class="grid-2">
          ${textField({
            id: 'name',
            label: 'Name',
            value: values.name ?? '',
            error: errors.name,
            maxLength: LIMITS.name.max,
            autocomplete: 'name',
            placeholder: 'Optional',
          })}
          ${textField({
            id: 'email',
            label: 'Email',
            type: 'email',
            hint: 'Used to reply, and to open this ticket again later.',
            value: values.email ?? '',
            error: errors.email,
            required: true,
            maxLength: LIMITS.email.max,
            autocomplete: 'email',
          })}
        </div>
      </fieldset>`;

  const priorityField = askPriority
    ? radioGroup({
        name: 'priority',
        legend: 'How badly is this affecting you?',
        hint: 'This helps us order the queue. Be honest rather than strategic — everything gets read.',
        value: values.priority ?? issueType.priority,
        error: errors.priority,
        options: priorities.map((p) => ({ value: p.id, label: p.label, hint: p.hint })),
      })
    : '';

  const environmentFields = collectEnvironment
    ? `<fieldset class="fieldset-group">
        <legend class="section__legend">Your setup <span class="section__legend-note">optional, but it usually saves a round trip</span></legend>
        <div class="grid-2">
          ${selectField({
            id: 'platform',
            label: 'Platform',
            value: values.platform ?? '',
            error: errors.platform,
            placeholder: 'Not sure',
            options: (project.environment.platforms ?? []).map((p) => ({ value: p, label: p })),
          })}
          ${textField({
            id: 'appVersion',
            label: project.environment.versionLabel ?? 'Version',
            hint: project.environment.versionHint,
            value: values.appVersion ?? '',
            error: errors.appVersion,
            maxLength: LIMITS.version.max,
            placeholder: 'e.g. 1.2.0',
          })}
        </div>
      </fieldset>`
    : '';

  const humanNotice = scope.humanOnly
    ? notice(
        'info',
        'A person handles this one',
        `<p>${esc(scope.reason ?? '')}</p>`,
      )
    : '';

  const main = `<section class="section">
    <div class="wrap layout">
      <div class="layout__main">
        ${articlesPanel(articles)}
        ${submitError ? notice('error', 'We could not save your ticket', `<p>${esc(submitError)}</p>`) : ''}
        ${errorSummary(errors, attachmentErrors)}

        <form class="card form" method="post" action="${action}" enctype="multipart/form-data" novalidate data-ticket-form>
          <h2 class="card__title">${icon('ticket', { size: 20 })} Tell us what happened</h2>

          ${selectionSummary(
            [
              { label: 'Product', value: project.name },
              { label: 'Area', value: category.label },
              { label: 'Issue', value: issueType.label },
            ],
            { changeHref: `/help/${esc(project.id)}/${esc(category.id)}` },
          )}

          ${continueBlock}

          ${textField({
            id: 'subject',
            label: 'Summary',
            hint: 'One line. What would you call this if it were a headline?',
            value: values.subject ?? '',
            error: errors.subject,
            required: true,
            maxLength: LIMITS.subject.max,
            placeholder: openEnded ? `${category.label} — in a few words` : issueType.label,
          })}

          ${textArea({
            id: 'description',
            label: openEnded ? 'Tell us what is going on' : 'What happened?',
            hint: openEnded
              ? 'In your own words — there is no wrong way to write this. What you were doing, what you expected, and what happened instead. Exact error text helps more than anything else.'
              : 'What you did, what you expected, and what happened instead. Exact error text helps more than anything else.',
            value: values.description ?? '',
            error: errors.description,
            required: true,
            rows: openEnded ? 11 : 9,
            maxLength: LIMITS.description.max,
          })}

          <div class="field" id="attachments">
            <label class="field__label" for="files">
              Attachments<span class="field__optional"> (optional)</span>
            </label>
            <p class="field__hint" id="files-hint">
              Up to ${ATTACHMENT_LIMITS.maxFiles} files, ${humanSize(ATTACHMENT_LIMITS.maxBytesPerFile)} each.
              Screenshots and log files are the most useful things you can send.
            </p>
            <input
              class="file"
              id="files"
              name="files"
              type="file"
              multiple
              accept="${esc(ACCEPTED_EXTENSIONS.join(','))}"
              aria-describedby="files-hint${attachmentErrors.length ? ' files-error' : ''}"
              ${attachmentErrors.length ? 'aria-invalid="true"' : ''}
            />
            <p class="field__note" data-file-list hidden></p>
            ${
              attachmentErrors.length
                ? `<p class="field__error" id="files-error">${icon('alert', { size: 15 })}${esc(attachmentErrors.join(' '))}</p>`
                : ''
            }
          </div>

          ${priorityField}
          ${environmentFields}

          ${contactFields}

          <div class="hp" aria-hidden="true">
            <label for="website">Leave this field empty</label>
            <input id="website" name="website" type="text" tabindex="-1" autocomplete="off" />
          </div>

          <div class="form__actions">
            ${button('Submit ticket', { type: 'submit', variant: 'primary', iconName: 'arrow' })}
            <a class="btn btn--ghost" href="/help/${esc(project.id)}/${esc(category.id)}">Back</a>
          </div>
          <p class="form__fineprint">
            We store what you write here so we can answer it. Nothing on this page is public.
          </p>
        </form>
      </div>

      <aside class="layout__aside" aria-label="About this ticket">
        ${humanNotice}
        <div class="card card--quiet">
          <h2 class="card__title">${icon('clock', { size: 18 })} What happens next</h2>
          <ol class="numbered numbered--tight">
            <li>You get a ticket ID as soon as you submit.</li>
            <li>A person reads it and replies by email.</li>
            <li>${
              account
                ? 'The ticket is listed on your Nova Account, so you can open it from any device.'
                : 'You can reopen the ticket any time with the ID and your email address.'
            }</li>
          </ol>
        </div>
        <div class="card card--quiet">
          <h2 class="card__title">${icon('shield', { size: 18 })} A note on what to send</h2>
          <p class="card__body">
            Never include passwords, recovery codes or payment card numbers. Support will never
            ask for them, and a ticket is not a secure place to keep one.
          </p>
        </div>
      </aside>
    </div>
  </section>`;

  return page({
    account,
    title: `${issueType.label} — ${project.name}`,
    description: `Open a support ticket for ${project.name}: ${issueType.label}.`,
    path: `/help/${project.id}/${category.id}/${issueType.id}`,
    noindex: true,
    hero: hero({
      crumbs: breadcrumbs([
        { href: '/', label: 'Support' },
        { href: `/help/${project.id}`, label: project.name },
        { href: `/help/${project.id}/${category.id}`, label: category.label },
        { label: issueType.label },
      ]),
      steps: steps(4),
      eyebrow: `${project.name} · ${category.label}`,
      title: openEnded ? `${category.label} — something else` : issueType.label,
      lede: openEnded
        ? 'Nothing on the last screen fitted, so just describe it. A person reads every one of these and will route it from here.'
        : 'Everything below goes to a person. The more precise you are, the fewer questions come back.',
    }),
    main,
  });
}
