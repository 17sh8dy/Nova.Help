/**
 * Real product logos — for the handful of Nova products that have one.
 *
 * `icons.mjs` draws one hand-drawn glyph set: a single stroke weight, `currentColor`, no fill.
 * That works for a generic "this is a video editor" pictogram, but it is wrong for an actual
 * brand mark, which has its own fixed colours and its own background shape — forcing Atlas's
 * dark rounded square through `stroke="currentColor"` would just draw its outline. So a real
 * mark gets its own small lookup and its own render function instead of a new case inside
 * `icon()`, and a project opts in with `logo: '<name>'` rather than `icon: '<name>'`.
 *
 * SOURCE OF TRUTH. Every mark here is copied verbatim (only the wrapping `<svg>` attributes are
 * normalised) from `D:\Dev\Nova\assets\brand\*.svg` — the same artwork the main Nova site's
 * ecosystem page renders as `<img>`. Nothing here is redrawn or approximated, and nothing is
 * added for a product that does not have a real mark yet; see home.mjs's `projectCard()` for
 * the fallback to `icon()` when `logo` is absent.
 */
const marks = {
  /* Nova/assets/brand/atlas.svg — a dark rounded square with a hollow diamond over a filled
     half, in Atlas's own off-white. Also used by Atlas Website: same product, same mark. */
  atlas: {
    viewBox: '0 0 64 64',
    body:
      '<rect width="64" height="64" rx="14" fill="#2C2C2A"/>' +
      '<path d="M32 8 L54 32 L32 56 L10 32 Z" fill="none" stroke="#F1EFE8" stroke-width="3" stroke-linejoin="round"/>' +
      '<path d="M32 8 L54 32 L32 56 Z" fill="#F1EFE8"/>',
  },

  /* Nova/assets/brand/nova-cut.svg — a blue rounded square with a stack of film-frame
     rectangles behind a white play triangle. */
  'nova-cut': {
    viewBox: '0 0 1024 1024',
    body:
      '<rect width="1024" height="1024" rx="228" fill="#0A84FF"/>' +
      '<g transform="translate(512, 520)" fill="#FFFFFF">' +
      '<rect x="-240" y="-288" width="480" height="320" rx="40" opacity="0.35" transform="rotate(-12)"/>' +
      '<rect x="-256" y="-192" width="512" height="352" rx="40" opacity="0.25"/>' +
      '<path d="M-56,-56 L-56,56 L64,0 Z"/>' +
      '<g fill="none" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round">' +
      '<line x1="-200" y1="-136" x2="-200" y2="-80"/><line x1="-200" y1="-136" x2="-144" y2="-136"/>' +
      '<line x1="200" y1="104" x2="200" y2="48"/><line x1="200" y1="104" x2="144" y2="104"/>' +
      '</g></g>',
  },

  /* Nova/assets/brand/replay-gg.svg — a black rounded square with a white "R" glyph and a red
     play triangle. The source file's viewBox is not 0-based; kept as-is rather than
     renumbered, so the artwork's own coordinates stay a straight copy. */
  'replay-gg': {
    viewBox: '92.8 109.2 319.8 319.8',
    body:
      '<rect x="92.8" y="109.2" width="319.8" height="319.8" rx="70" fill="#080808"/>' +
      '<path fill="#FFFFFF" d="M160.4 180H315A54.25 54.25 0 0 1 323.3 287.9L374.6 358.2H319.5L271.9 291.2V251.7H307.2A18.45 18.45 0 0 0 307.2 214.8H184.2Z"/>' +
      '<path fill="#E6293F" d="M133.26 268.3L185.04 225.25Q187.5 223.2 187.5 226.4L187.5 314.3Q187.5 317.5 185.04 315.45L133.26 272.4Q130.8 270.35 133.26 268.3ZM187.46 268.3L239.24 225.25Q241.7 223.2 241.7 226.4L241.7 314.3Q241.7 317.5 239.24 315.45L187.46 272.4Q185 270.35 187.46 268.3Z"/>',
  },
};

export const hasBrandMark = (name) => Object.hasOwn(marks, name);

/** Render a product's real logo. Returns null for a name with no mark — callers fall back to icon(). */
export function brandMark(name, { size = 24, className = '' } = {}) {
  const mark = marks[name];
  if (!mark) return null;
  const classes = ['brand-mark', className].filter(Boolean).join(' ');
  return `<svg class="${classes}" width="${size}" height="${size}" viewBox="${mark.viewBox}" aria-hidden="true" focusable="false">${mark.body}</svg>`;
}
