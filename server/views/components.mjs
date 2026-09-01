/**
 * The shared pieces every page is built from, and the escaping that keeps them safe.
 *
 * ESCAPING IS NOT OPTIONAL HERE. Every value that reaches a page came from a person: a
 * subject line, a description, a filename, an email address. `esc()` is applied at the point
 * of interpolation, never "earlier, somewhere". Any new component in this file must escape
 * its own inputs — a template that trusts its caller is how the first stored-XSS gets in.
 */
import { icon } from './icons.mjs';

const AMP = /&/g;

/** HTML-escape. Also escapes quotes, so the same function is safe inside an attribute. */
export function esc(value) {
  return String(value ?? '')
    .replace(AMP, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for a URL path or query segment. */
export const escUrl = (value) => encodeURIComponent(String(value ?? ''));

/**
 * Render user-written multi-line text: escaped, then paragraph breaks restored.
 * No markdown, no links — nothing a reporter types is ever interpreted as markup.
 */
export function paragraphs(text) {
  return String(text ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${esc(block).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

export const classes = (...values) => values.filter(Boolean).join(' ');

/* ── Small components ──────────────────────────────────────────────────────────────────── */

/** A status or severity chip. `tone` comes from the data, not from the caller. */
export const badge = (label, tone = 'neutral', { title = null } = {}) =>
  `<span class="badge badge--${esc(tone)}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>`;

export function button(label, { href, type = 'button', variant = 'primary', name, value, iconName, size } = {}) {
  const cls = classes('btn', `btn--${variant}`, size && `btn--${size}`);
  const inner = `${iconName ? icon(iconName, { size: 18 }) : ''}<span>${esc(label)}</span>`;
  if (href) return `<a class="${cls}" href="${esc(href)}">${inner}</a>`;
  const attrs = [name && `name="${esc(name)}"`, value && `value="${esc(value)}"`].filter(Boolean).join(' ');
  return `<button class="${cls}" type="${esc(type)}" ${attrs}>${inner}</button>`;
}

/**
 * A message panel: `info`, `success`, `warning`, `error`.
 *
 * Errors and successes are announced to assistive technology — an error panel that appears
 * after a failed submit is useless to a screen reader if nothing says it arrived.
 */
export function notice(kind, title, bodyHtml = '', { role } = {}) {
  const iconName = kind === 'success' ? 'check' : kind === 'error' || kind === 'warning' ? 'alert' : 'info';
  const liveRole = role ?? (kind === 'error' ? 'alert' : kind === 'success' ? 'status' : null);
  return `<div class="notice notice--${esc(kind)}"${liveRole ? ` role="${esc(liveRole)}"` : ''}>
    <span class="notice__icon">${icon(iconName, { size: 20 })}</span>
    <div class="notice__body">
      ${title ? `<p class="notice__title">${esc(title)}</p>` : ''}
      ${bodyHtml}
    </div>
  </div>`;
}

/**
 * Breadcrumbs for the guided flow.
 *
 * This is the "where am I, and how do I go back one step" affordance that keeps a three-step
 * funnel from feeling like a trap. Items: `{ href, label }`; the last one is the current page
 * and is not a link.
 */
export function breadcrumbs(items = []) {
  if (items.length < 2) return '';
  const parts = items.map((item, index) => {
    const last = index === items.length - 1;
    const content = last
      ? `<span aria-current="page">${esc(item.label)}</span>`
      : `<a href="${esc(item.href)}">${esc(item.label)}</a>`;
    return `<li>${content}</li>`;
  });
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${parts.join('')}</ol></nav>`;
}

/** The three-step progress indicator shown through the guided flow. */
export function steps(current) {
  const all = [
    { id: 1, label: 'Product' },
    { id: 2, label: 'Area' },
    { id: 3, label: 'Issue' },
    { id: 4, label: 'Details' },
  ];
  const items = all.map((step) => {
    const state = step.id < current ? 'done' : step.id === current ? 'current' : 'todo';
    return `<li class="steps__item steps__item--${state}"${state === 'current' ? ' aria-current="step"' : ''}>
      <span class="steps__dot" aria-hidden="true">${state === 'done' ? icon('check', { size: 12 }) : step.id}</span>
      <span class="steps__label">${esc(step.label)}</span>
    </li>`;
  });
  return `<ol class="steps" aria-label="Step ${current} of ${all.length}">${items.join('')}</ol>`;
}

/**
 * A choice card — the repeated element of the guided flow.
 *
 * The whole card is one link. Nested interactive elements inside a card are the classic way
 * to make a grid unusable with a keyboard, so there are none: one card, one tab stop.
 */
export function choiceCard({ href, iconName, title, blurb, meta, note, variant }) {
  return `<a class="${classes('choice', variant && `choice--${variant}`)}" href="${esc(href)}">
    ${iconName ? `<span class="choice__icon">${icon(iconName, { size: 22 })}</span>` : ''}
    <span class="choice__text">
      <span class="choice__title">${esc(title)}</span>
      ${blurb ? `<span class="choice__blurb">${esc(blurb)}</span>` : ''}
      ${note ? `<span class="choice__note">${icon('shield', { size: 14 })}${esc(note)}</span>` : ''}
    </span>
    ${meta ? `<span class="choice__meta">${esc(meta)}</span>` : ''}
    <span class="choice__arrow" aria-hidden="true">${icon('chevron', { size: 18 })}</span>
  </a>`;
}

/** The empty state. Never a bare "nothing here" — always says what to do next. */
export function emptyState({ title, body, action }) {
  return `<div class="empty">
    <span class="empty__icon">${icon('search', { size: 26 })}</span>
    <p class="empty__title">${esc(title)}</p>
    ${body ? `<p class="empty__body">${esc(body)}</p>` : ''}
    ${action ? button(action.label, { href: action.href, variant: 'secondary' }) : ''}
  </div>`;
}

/* ── Form fields ───────────────────────────────────────────────────────────────────────── */

/**
 * Fields render their own label, hint, error and ARIA wiring together, because that wiring is
 * exactly what gets forgotten when each form writes its own markup:
 *
 * - the label is a real <label for>, never a floating <span>
 * - a hint and an error are joined into aria-describedby, in that order
 * - an invalid field carries aria-invalid, and its message is adjacent to it, not at the top
 *   of the page only
 * - required fields say "Required" in text; the asterisk convention is decoration
 */
function fieldShell({ id, label, hint, error, required, control, extraClass }) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
  return `<div class="${classes('field', error && 'field--error', extraClass)}">
    <label class="field__label" for="${esc(id)}">
      ${esc(label)}${required ? '<span class="field__required"> (required)</span>' : ''}
    </label>
    ${hint ? `<p class="field__hint" id="${esc(id)}-hint">${esc(hint)}</p>` : ''}
    ${control(describedBy)}
    ${error ? `<p class="field__error" id="${esc(id)}-error">${icon('alert', { size: 15 })}${esc(error)}</p>` : ''}
  </div>`;
}

export function textField({ id, name, label, value = '', hint, error, required, type = 'text', maxLength, autocomplete, placeholder }) {
  return fieldShell({
    id,
    label,
    hint,
    error,
    required,
    control: (describedBy) => `<input
      class="input"
      id="${esc(id)}"
      name="${esc(name ?? id)}"
      type="${esc(type)}"
      value="${esc(value)}"
      ${required ? 'required' : ''}
      ${maxLength ? `maxlength="${Number(maxLength)}"` : ''}
      ${autocomplete ? `autocomplete="${esc(autocomplete)}"` : ''}
      ${placeholder ? `placeholder="${esc(placeholder)}"` : ''}
      ${error ? 'aria-invalid="true"' : ''}
      ${describedBy ? `aria-describedby="${esc(describedBy)}"` : ''}
    />`,
  });
}

export function textArea({ id, name, label, value = '', hint, error, required, rows = 8, maxLength, placeholder }) {
  return fieldShell({
    id,
    label,
    hint,
    error,
    required,
    control: (describedBy) => `<textarea
      class="input input--area"
      id="${esc(id)}"
      name="${esc(name ?? id)}"
      rows="${Number(rows)}"
      ${required ? 'required' : ''}
      ${maxLength ? `maxlength="${Number(maxLength)}"` : ''}
      ${placeholder ? `placeholder="${esc(placeholder)}"` : ''}
      ${error ? 'aria-invalid="true"' : ''}
      ${describedBy ? `aria-describedby="${esc(describedBy)}"` : ''}
    >${esc(value)}</textarea>`,
  });
}

export function selectField({ id, name, label, options, value = '', hint, error, required, placeholder }) {
  const rendered = options
    .map((option) => `<option value="${esc(option.value)}"${option.value === value ? ' selected' : ''}>${esc(option.label)}</option>`)
    .join('');
  return fieldShell({
    id,
    label,
    hint,
    error,
    required,
    control: (describedBy) => `<div class="select">
      <select
        class="input"
        id="${esc(id)}"
        name="${esc(name ?? id)}"
        ${required ? 'required' : ''}
        ${error ? 'aria-invalid="true"' : ''}
        ${describedBy ? `aria-describedby="${esc(describedBy)}"` : ''}
      >${placeholder ? `<option value="">${esc(placeholder)}</option>` : ''}${rendered}</select>
      <span class="select__arrow" aria-hidden="true">${icon('chevron', { size: 16 })}</span>
    </div>`,
  });
}

/**
 * A radio group in a fieldset with a legend — the correct grouping for "pick one of these",
 * and what makes a screen reader announce "Severity, 2 of 4" rather than four loose buttons.
 */
export function radioGroup({ name, legend, options, value, hint, error }) {
  const describedBy = [hint && `${name}-hint`, error && `${name}-error`].filter(Boolean).join(' ');
  const items = options
    .map((option, index) => {
      const id = `${name}-${index}`;
      return `<label class="radio" for="${esc(id)}">
        <input class="radio__input" type="radio" id="${esc(id)}" name="${esc(name)}" value="${esc(option.value)}"${option.value === value ? ' checked' : ''} />
        <span class="radio__mark" aria-hidden="true"></span>
        <span class="radio__text">
          <span class="radio__label">${esc(option.label)}</span>
          ${option.hint ? `<span class="radio__hint">${esc(option.hint)}</span>` : ''}
        </span>
      </label>`;
    })
    .join('');

  return `<fieldset class="${classes('field', 'fieldset', error && 'field--error')}"${describedBy ? ` aria-describedby="${esc(describedBy)}"` : ''}>
    <legend class="field__label">${esc(legend)}</legend>
    ${hint ? `<p class="field__hint" id="${esc(name)}-hint">${esc(hint)}</p>` : ''}
    <div class="radios">${items}</div>
    ${error ? `<p class="field__error" id="${esc(name)}-error">${icon('alert', { size: 15 })}${esc(error)}</p>` : ''}
  </fieldset>`;
}

/** A read-only summary of the selections carried into the form from the guided flow. */
export function selectionSummary(items, { changeHref } = {}) {
  const rows = items
    .map((item) => `<div class="summary__row">
      <dt>${esc(item.label)}</dt>
      <dd>${esc(item.value)}</dd>
    </div>`)
    .join('');
  return `<div class="summary">
    <dl class="summary__list">${rows}</dl>
    ${changeHref ? `<a class="summary__change" href="${esc(changeHref)}">Change</a>` : ''}
  </div>`;
}

export { icon };
