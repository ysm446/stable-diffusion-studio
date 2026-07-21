/**
 * プロンプト入力中のスニペット自動候補。
 *
 * attachSnippetAutocomplete(textarea) を呼ぶと、カンマ/改行区切りの
 * 入力中セグメントを prefix と照合し、候補メニューを textarea の下に表示する。
 * 候補は ↑↓ で選択、Tab / Enter で挿入、Esc で閉じる。
 *
 * メニュー DOM は 1 つを全 textarea で共有する（同時に開くのは 1 つのため）。
 * スニペット編集タブでの保存後は "snippets-changed" イベントでカタログを再取得する。
 */

let catalog = null;
let catalogPromise = null;

async function loadCatalog() {
  if (catalog) return catalog;
  if (!catalogPromise) {
    catalogPromise = fetch("/api/snippets")
      .then((r) => r.json())
      .then((data) => {
        catalog = Array.isArray(data.snippets) ? data.snippets : [];
        return catalog;
      })
      .catch(() => {
        catalog = [];
        return catalog;
      })
      .finally(() => {
        catalogPromise = null;
      });
  }
  return catalogPromise;
}

window.addEventListener("snippets-changed", () => {
  catalog = null;
});

let menuEl = null;
// 開いているメニューの状態。null なら非表示。
let active = null; // { textarea, range: {start, end}, matches, index }

function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement("div");
  menuEl.className = "snippet-suggest";
  // クリックで textarea のフォーカスが外れないようにする
  menuEl.addEventListener("mousedown", (e) => e.preventDefault());
  document.body.appendChild(menuEl);
  window.addEventListener("scroll", hideMenu, true);
  window.addEventListener("resize", hideMenu);
  return menuEl;
}

function hideMenu() {
  if (!menuEl) return;
  menuEl.classList.remove("is-open");
  menuEl.innerHTML = "";
  active = null;
}

// カーソル位置から補完対象のセグメント（カンマ/改行区切り）を取り出す
function queryInfo(textarea) {
  const caret = textarea.selectionStart ?? 0;
  const before = textarea.value.slice(0, caret);
  const segmentStart = Math.max(before.lastIndexOf(",") + 1, before.lastIndexOf("\n") + 1);
  let start = segmentStart;
  while (start < before.length && /\s/.test(before[start])) start++;
  const query = before.slice(start).trim();
  if (!query || query.includes(":")) return null;
  return { query, start, end: caret };
}

function rankMatches(items, query) {
  const q = query.toLowerCase();
  return items
    .map((item) => {
      const prefix = item.prefix.toLowerCase();
      return {
        item,
        starts: prefix.startsWith(q),
        wordStarts: prefix.split(/\s+/).some((part) => part.startsWith(q)),
        pos: prefix.indexOf(q),
      };
    })
    .sort(
      (a, b) =>
        Number(b.starts) - Number(a.starts) ||
        Number(b.wordStarts) - Number(a.wordStarts) ||
        a.pos - b.pos ||
        a.item.prefix.localeCompare(b.item.prefix)
    )
    .map((e) => e.item);
}

function setActiveIndex(index) {
  if (!active) return;
  active.index = index;
  Array.from(menuEl.children).forEach((el, i) => {
    el.classList.toggle("is-active", i === index);
    if (i === index) el.scrollIntoView({ block: "nearest" });
  });
}

function applySnippet(item) {
  if (!active) return;
  const { textarea, range } = active;
  const value = textarea.value;
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  const suffix = after.trimStart().startsWith(",") || !after.trim() ? ", " : "";
  textarea.value = before + item.body + suffix + after;
  const caret = (before + item.body + suffix).length;
  textarea.focus();
  textarea.setSelectionRange(caret, caret);
  hideMenu();
  // autoGrowTextarea の input ハンドラ（state 反映・高さ調整）を発火させる
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function positionMenu(textarea) {
  const rect = textarea.getBoundingClientRect();
  menuEl.style.left = `${rect.left + window.scrollX}px`;
  menuEl.style.minWidth = `${Math.min(rect.width, 480)}px`;
  menuEl.style.maxWidth = `${Math.max(rect.width, 320)}px`;
  // 表示後の実高さで、画面下にはみ出すなら textarea の上側に出す
  const h = menuEl.offsetHeight;
  const below = rect.bottom + 2;
  const top =
    below + h > window.innerHeight && rect.top - h - 2 > 0
      ? rect.top - h - 2
      : below;
  menuEl.style.top = `${top + window.scrollY}px`;
}

function renderMenu(textarea, info, items) {
  ensureMenu();
  menuEl.innerHTML = "";
  items.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "snippet-suggest-item" + (index === 0 ? " is-active" : "");
    const prefix = document.createElement("span");
    prefix.className = "snippet-suggest-prefix";
    prefix.textContent = item.prefix;
    const source = document.createElement("span");
    source.className = "snippet-suggest-source";
    source.textContent = (item.source || "").replace(".code-snippets", "");
    const desc = document.createElement("span");
    desc.className = "snippet-suggest-desc";
    desc.textContent = item.description || item.name || "";
    btn.append(prefix, source, desc);
    btn.title = item.body;
    btn.addEventListener("click", () => applySnippet(item));
    menuEl.appendChild(btn);
  });
  active = { textarea, range: { start: info.start, end: info.end }, matches: items, index: 0 };
  menuEl.classList.add("is-open");
  positionMenu(textarea); // 高さ計測のため表示後に位置決めする
}

async function updateSuggestions(textarea) {
  const items = await loadCatalog();
  if (document.activeElement !== textarea || items.length === 0) return;
  const info = queryInfo(textarea);
  if (!info || info.query.length < 2) {
    if (active?.textarea === textarea) hideMenu();
    return;
  }
  const q = info.query.toLowerCase();
  const matches = rankMatches(
    items.filter((item) => item.prefix.toLowerCase().includes(q)),
    info.query
  ).slice(0, 8);
  if (matches.length === 0) {
    if (active?.textarea === textarea) hideMenu();
    return;
  }
  renderMenu(textarea, info, matches);
}

export function attachSnippetAutocomplete(textarea) {
  if (!textarea || textarea.dataset.snippetAutocomplete) return textarea;
  textarea.dataset.snippetAutocomplete = "1";
  const update = () => updateSuggestions(textarea);
  textarea.addEventListener("input", update);
  textarea.addEventListener("click", update);
  textarea.addEventListener("focus", update);
  textarea.addEventListener("blur", () => {
    // メニュー内クリック（mousedown で preventDefault 済み）を待ってから閉じる
    setTimeout(() => {
      if (active?.textarea === textarea) hideMenu();
    }, 120);
  });
  textarea.addEventListener("keydown", (event) => {
    if (!active || active.textarea !== textarea || active.matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((active.index + 1) % active.matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((active.index - 1 + active.matches.length) % active.matches.length);
    } else if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      const item = active.matches[active.index];
      if (item) applySnippet(item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hideMenu();
    }
  });
  return textarea;
}
