/**
 * フラットデザインの SVG アイコンセット（ストローク系・currentColor）。
 * 絵文字アイコンの置き換え用。サイズは CSS の .ico（em ベース）で決まる。
 */

const ICONS = {
  trash:
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  pencil:
    '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  folder:
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  "folder-open":
    '<path d="M6 14l1.5-2.9A2 2 0 0 1 9.2 10H20a2 2 0 0 1 1.9 2.5l-1.5 6a2 2 0 0 1-2 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2"/>',
  library:
    '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  film:
    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.9-3.9a2 2 0 0 0-2.8 0L6 19.5"/>',
  sparkles:
    '<path d="M12 3l1.9 5.1a2 2 0 0 0 1.2 1.2L20.2 11l-5.1 1.9a2 2 0 0 0-1.2 1.2L12 19.2l-1.9-5.1a2 2 0 0 0-1.2-1.2L3.8 11l5.1-1.9a2 2 0 0 0 1.2-1.2L12 3z"/><path d="M19 3v4M21 5h-4"/>',
  dice:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1" fill="currentColor" stroke="none"/>',
  restore:
    '<path d="M3 12a9 9 0 1 0 2.9-6.6L3 8"/><path d="M3 3v5h5"/>',
  search:
    '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  puzzle:
    '<path d="M14 7V5a2 2 0 0 0-4 0v2H6a2 2 0 0 0-2 2v3h2a2 2 0 0 1 0 4H4v3a2 2 0 0 0 2 2h3v-2a2 2 0 0 1 4 0v2h3a2 2 0 0 0 2-2v-4h2a2 2 0 0 0 0-4h-2V9a2 2 0 0 0-2-2h-2z"/>',
  save:
    '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  play: '<path d="M6 4.5 19.5 12 6 19.5V4.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  repeat:
    '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  fit:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert:
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  bot:
    '<path d="M12 8V4M8 4h8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M9 13v2M15 13v2"/>',
  music:
    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  clapper:
    '<path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8z"/><path d="M3 11 2.4 8.6a2 2 0 0 1 1.4-2.5l13.6-3.6a2 2 0 0 1 2.4 1.4L20.4 6 3 11z"/><path d="m7.5 9.9-2-3.4M13.3 8.4l-2-3.4"/>',
  file:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 2v6h6"/>',
  "file-text":
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  "arrow-left": '<path d="M19 12H5M12 19l-7-7 7-7"/>',
};

export function iconSvg(name, cls = "") {
  const body = ICONS[name];
  if (!body) return "";
  return (
    `<svg class="ico${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  );
}

/** el の中身を「アイコン + テキスト」にする。text は textNode なのでエスケープ不要。 */
export function setIconLabel(el, name, text = "") {
  el.replaceChildren();
  el.insertAdjacentHTML("beforeend", iconSvg(name));
  if (text) el.appendChild(document.createTextNode(` ${text}`));
}

/** data-icon 属性を持つ要素の先頭にアイコンを挿入する（静的 HTML 用） */
export function applyStaticIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    if (el.querySelector(":scope > .ico")) continue;
    el.insertAdjacentHTML("afterbegin", iconSvg(el.dataset.icon));
  }
}
