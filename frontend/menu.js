/**
 * コンテキストメニュー（右クリック・[…] ボタン共用）。
 * entries: [{ icon?, label, danger?, action }]
 */

import { setIconLabel } from "/frontend/icons.js";

let contextMenuEl = null;

export function hideContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

export function showContextMenu(x, y, entries) {
  hideContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  for (const entry of entries) {
    const item = document.createElement("button");
    item.className = "context-menu-item" + (entry.danger ? " danger" : "");
    if (entry.icon) setIconLabel(item, entry.icon, entry.label);
    else item.textContent = entry.label;
    item.addEventListener("click", () => {
      hideContextMenu();
      entry.action();
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  // 画面からはみ出さない位置に調整
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
  contextMenuEl = menu;
}

document.addEventListener("click", hideContextMenu);
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".card, .tree-node")) hideContextMenu();
});
window.addEventListener("blur", hideContextMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideContextMenu();
});
