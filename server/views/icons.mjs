/**
 * The icon set.
 *
 * One 24×24 stroked grid, drawn with `currentColor`, so an icon takes the colour of whatever
 * it sits in and needs no per-context variant. Icons live here rather than in data/ because
 * markup is presentation: a project file names an icon (`icon: 'globe'`), and this module
 * decides what that looks like. An unknown name falls back to the neutral dot rather than
 * rendering nothing, so a typo in the catalog is visible instead of silent.
 *
 * Every icon is decorative. They are emitted with aria-hidden and always sit beside a real
 * text label — never as the only thing identifying a control.
 */
const paths = {
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.1 5-5 2.1 2.1-5z"/>',
  film: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M8 4.5v15M16 4.5v15M3 12h18M3 8.25h5M3 15.75h5M16 8.25h5M16 15.75h5"/>',
  cube: '<path d="M12 3 20 7.5v9L12 21 4 16.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>',
  nova: '<path d="M12 2.5c.6 5.6 3.4 8.4 9 9-5.6.6-8.4 3.4-9 9-.6-5.6-3.4-8.4-9-9 5.6-.6 8.4-3.4 9-9Z"/>',
  key: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M18 12v3.5M15 12v2.5"/>',
  flag: '<path d="M5 21V4.5M5 5h11l-1.6 3.4L16 12H5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4"/><path d="M12 17h.01"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M6.5 14.5h3"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  spark: '<path d="M12 3.5 13.8 9 19 10.8 13.8 12.6 12 18l-1.8-5.4L5 10.8 10.2 9z"/><path d="M18.5 16.5 19 18l1.5.5L19 19l-.5 1.5L18 19l-1.5-.5 1.5-.5z"/>',
  download: '<path d="M12 3.5v11M8 11l4 4 4-4M4.5 19.5h15"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>',
  shield: '<path d="M12 3 19.5 6v6c0 4-3.2 7.3-7.5 9-4.3-1.7-7.5-5-7.5-9V6z"/>',
  wrench: '<path d="M15.5 3.5a5 5 0 0 0-4.2 7.6L3.5 18.9l1.6 1.6 7.8-7.8a5 5 0 0 0 6.6-6.4l-2.9 2.9-2.6-.6-.6-2.6z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>',
  wave: '<path d="M2.5 12c2-4 3.5-4 5.5 0s3.5 4 5.5 0 3.5-4 5.5 0"/><path d="M2.5 17c2-2.5 3.5-2.5 5.5 0s3.5 2.5 5.5 0 3.5-2.5 5.5 0"/>',
  book: '<path d="M4 5.5A2 2 0 0 1 6 3.5h13v14H6a2 2 0 0 0-2 2z"/><path d="M4 17.5v3h15"/>',
  browser: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18M6 6.75h.01M8.5 6.75h.01"/>',
  import: '<path d="M12 14.5v-11M8 7.5l4-4 4 4"/><path d="M4.5 14v4.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V14"/>',
  timeline: '<path d="M3 6.5h18M3 12h18M3 17.5h18"/><circle cx="8" cy="6.5" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="17.5" r="2"/>',
  export: '<path d="M12 3.5v11M8 7.5l4-4 4 4M4.5 19.5h15"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.5h.01M9.5 9.5h.01M13 9.5h.01M16.5 9.5h.01M6 13h.01M18 13h.01M9.5 15.5h5"/>',
  drive: '<rect x="3" y="4.5" width="18" height="7" rx="2"/><rect x="3" y="12.5" width="18" height="7" rx="2"/><path d="M6.5 8h.01M6.5 16h.01"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',

  /* Interface icons, referenced by name from components rather than from data. */
  arrow: '<path d="M4.5 12h14M13 6.5l5.5 5.5L13 17.5"/>',
  chevron: '<path d="M9 5.5 15.5 12 9 18.5"/>',
  back: '<path d="M19.5 12h-14M11 5.5 4.5 12 11 18.5"/>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  alert: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.75h.01"/>',
  clip: '<path d="M18 11.5 12 17.5a4 4 0 0 1-5.7-5.7l7-7a2.8 2.8 0 0 1 4 4l-7 7a1.6 1.6 0 0 1-2.2-2.2l6.2-6.2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  ticket: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v2a2.5 2.5 0 0 0 0 5v2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-2a2.5 2.5 0 0 0 0-5z"/><path d="M13 6v12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
  user: '<circle cx="12" cy="8.5" r="3.75"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  logout: '<path d="M15 8V5.5a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20h7a1.5 1.5 0 0 0 1.5-1.5V16"/><path d="M11 12h9.5M17.5 8.5 21 12l-3.5 3.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.6 7 8.4 5.9L20.4 7"/>',
};

export const hasIcon = (name) => Object.hasOwn(paths, name);

/** Render an icon. Always decorative — pair it with text. */
export function icon(name, { size = 20, className = '' } = {}) {
  const body = paths[name] ?? paths.dot;
  const classes = ['icon', className].filter(Boolean).join(' ');
  return `<svg class="${classes}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
