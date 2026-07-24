/**
 * ライブラリ画面（3ペイン）
 * 左: フォルダツリー / 中央: サムネイルグリッド / 右: コンテキストパネル
 */

import { initSequenceView, activateSequenceView } from "/frontend/sequence.js";
import { initSnippetsView, activateSnippetsView } from "/frontend/snippets.js";
import { attachSnippetAutocomplete } from "/frontend/snippet-autocomplete.js";
import { showInputDialog } from "/frontend/dialog.js";
import { showContextMenu } from "/frontend/menu.js";
import { iconSvg, setIconLabel, applyStaticIcons } from "/frontend/icons.js";

applyStaticIcons();

const state = {
  tree: null,
  folder: null, // 選択中フォルダ rel（"" はルート、null は未選択）
  items: [],
  selectedId: null,
  selectedIds: new Set(), // 複数選択（一括削除用）
  anchorIndex: null, // Shift 選択の起点
  currentItem: null, // 選択中画像の詳細（動画一覧を含む）
  selectedVideoFile: null, // 下部ストリップでフォーカス中の動画 file
  selectedVideoFiles: new Set(), // 動画の複数選択（一括削除用）
  videoAnchorIndex: null, // Shift 選択の起点
  query: "",
  videoPanel: false, // 画像選択中に動画生成パネルを表示するか
  genBusy: false,
  options: { backends: [], forge_samplers: [], image_workflows: [], video_workflows: [] },
  genImage: {
    backend: "WebUI Forge",
    positive: "",
    negative: "",
    steps: 28,
    cfg: 7.0,
    sampler: "Euler a",
    width: 1024,
    height: 1024,
    seed: -1,
    workflow: "",
  },
  genVideo: {
    prompt: "",
    workflow: "",
    width: "",
    height: "",
    frames: "",
    seed: -1,
    extra: "",
    sections: ["scene", "action", "camera", "style", "prompt"],
    unload_llm: true, // 動画生成前に LLM をアンロードして VRAM を空ける
  },
  rootInfo: null, // /api/library/root の結果
  llm: { models: [], loaded: null, selected: "" },
  genRef: null, // 生成パネル上部に表示する基準画像 {id, image, label}
  genNearId: null, // 「この設定で新規生成」の元画像 ID（生成結果をこの隣に並べる）
  itemDraft: null, // 画像プロパティパネルの編集ドラフト {id, draft}（再描画で編集を失わないため）
  queue: [], // 生成キュー
  lastImageSeed: null, // 復元用（直近の画像シード）
  lastVideoSeed: null, // 復元用（直近の動画シード）
};

// Seed 入力（🎲 ランダム / ♻ 直近シード復元 ボタン付き）
function seedField(labelText, obj, getLast) {
  const div = document.createElement("div");
  div.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const row = document.createElement("div");
  row.className = "seed-row";
  const input = document.createElement("input");
  input.type = "number";
  input.value = obj.seed;
  input.addEventListener("change", () => {
    const n = parseInt(input.value, 10);
    obj.seed = Number.isNaN(n) ? -1 : n;
  });
  const dice = document.createElement("button");
  setIconLabel(dice, "dice");
  dice.title = "ランダム（-1）";
  dice.addEventListener("click", () => {
    obj.seed = -1;
    input.value = -1;
  });
  const restore = document.createElement("button");
  setIconLabel(restore, "restore");
  restore.title = "直近に使ったシードに戻す";
  restore.addEventListener("click", () => {
    const last = getLast();
    if (last !== null && last !== undefined) {
      obj.seed = last;
      input.value = last;
    } else {
      setGenStatus("復元できるシードがありません", true);
    }
  });
  row.append(input, dice, restore);
  div.append(label, row);
  return div;
}

const VIDEO_SECTIONS = ["scene", "action", "camera", "style", "prompt"];

function rootName() {
  const root = state.rootInfo?.root || "";
  return root.split(/[\\/]/).filter(Boolean).pop() || "ライブラリ";
}

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail || detail;
    } catch {}
    throw new Error(detail);
  }
  return res.json();
}

const apiJson = (path, method, body) =>
  api(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// ステータス表示
// ---------------------------------------------------------------------------

let statusTimer = null;

function setStatus(text, isError = false) {
  const el = $("#status");
  el.textContent = text;
  el.className = isError ? "error" : "";
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => (el.textContent = ""), 5000);
}

async function run(fn, doneMessage = "") {
  try {
    const result = await fn();
    if (doneMessage) setStatus(doneMessage);
    return result;
  } catch (e) {
    setStatus(e.message, true);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// フォルダツリー
// ---------------------------------------------------------------------------

async function loadTree() {
  state.tree = await api("/api/library/tree");
  renderTree();
}

function renderTree() {
  const container = $("#tree");
  container.innerHTML = "";
  container.appendChild(buildTreeList(state.tree, true));
}

// 折りたたみ中のフォルダ（rel のセット）。リロード後も保持する。
const TREE_COLLAPSED_KEY = "studio_tree_collapsed";
let treeCollapsed;
try {
  treeCollapsed = new Set(JSON.parse(localStorage.getItem(TREE_COLLAPSED_KEY) || "[]"));
} catch {
  treeCollapsed = new Set();
}

function persistTreeCollapsed() {
  localStorage.setItem(TREE_COLLAPSED_KEY, JSON.stringify([...treeCollapsed]));
}

function buildTreeList(node, isRoot) {
  const ul = document.createElement("ul");
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-node";
  row.dataset.rel = node.rel;
  if (state.folder === node.rel) row.classList.add("is-selected");

  const hasChildren = node.children && node.children.length > 0;
  const collapsed = treeCollapsed.has(node.rel);

  const toggle = document.createElement("span");
  toggle.className = "tree-toggle";
  toggle.innerHTML = hasChildren ? iconSvg(collapsed ? "chevron-right" : "chevron-down") : "";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!hasChildren) return;
    if (collapsed) treeCollapsed.delete(node.rel);
    else treeCollapsed.add(node.rel);
    persistTreeCollapsed();
    renderTree();
  });
  row.appendChild(toggle);

  const label = document.createElement("span");
  setIconLabel(label, isRoot ? "library" : "folder", isRoot ? rootName() : node.name);
  if (isRoot) label.title = state.rootInfo?.root || "";
  row.appendChild(label);

  if (node.item_count > 0) {
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(node.item_count);
    row.appendChild(count);
  }

  // […] メニュー（右クリックでも同じメニューを表示）
  const more = document.createElement("button");
  more.type = "button";
  more.className = "tree-more";
  more.title = "メニュー";
  setIconLabel(more, "ellipsis");
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = more.getBoundingClientRect();
    showFolderMenu(node, isRoot, rect.left, rect.bottom + 2);
  });
  row.appendChild(more);

  row.addEventListener("click", () => selectFolder(node.rel));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showFolderMenu(node, isRoot, e.clientX, e.clientY);
  });
  // フォルダ自体のドラッグ（別フォルダへの移動）
  if (!isRoot) {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      folderDragRel = node.rel;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-folder-rel", node.rel);
      e.dataTransfer.setData("text/plain", node.rel);
    });
    row.addEventListener("dragend", () => (folderDragRel = null));
  }
  setupFolderDrop(row, node.rel);
  li.appendChild(row);

  if (!collapsed) {
    for (const child of node.children) {
      li.appendChild(buildTreeList(child, false));
    }
  }
  ul.appendChild(li);
  return ul;
}

function showFolderMenu(node, isRoot, x, y) {
  if (state.folder !== node.rel) selectFolder(node.rel);
  const entries = [
    {
      icon: "folder",
      label: "新規フォルダ（この中に）",
      action: () => createFolderIn(node.rel),
    },
    {
      icon: "folder-open",
      label: "エクスプローラーで開く",
      action: () => revealFolder(node.rel),
    },
  ];
  if (!isRoot) {
    entries.push(
      {
        icon: "pencil",
        label: "名前の変更",
        action: () => renameFolderRel(node.rel),
      },
      {
        icon: "trash",
        label: "削除",
        danger: true,
        action: () => deleteFolderRel(node.rel),
      }
    );
  }
  showContextMenu(x, y, entries);
}

// ドラッグ中のフォルダ rel（dragover ではデータを読めないためモジュール変数で持つ）
let folderDragRel = null;

// src フォルダを dest フォルダの中へ移動できるか（自分自身・子孫・現在の親は不可）
function folderMoveOk(src, dest) {
  if (!src) return false;
  const parent = src.split("/").slice(0, -1).join("/");
  return dest !== src && !dest.startsWith(src + "/") && dest !== parent;
}

function setupFolderDrop(row, rel) {
  row.addEventListener("dragover", (e) => {
    const types = e.dataTransfer.types;
    if (
      types.includes("application/x-item-id") ||
      (types.includes("application/x-folder-rel") && folderMoveOk(folderDragRel, rel))
    ) {
      e.preventDefault();
      row.classList.add("is-drop-target");
    }
  });
  row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
  row.addEventListener("drop", async (e) => {
    e.preventDefault();
    row.classList.remove("is-drop-target");
    // フォルダのドロップ → このフォルダの中へ移動
    const srcFolder = e.dataTransfer.getData("application/x-folder-rel");
    if (srcFolder) {
      if (!folderMoveOk(srcFolder, rel)) return;
      await run(async () => {
        const res = await apiJson("/api/library/folders/move", "POST", {
          rel: srcFolder,
          dest_parent: rel,
        });
        // 選択中のフォルダが移動対象（またはその中）なら新しいパスへ追従
        if (state.folder === srcFolder || state.folder?.startsWith(srcFolder + "/")) {
          state.folder = res.rel + state.folder.slice(srcFolder.length);
          updateHash();
        }
        await refresh();
      }, "フォルダを移動しました");
      return;
    }
    let ids = [];
    try {
      ids = JSON.parse(e.dataTransfer.getData("application/x-item-ids") || "[]");
    } catch {
      ids = [];
    }
    if (!ids.length) {
      const single = e.dataTransfer.getData("application/x-item-id");
      if (single) ids = [single];
    }
    // すでにそのフォルダにあるものは除外（同一フォルダへの移動はサーバーがエラーにする）
    const byId = new Map(state.items.map((it) => [it.id, it]));
    ids = ids.filter((id) => byId.get(id)?.folder !== rel);
    if (!ids.length) return;
    await run(async () => {
      for (const itemId of ids) {
        await apiJson(`/api/library/items/${itemId}/move`, "POST", { folder: rel });
      }
      if (ids.includes(state.selectedId)) state.selectedId = null;
      ids.forEach((itemId) => state.selectedIds.delete(itemId));
      await refresh();
    }, ids.length > 1 ? `${ids.length} 件移動しました` : "移動しました");
  });
}

function updateHash() {
  const p = new URLSearchParams();
  if (state.folder) p.set("folder", state.folder);
  if (state.selectedId) p.set("item", state.selectedId);
  if (state.videoPanel) p.set("video", "1");
  const next = p.toString();
  if (location.hash.slice(1) !== next) location.hash = next;
}

async function selectFolder(rel) {
  state.folder = rel;
  state.selectedId = null;
  state.selectedIds = new Set();
  state.anchorIndex = null;
  state.videoPanel = false;
  state.query = "";
  state.genRef = null; // 別フォルダに移ったら基準画像はクリア
  state.genNearId = null;
  $("#search").value = "";
  updateHash();
  renderTree();
  await loadItems();
  renderContext();
}

// フォルダ操作 ---------------------------------------------------------------

function requireFolder() {
  if (state.folder === null) {
    setStatus("フォルダを選択してください", true);
    return false;
  }
  return true;
}

async function createFolderIn(parentRel) {
  const name = await showInputDialog("新しいフォルダ名:");
  if (!name) return;
  await run(async () => {
    const res = await apiJson("/api/library/folders", "POST", {
      parent: parentRel,
      name,
    });
    await loadTree();
    await selectFolder(res.rel);
  }, "フォルダを作成しました");
}

async function renameFolderRel(rel) {
  if (rel === "") {
    setStatus("ルートはリネームできません", true);
    return;
  }
  const current = rel.split("/").pop();
  const name = await showInputDialog("新しいフォルダ名:", current);
  if (!name || name === current) return;
  await run(async () => {
    const res = await apiJson("/api/library/folders/rename", "POST", {
      rel,
      new_name: name,
    });
    await loadTree();
    await selectFolder(res.rel);
  }, "リネームしました");
}

async function deleteFolderRel(rel) {
  if (rel === "") {
    setStatus("ルートは削除できません", true);
    return;
  }
  if (!confirm(`フォルダ「${rel}」を削除しますか？\n中の画像・動画もすべて削除されます。`)) return;
  await run(async () => {
    await api(
      `/api/library/folders?rel=${encodeURIComponent(rel)}&recursive=true`,
      { method: "DELETE" }
    );
    await loadTree();
    await selectFolder(rel.split("/").slice(0, -1).join("/"));
  }, "フォルダを削除しました");
}

async function revealFolder(rel) {
  await run(
    () => apiJson("/api/library/folders/reveal", "POST", { rel }),
    "エクスプローラーで開きました"
  );
}

$("#btn-folder-new").addEventListener("click", async () => {
  if (!requireFolder()) return;
  await createFolderIn(state.folder);
});

// 選択中のフォルダをエクスプローラーで開く（未選択・ルート選択時はライブラリルート）
$("#btn-folder-open").addEventListener("click", async () => {
  await revealFolder(state.folder ?? "");
});


// ---------------------------------------------------------------------------
// グリッド
// ---------------------------------------------------------------------------

// グリッドの表示順（"desc" = 新しい→古い / "asc" = 古い→新しい）。リロード後も保持する。
const SORT_ORDER_KEY = "studio_sort_order";
let sortOrder = localStorage.getItem(SORT_ORDER_KEY) === "asc" ? "asc" : "desc";

async function loadItems() {
  if (state.folder === null) {
    state.items = [];
    renderGrid();
    return;
  }
  const params = new URLSearchParams({ folder: state.folder });
  if (state.query) {
    params.set("q", state.query);
    params.set("search_mode", $("#search-mode").value);
  }
  const res = await api(`/api/library/items?${params}`);
  state.items = res.items;
  // 検索結果は関連度順なので反転しない
  if (sortOrder === "asc" && !state.query) state.items.reverse();
  if (res.note) setStatus(res.note, true);
  renderGrid();
}

// 新規生成されてまだクリックされていないもの（NEW バッジ表示用）。
// 画像はアイテム ID、動画は「アイテムID/videos/vNNN.mp4」をキーに、
// リロード・再起動後も保持し、クリックしたら解除する。
const NEW_ITEMS_KEY = "studio_new_item_ids";
const NEW_VIDEOS_KEY = "studio_new_video_ids";

function loadNewSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
}

function persistNewSet(key, set) {
  // 増えすぎないよう直近 300 件だけ保持
  localStorage.setItem(key, JSON.stringify([...set].slice(-300)));
}

const newItemIds = loadNewSet(NEW_ITEMS_KEY);
const newVideoIds = loadNewSet(NEW_VIDEOS_KEY);

function markItemNew(id) {
  newItemIds.add(id);
  persistNewSet(NEW_ITEMS_KEY, newItemIds);
}

function markItemSeen(id) {
  if (newItemIds.delete(id)) persistNewSet(NEW_ITEMS_KEY, newItemIds);
}

function markVideoNew(itemId, file) {
  newVideoIds.add(`${itemId}/${file}`);
  persistNewSet(NEW_VIDEOS_KEY, newVideoIds);
}

function markVideoSeen(itemId, file) {
  const removed = newVideoIds.delete(`${itemId}/${file}`);
  if (removed) persistNewSet(NEW_VIDEOS_KEY, newVideoIds);
  return removed;
}

// 未確認の新規動画を持つ画像か（グリッドカードの NEW 表示用）
function hasNewVideo(itemId) {
  const prefix = `${itemId}/`;
  for (const key of newVideoIds) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

// 削除された動画の NEW キーを掃除する（アイテムの動画一覧が分かったとき）
function pruneNewVideos(item) {
  if (!item?.id) return;
  const files = new Set((item.videos || []).map((v) => `${item.id}/${v.file}`));
  let changed = false;
  for (const key of [...newVideoIds]) {
    if (key.startsWith(`${item.id}/`) && !files.has(key)) {
      newVideoIds.delete(key);
      changed = true;
    }
  }
  if (changed) persistNewSet(NEW_VIDEOS_KEY, newVideoIds);
}

// NEW バッジ。video=true は動画由来（琥珀色・🎞 付き）
function makeNewBadge(video = false) {
  const nb = document.createElement("span");
  nb.className = "new-badge" + (video ? " video" : "");
  if (video) setIconLabel(nb, "film", "NEW");
  else nb.textContent = "NEW";
  return nb;
}

function renderGrid() {
  const grid = $("#grid");
  grid.innerHTML = "";
  if (state.folder === null) {
    grid.innerHTML = '<p class="grid-empty">フォルダを選択してください</p>';
    return;
  }
  if (state.items.length === 0) {
    grid.innerHTML = `<p class="grid-empty">${
      state.query ? "検索結果がありません" : "画像がありません（右下の「取り込み」またはドラッグ＆ドロップ）"
    }</p>`;
    return;
  }
  state.items.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = item.id;
    if (state.selectedIds.has(item.id)) card.classList.add("is-selected");
    if (item.id === state.selectedId) card.classList.add("is-focused");
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      // 複数選択中のカードをドラッグしたら選択全体を対象にする
      //（フォルダ移動もグリッド内並べ替えもまとめて動かす）
      const multi = state.selectedIds.has(item.id) && state.selectedIds.size > 1;
      internalDragIds = multi ? [...state.selectedIds] : [item.id];
      e.dataTransfer.setData("application/x-item-id", item.id);
      e.dataTransfer.setData(
        "application/x-item-ids",
        JSON.stringify(internalDragIds)
      );
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      internalDragIds = null;
      card.classList.remove("drop-before", "drop-after");
    });
    // グリッド内での並べ替え
    card.addEventListener("dragover", (e) => {
      if (!internalDragIds || internalDragIds.includes(item.id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      card.classList.toggle("drop-after", after);
      card.classList.toggle("drop-before", !after);
    });
    card.addEventListener("dragleave", () =>
      card.classList.remove("drop-before", "drop-after")
    );
    card.addEventListener("drop", (e) => {
      card.classList.remove("drop-before", "drop-after");
      let dragged = [];
      try {
        dragged = JSON.parse(e.dataTransfer.getData("application/x-item-ids") || "[]");
      } catch {}
      if (!dragged.length) {
        const single = e.dataTransfer.getData("application/x-item-id");
        if (single) dragged = [single];
      }
      if (!dragged.length || dragged.includes(item.id)) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = card.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      reorderItems(dragged, item.id, after);
    });

    const img = document.createElement("img");
    img.loading = "lazy";
    img.draggable = false; // ネイティブの画像ドラッグ（＝複製の原因）を無効化
    img.src = `/api/library/file/${item.id}/${item.thumb || "thumb.jpg"}`;
    img.alt = item.prompt || item.id;
    card.appendChild(img);

    if (item.video_count > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      setIconLabel(badge, "film", String(item.video_count));
      card.appendChild(badge);
    }

    if (newItemIds.has(item.id)) {
      card.classList.add("is-new");
      card.appendChild(makeNewBadge());
    } else if (hasNewVideo(item.id)) {
      // 未確認の新規動画がある画像にも NEW（動画側をクリックすると消える）
      card.classList.add("is-new-video");
      card.appendChild(makeNewBadge(true));
    }

    const caption = document.createElement("div");
    caption.className = "card-caption";
    caption.textContent = item.prompt || item.caption || item.id;
    card.appendChild(caption);

    card.addEventListener("click", (e) => handleCardClick(item.id, index, e));
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // 複数選択されていて右クリックがその中なら選択を維持、そうでなければ単一選択に
      if (!state.selectedIds.has(item.id)) {
        state.selectedIds = new Set([item.id]);
        state.anchorIndex = index;
        selectItem(item.id);
      }
      const multi = state.selectedIds.size > 1;
      const entries = [];
      if (multi) {
        const ids = [...state.selectedIds];
        entries.push({
          icon: "trash",
          label: `選択した ${ids.length} 件を削除`,
          danger: true,
          action: () => bulkDelete(ids),
        });
      } else {
        entries.push(
          {
            icon: "sparkles",
            label: "この設定で新規生成",
            action: async () => {
              const full = await run(() => api(`/api/library/items/${item.id}`));
              if (full) useItemForGeneration(full);
            },
          },
          { icon: "folder-open", label: "ファイルの場所を開く", action: () => revealItem(item.id) },
          {
            icon: "film",
            label: "動画を生成...",
            action: async () => {
              await selectItem(item.id);
              state.videoPanel = true;
              updateHash();
              await renderContext();
            },
          },
          {
            icon: "trash",
            label: "削除",
            danger: true,
            action: () => deleteItemById(item.id, item.video_count || 0),
          }
        );
      }
      showContextMenu(e.clientX, e.clientY, entries);
    });
    grid.appendChild(card);
  });
}

// カードのクリック（修飾キーで複数選択）
function handleCardClick(itemId, index, e) {
  markItemSeen(itemId); // クリックしたら NEW 表示を解除（後続の renderGrid で反映）
  if (e.shiftKey && state.anchorIndex != null) {
    // 範囲選択
    const [a, b] = [state.anchorIndex, index].sort((x, y) => x - y);
    state.selectedIds = new Set(state.items.slice(a, b + 1).map((it) => it.id));
    state.selectedId = itemId;
    state.currentItem = null;
    state.selectedVideoFile = null;
    renderGrid();
    renderVideoStrip();
    renderContext();
  } else if (e.ctrlKey || e.metaKey) {
    // トグル選択
    if (state.selectedIds.has(itemId)) state.selectedIds.delete(itemId);
    else state.selectedIds.add(itemId);
    state.anchorIndex = index;
    // フォーカスは選択が残っていれば最後にクリックしたもの
    state.selectedId = state.selectedIds.has(itemId)
      ? itemId
      : [...state.selectedIds].at(-1) || null;
    state.currentItem = null;
    state.selectedVideoFile = null;
    renderGrid();
    renderVideoStrip();
    renderContext();
  } else {
    // 単一選択
    state.selectedIds = new Set([itemId]);
    state.anchorIndex = index;
    selectItem(itemId);
  }
}

async function bulkDelete(ids) {
  if (!ids.length) return;
  const totalVideos = state.items
    .filter((it) => ids.includes(it.id))
    .reduce((n, it) => n + (it.video_count || 0), 0);
  const warn = totalVideos > 0 ? `\n紐づく動画 ${totalVideos} 件も削除されます。` : "";
  if (!confirm(`選択した ${ids.length} 件の画像を削除しますか？${warn}`)) return;
  await run(async () => {
    const res = await apiJson("/api/library/items/delete", "POST", { ids });
    state.selectedIds = new Set();
    state.selectedId = null;
    state.currentItem = null;
    await refresh();
    setStatus(`${res.deleted} 件を削除しました`);
  });
}

async function selectItem(itemId) {
  markItemSeen(itemId);
  state.selectedId = itemId;
  state.selectedIds = new Set([itemId]);
  state.selectedVideoFile = null;
  state.selectedVideoFiles = new Set();
  state.videoAnchorIndex = null;
  state.videoPanel = false;
  state.currentItem = await run(() => api(`/api/library/items/${itemId}`));
  pruneNewVideos(state.currentItem); // 削除済み動画の NEW を掃除してから描画
  updateHash();
  renderGrid();
  renderVideoStrip();
  await renderContext();
}

// 下部の動画ストリップ（選択画像の動画を横並び表示）
function renderVideoStrip() {
  const strip = $("#video-strip");
  const list = $("#video-strip-list");
  const item = state.currentItem;
  const videos = (item && item.videos) || [];
  // 単一選択のときだけ表示（複数選択中は非表示）
  if (!state.selectedId || state.selectedIds.size > 1) {
    strip.hidden = true;
    list.innerHTML = "";
    return;
  }
  strip.hidden = false;
  const selCount = state.selectedVideoFiles.size;
  $("#video-strip-title").textContent = videos.length
    ? selCount > 1
      ? `動画（${videos.length}）— ${selCount} 件選択中（Del で削除）`
      : `動画（${videos.length}）— クリックでプロパティ / Ctrl・Shift で複数選択 / ドロップで追加`
    : "この画像に動画を追加：動画ファイルをここにドロップ";
  list.innerHTML = "";
  if (videos.length === 0) {
    const hint = document.createElement("div");
    hint.className = "vstrip-empty";
    setIconLabel(hint, "film", "生成済みの動画ファイルをドロップして登録");
    list.appendChild(hint);
  }
  videos.forEach((v, index) => {
    const card = document.createElement("div");
    card.className = "vstrip-card";
    if (state.selectedVideoFiles.has(v.file)) card.classList.add("is-selected");
    if (v.file === state.selectedVideoFile) card.classList.add("is-focused");
    const video = document.createElement("video");
    video.src = `/api/library/file/${item.id}/${v.file}`;
    video.preload = "metadata";
    video.muted = true;
    card.appendChild(video);
    const label = document.createElement("div");
    label.className = "vstrip-label";
    label.textContent = v.prompt || v.file.split("/").pop();
    label.title = v.file;
    card.appendChild(label);
    if (newVideoIds.has(`${item.id}/${v.file}`)) {
      card.classList.add("is-new");
      card.appendChild(makeNewBadge(true));
    }
    card.addEventListener("click", (e) => handleVideoClick(v.file, index, e));
    list.appendChild(card);
  });
}

// 動画ストリップのクリック（修飾キーで複数選択）
async function handleVideoClick(file, index, e) {
  // クリックで NEW 解除（画像カード側の 🎞 NEW も消えるようグリッドを更新）
  if (markVideoSeen(state.currentItem?.id ?? state.selectedId, file)) renderGrid();
  // 動画生成パネル表示中でも、動画をクリックしたらそのプロパティ表示へ切り替える
  // （renderContext では videoPanel が selectedVideoFile より優先されるため）
  if (state.videoPanel) {
    state.videoPanel = false;
    updateHash();
  }
  const videos = (state.currentItem?.videos || []).map((v) => v.file);
  if (e.shiftKey && state.videoAnchorIndex != null) {
    const [a, b] = [state.videoAnchorIndex, index].sort((x, y) => x - y);
    state.selectedVideoFiles = new Set(videos.slice(a, b + 1));
    state.selectedVideoFile = file;
  } else if (e.ctrlKey || e.metaKey) {
    if (state.selectedVideoFiles.has(file)) state.selectedVideoFiles.delete(file);
    else state.selectedVideoFiles.add(file);
    state.videoAnchorIndex = index;
    state.selectedVideoFile = state.selectedVideoFiles.has(file)
      ? file
      : [...state.selectedVideoFiles].at(-1) || null;
  } else {
    state.selectedVideoFiles = new Set([file]);
    state.selectedVideoFile = file;
    state.videoAnchorIndex = index;
  }
  renderVideoStrip();
  await renderContext();
}

async function bulkDeleteVideos(itemId, files) {
  if (!files.length) return;
  if (!confirm(`選択した ${files.length} 件の動画を削除しますか？`)) return;
  await run(async () => {
    const res = await apiJson(`/api/library/items/${itemId}/videos/delete`, "POST", { files });
    state.selectedVideoFiles = new Set();
    state.selectedVideoFile = null;
    state.currentItem = res;
    pruneNewVideos(res);
    renderVideoStrip();
    await renderContext();
    await loadItems();
    setStatus(`${res.deleted} 件の動画を削除しました`);
  });
}

async function deleteItemById(itemId, videoCount = 0) {
  const warn = videoCount > 0 ? `\n紐づく動画 ${videoCount} 件も削除されます。` : "";
  if (!confirm(`この画像を削除しますか？${warn}`)) return;
  await run(async () => {
    await api(`/api/library/items/${itemId}`, { method: "DELETE" });
    if (state.selectedId === itemId) state.selectedId = null;
    state.selectedIds.delete(itemId);
    await refresh();
  }, "画像を削除しました");
}

async function revealItem(itemId) {
  await run(
    () => api(`/api/library/items/${itemId}/reveal`, { method: "POST" }),
    "エクスプローラーで開きました"
  );
}

// 保存済み画像のプロンプト・パラメータを生成パネルに読み込む
async function useItemForGeneration(item) {
  const g = state.genImage;
  const p = item.params || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  g.positive = item.prompt || "";
  g.negative = item.negative_prompt || "";
  if (p.backend === "ComfyUI" || p.backend === "WebUI Forge") g.backend = p.backend;
  if (p.workflow) g.workflow = p.workflow;
  if (num(p.width) !== undefined) g.width = num(p.width);
  if (num(p.height) !== undefined) g.height = num(p.height);
  if (num(p.steps) !== undefined) g.steps = num(p.steps);
  const cfg = num(p.cfg) ?? num(p.cfg_scale);
  if (cfg !== undefined) g.cfg = cfg;
  if (p.sampler && state.options.forge_samplers.includes(p.sampler)) g.sampler = p.sampler;
  // Seed は流用（そのまま再現）。ランダムにしたいときはフォームで -1 にできる
  if (item.seed !== null && item.seed !== undefined) {
    g.seed = item.seed;
    state.lastImageSeed = item.seed;
  }

  const folder = item.folder ?? state.folder ?? "";
  // フォルダ選択に切り替える（selectedId を外して生成パネルを表示）
  state.folder = folder;
  state.selectedId = null;
  state.selectedIds = new Set();
  state.videoPanel = false;
  state.query = "";
  $("#search").value = "";
  // 生成パネル上部に元画像を表示（生成するたびに更新される）
  state.genRef = { id: item.id, image: item.image, label: "元の画像" };
  // 生成結果は元画像の隣に並べる（フォルダを移るまで有効）
  state.genNearId = item.id;
  updateHash();
  renderTree();
  await loadItems();
  await renderContext();
  setStatus("プロンプト・パラメータを生成パネルに読み込みました。編集して生成できます");
}

// ---------------------------------------------------------------------------
// 右クリックメニュー
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// スニペット挿入ピッカー
// ---------------------------------------------------------------------------

let snippetCache = null;

// スニペット編集タブでの保存・削除後にキャッシュを無効化する
window.addEventListener("snippets-changed", () => {
  snippetCache = null;
});

async function loadSnippets(force = false) {
  if (snippetCache && !force) return snippetCache;
  try {
    snippetCache = (await api("/api/snippets")).snippets;
  } catch {
    snippetCache = [];
  }
  return snippetCache;
}

async function openSnippetPicker(onPick) {
  const snippets = await loadSnippets();
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";
  const box = document.createElement("div");
  box.className = "dialog-box snippet-picker";

  const title = document.createElement("div");
  title.className = "dialog-title";
  title.textContent = `スニペットを挿入（${snippets.length}）`;
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "検索（prefix / 名前 / 説明 / 本文）";
  const list = document.createElement("div");
  list.className = "snippet-list";
  const cancel = document.createElement("button");
  cancel.textContent = "閉じる";

  box.append(title, search, list, cancel);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  cancel.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const hits = (
      q
        ? snippets.filter(
            (s) =>
              s.prefix.toLowerCase().includes(q) ||
              s.name.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q) ||
              s.body.toLowerCase().includes(q)
          )
        : snippets
    ).slice(0, 200);
    list.innerHTML = "";
    if (hits.length === 0) {
      list.innerHTML = '<p class="palette-sub">該当なし</p>';
      return;
    }
    for (const s of hits) {
      const row = document.createElement("div");
      row.className = "snippet-row";
      const main = document.createElement("div");
      main.className = "snippet-main";
      const label = document.createElement("div");
      label.className = "snippet-label";
      label.textContent = s.prefix ? `${s.prefix} — ${s.name}` : s.name;
      const body = document.createElement("div");
      body.className = "snippet-body";
      body.textContent = s.body;
      main.append(label, body);
      if (s.description) {
        const desc = document.createElement("div");
        desc.className = "snippet-desc";
        desc.textContent = s.description;
        main.appendChild(desc);
      }
      row.appendChild(main);
      row.title = `${s.source}`;
      row.addEventListener("click", () => {
        onPick(s.body);
        close();
      });
      list.appendChild(row);
    }
  };
  search.addEventListener("input", render);
  render();
  search.focus();
}

// 検索 -----------------------------------------------------------------------

let searchTimer = null;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    state.query = e.target.value.trim();
    state.selectedId = null;
    await run(loadItems);
    renderContext();
  }, 300);
});

$("#search-mode").addEventListener("change", async () => {
  if (state.query) {
    await run(loadItems);
  }
});

// 取り込み -------------------------------------------------------------------

async function importFiles(files) {
  if (!requireFolder()) return;
  const images = [...files].filter((f) =>
    /\.(png|jpe?g|webp)$/i.test(f.name)
  );
  if (images.length === 0) return;
  let done = 0;
  for (const file of images) {
    const form = new FormData();
    form.append("folder", state.folder);
    form.append("file", file);
    const ok = await run(() =>
      api("/api/library/items/import", { method: "POST", body: form })
    );
    if (ok) done += 1;
  }
  setStatus(`${done} / ${images.length} 件を取り込みました`);
  await refresh();
}

$("#import-files").addEventListener("change", async (e) => {
  await importFiles(e.target.files);
  e.target.value = "";
});

// グリッド内ドラッグ（並べ替え）の識別用。アプリ内カードのドラッグ中は import しない
let internalDragIds = null;

async function reorderItems(draggedIds, targetId, after) {
  const dragSet = new Set(draggedIds);
  if (dragSet.has(targetId)) return;
  const current = state.items.map((it) => it.id);
  // ドラッグ中のカードは現在のグリッド順を保ったまま、ターゲット位置へまとめて挿入する
  const moving = current.filter((id) => dragSet.has(id));
  if (moving.length === 0) return;
  const ids = current.filter((id) => !dragSet.has(id));
  const to = ids.indexOf(targetId);
  if (to < 0) return;
  ids.splice(after ? to + 1 : to, 0, ...moving);
  // 楽観的に並べ替えて即描画
  const byId = new Map(state.items.map((it) => [it.id, it]));
  state.items = ids.map((id) => byId.get(id));
  renderGrid();
  // サーバーの sort_order は先頭が最新（降順）。昇順表示中は逆順で送る
  const order = sortOrder === "asc" ? [...ids].reverse() : ids;
  await run(() =>
    apiJson("/api/library/items/reorder", "POST", { folder: state.folder, order })
  );
}

// 動画ストリップへの動画ファイルドロップ（選択画像に登録）
const VIDEO_EXT = /\.(mp4|webm|avi|mov|mkv)$/i;

async function importVideosToItem(files) {
  if (!state.selectedId) return;
  const vids = [...files].filter((f) => VIDEO_EXT.test(f.name));
  if (vids.length === 0) {
    setStatus("動画ファイル（mp4/webm/mov 等）をドロップしてください", true);
    return;
  }
  let done = 0;
  for (const file of vids) {
    const form = new FormData();
    form.append("file", file);
    form.append("probe", "true"); // メタデータ抽出を有効化
    const ok = await run(() =>
      api(`/api/library/items/${state.selectedId}/videos`, { method: "POST", body: form })
    );
    if (ok) done += 1;
  }
  setStatus(`${done} / ${vids.length} 件の動画を登録しました`);
  await reloadCurrentItem();
  await loadItems();
}

const videoStrip = $("#video-strip");
videoStrip.addEventListener("dragover", (e) => {
  if ([...e.dataTransfer.types].includes("Files")) {
    e.preventDefault();
    videoStrip.classList.add("is-drop-target");
  }
});
videoStrip.addEventListener("dragleave", (e) => {
  if (!videoStrip.contains(e.relatedTarget)) videoStrip.classList.remove("is-drop-target");
});
videoStrip.addEventListener("drop", async (e) => {
  videoStrip.classList.remove("is-drop-target");
  if (e.dataTransfer.files.length === 0) return;
  e.preventDefault();
  await importVideosToItem(e.dataTransfer.files);
});

const grid = $("#grid");
grid.addEventListener("dragover", (e) => {
  // 外部ファイルのドロップ（取り込み）だけ受け付ける。カードの並べ替えはカード側で処理
  if (!internalDragIds && [...e.dataTransfer.types].includes("Files")) {
    e.preventDefault();
    grid.classList.add("is-drop-target");
  }
});
grid.addEventListener("dragleave", () => grid.classList.remove("is-drop-target"));
grid.addEventListener("drop", async (e) => {
  grid.classList.remove("is-drop-target");
  if (internalDragIds) return; // アプリ内ドラッグは取り込まない
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) await importFiles(e.dataTransfer.files);
});

// Del キー：動画を選択中なら動画を、そうでなければ画像を一括削除（入力中は無効）
document.addEventListener("keydown", (e) => {
  if (e.key !== "Delete") return;
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || document.activeElement?.isContentEditable) return;
  if ($("#view-library").hidden) return; // ライブラリタブでのみ
  if (state.selectedVideoFiles.size > 0 && state.selectedId) {
    e.preventDefault();
    bulkDeleteVideos(state.selectedId, [...state.selectedVideoFiles]);
  } else if (state.selectedIds.size > 0) {
    e.preventDefault();
    bulkDelete([...state.selectedIds]);
  }
});

// ---------------------------------------------------------------------------
// 右パネル
// ---------------------------------------------------------------------------

async function renderContext() {
  const el = $("#context");
  el.innerHTML = "";
  // 動画を複数選択中はまとめて操作するパネル（画像より優先）
  if (state.selectedVideoFiles.size > 1 && state.selectedId) {
    renderMultiVideoContext(el);
    return;
  }
  // 画像を複数選択中
  if (state.selectedIds.size > 1) {
    renderMultiSelectContext(el);
    return;
  }
  if (state.selectedId) {
    let item = state.currentItem;
    if (!item) item = state.currentItem = await run(() => api(`/api/library/items/${state.selectedId}`));
    if (item) {
      if (state.videoPanel) {
        renderVideoGenContext(el, item);
      } else if (state.selectedVideoFile) {
        const video = (item.videos || []).find((v) => v.file === state.selectedVideoFile);
        if (video) renderVideoPropsContext(el, item, video);
        else {
          state.selectedVideoFile = null;
          renderItemContext(el, item);
        }
      } else {
        renderItemContext(el, item);
      }
      return;
    }
    state.selectedId = null;
    state.currentItem = null;
  }
  renderFolderContext(el);
}

function renderMultiVideoContext(el) {
  const files = [...state.selectedVideoFiles];
  const h = document.createElement("h2");
  h.textContent = `動画 ${files.length} 件を選択中`;
  el.appendChild(h);

  const info = document.createElement("div");
  info.className = "placeholder";
  info.textContent =
    "Ctrl+クリックで追加/解除、Shift+クリックで範囲選択。\nDel キーまたは下のボタンで一括削除できます。";
  info.style.whiteSpace = "pre-wrap";
  el.appendChild(info);

  const delBtn = document.createElement("button");
  delBtn.className = "danger";
  setIconLabel(delBtn, "trash", `選択した ${files.length} 件の動画を削除`);
  delBtn.addEventListener("click", () => bulkDeleteVideos(state.selectedId, files));
  el.appendChild(delBtn);

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "選択を解除";
  clearBtn.addEventListener("click", () => {
    state.selectedVideoFiles = new Set(state.selectedVideoFile ? [state.selectedVideoFile] : []);
    renderVideoStrip();
    renderContext();
  });
  el.appendChild(clearBtn);
}

function renderMultiSelectContext(el) {
  const ids = [...state.selectedIds];
  const h = document.createElement("h2");
  h.textContent = `${ids.length} 件を選択中`;
  el.appendChild(h);

  const info = document.createElement("div");
  info.className = "placeholder";
  info.textContent =
    "Ctrl+クリックで追加/解除、Shift+クリックで範囲選択。\nDel キーまたは下のボタンで一括削除できます。";
  info.style.whiteSpace = "pre-wrap";
  el.appendChild(info);

  const delBtn = document.createElement("button");
  delBtn.className = "danger";
  setIconLabel(delBtn, "trash", `選択した ${ids.length} 件を削除`);
  delBtn.addEventListener("click", () => bulkDelete(ids));
  el.appendChild(delBtn);

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "選択を解除";
  clearBtn.addEventListener("click", () => {
    state.selectedIds = new Set(state.selectedId ? [state.selectedId] : []);
    renderGrid();
    renderContext();
  });
  el.appendChild(clearBtn);
}

function field(labelText, valueText) {
  const div = document.createElement("div");
  div.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const value = document.createElement("div");
  value.className = "value";
  value.textContent = valueText;
  div.append(label, value);
  return div;
}

// 内容の長さに合わせて高さが伸びる（スクロールしない）テキストエリア
function autoGrowTextarea(value, onInput) {
  const ta = document.createElement("textarea");
  ta.className = "auto-grow";
  ta.value = value ?? "";
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  ta.addEventListener("input", () => {
    fit();
    if (onInput) onInput(ta.value);
  });
  // DOM に載ってレイアウトが確定してから高さを合わせる
  requestAnimationFrame(fit);
  return ta;
}

// 編集可能なラベル付きフィールド
function editableField(labelText, input) {
  const div = document.createElement("div");
  div.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  input.style.width = "100%";
  div.append(label, input);
  return div;
}

// 編集可能なパラメータ表（プルダウン）。getValues() で編集後の値を返す。
function editableParamsField(labelText, params, open = false) {
  const details = document.createElement("details");
  details.className = "params-field";
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = `${labelText}（${Object.keys(params).length}）`;
  details.appendChild(summary);

  const table = document.createElement("div");
  table.className = "params-table";
  const inputs = {};
  for (const [k, v] of Object.entries(params)) {
    const row = document.createElement("div");
    row.className = "params-row";
    const key = document.createElement("span");
    key.className = "params-key";
    key.textContent = k;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "params-val-input";
    inp.value = String(v);
    inputs[k] = { input: inp, original: v };
    row.append(key, inp);
    table.appendChild(row);
  }
  details.appendChild(table);

  details.getValues = () => {
    const out = {};
    for (const [k, { input, original }] of Object.entries(inputs)) {
      const raw = input.value;
      // 元が数値なら数値として保存を試みる
      if (typeof original === "number") {
        const n = Number(raw);
        out[k] = Number.isFinite(n) ? n : raw;
      } else {
        out[k] = raw;
      }
    }
    return out;
  };
  return details;
}

// フォーム部品ヘルパー -------------------------------------------------------

function labeled(labelText, input) {
  const div = document.createElement("div");
  div.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  input.style.width = "100%";
  div.append(label, input);
  return div;
}

function makeInput(type, value, onChange) {
  const input = document.createElement("input");
  input.type = type;
  input.value = value ?? "";
  input.addEventListener("change", () => onChange(input.value));
  return input;
}

function makeTextarea(value, rows, onChange) {
  const ta = document.createElement("textarea");
  ta.rows = rows;
  ta.value = value ?? "";
  ta.addEventListener("change", () => onChange(ta.value));
  return ta;
}

function makeSelect(choices, value, onChange) {
  const sel = document.createElement("select");
  for (const c of choices) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
  if (value && choices.includes(value)) sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

// 画像をアプリ内ポップアップ（ライトボックス）で原寸表示する。
// クリックまたは Esc で閉じる。
function showImagePopup(url) {
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay image-popup";
  const img = document.createElement("img");
  img.src = url;
  overlay.appendChild(img);
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

function genStatusLine() {
  const line = document.createElement("div");
  line.className = "gen-status";
  line.id = "gen-status";
  return line;
}

function setGenStatus(text, isError = false) {
  const el = document.getElementById("gen-status");
  if (el) {
    el.textContent = text;
    el.classList.toggle("error", isError);
  }
}

// SSE（POST）ストリームを読み、イベントごとにコールバックする
async function streamGenerate(url, body, onEvent) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

async function saveGenSettings() {
  try {
    await apiJson("/api/settings", "PUT", {
      gen_image: state.genImage,
      gen_video: state.genVideo,
    });
  } catch {}
}

// 画像生成パネル -------------------------------------------------------------

function renderFolderContext(el) {
  const h = document.createElement("h2");
  h.textContent =
    state.folder === null ? "未選択" : state.folder || `${rootName()}（ルート）`;
  el.appendChild(h);

  if (state.folder === null) {
    const info = document.createElement("div");
    info.className = "placeholder";
    info.textContent = "左のツリーからフォルダを選択してください";
    el.appendChild(info);
    return;
  }

  // 基準画像のプレビュー（この設定で新規生成の元画像 / 直近の生成結果）
  const refBox = document.createElement("div");
  refBox.id = "gen-ref";
  refBox.className = "gen-ref";
  el.appendChild(refBox);

  const g = state.genImage;
  el.appendChild(
    labeled("バックエンド", makeSelect(state.options.backends, g.backend, (v) => {
      g.backend = v;
      renderContext();
    }))
  );

  if (g.backend === "ComfyUI") {
    el.appendChild(
      labeled("ワークフロー", makeSelect(state.options.image_workflows, g.workflow, (v) => (g.workflow = v)))
    );
    if (!g.workflow && state.options.image_workflows.length > 0) {
      g.workflow = state.options.image_workflows[0];
    }
  }

  const promptInput = attachSnippetAutocomplete(
    autoGrowTextarea(g.positive, (v) => (g.positive = v))
  );
  el.appendChild(labeled("Prompt", promptInput));

  // スニペット挿入
  const snipBtn = document.createElement("button");
  setIconLabel(snipBtn, "puzzle", "スニペットを挿入");
  snipBtn.addEventListener("click", () =>
    openSnippetPicker((body) => {
      const cur = promptInput.value.trim();
      const next = cur ? `${cur}, ${body}` : body;
      promptInput.value = next;
      g.positive = next;
      promptInput.style.height = "auto";
      promptInput.style.height = `${promptInput.scrollHeight + 2}px`;
    })
  );
  el.appendChild(snipBtn);

  // ライブラリの類似プロンプト参照（旧 {library_context} 相当）
  const simBtn = document.createElement("button");
  setIconLabel(simBtn, "search", "ライブラリから類似プロンプトを探す");
  const simResults = document.createElement("div");
  simResults.className = "similar-results";
  simBtn.addEventListener("click", async () => {
    const q = g.positive.trim();
    if (!q) {
      setGenStatus("Prompt に検索の手がかりを入力してください", true);
      return;
    }
    simBtn.disabled = true;
    simResults.innerHTML = '<div class="palette-sub">検索中...</div>';
    try {
      const res = await api(`/api/generation/similar?q=${encodeURIComponent(q)}&limit=5`);
      simResults.innerHTML = "";
      if (res.items.length === 0) {
        simResults.innerHTML = '<div class="palette-sub">類似プロンプトが見つかりません</div>';
      }
      for (const s of res.items) {
        const card = document.createElement("div");
        card.className = "similar-card";
        const img = document.createElement("img");
        img.src = `/api/library/file/${s.id}/${s.thumb || "thumb.jpg"}`;
        const text = document.createElement("div");
        text.className = "similar-text";
        text.textContent = s.prompt;
        text.title = "クリックで Prompt に反映";
        card.append(img, text);
        card.addEventListener("click", () => {
          g.positive = s.prompt;
          if (s.negative_prompt) g.negative = s.negative_prompt;
          renderContext();
        });
        simResults.appendChild(card);
      }
      if (res.mode === "keyword") {
        const note = document.createElement("div");
        note.className = "palette-sub";
        note.textContent = "（キーワード検索。embedding 更新でハイブリッドになります）";
        simResults.appendChild(note);
      }
    } catch (e) {
      simResults.innerHTML = "";
      setGenStatus(`類似検索エラー: ${e.message}`, true);
    } finally {
      simBtn.disabled = false;
    }
  });
  el.appendChild(simBtn);
  el.appendChild(simResults);

  el.appendChild(
    labeled(
      "Negative Prompt",
      attachSnippetAutocomplete(autoGrowTextarea(g.negative, (v) => (g.negative = v)))
    )
  );

  const row1 = document.createElement("div");
  row1.className = "row";
  row1.append(
    labeled("Width", makeInput("number", g.width, (v) => (g.width = parseInt(v, 10) || 1024))),
    labeled("Height", makeInput("number", g.height, (v) => (g.height = parseInt(v, 10) || 1024)))
  );
  el.appendChild(row1);

  if (g.backend !== "ComfyUI") {
    const row2 = document.createElement("div");
    row2.className = "row";
    row2.append(
      labeled("Steps", makeInput("number", g.steps, (v) => (g.steps = parseInt(v, 10) || 28))),
      labeled("CFG", makeInput("number", g.cfg, (v) => (g.cfg = parseFloat(v) || 7.0)))
    );
    el.appendChild(row2);
    el.appendChild(
      labeled("Sampler", makeSelect(state.options.forge_samplers, g.sampler, (v) => (g.sampler = v)))
    );
  }

  el.appendChild(
    seedField("Seed", g, () => state.lastImageSeed)
  );

  const genBtn = document.createElement("button");
  genBtn.className = "primary";
  setIconLabel(genBtn, "image", "生成キューに追加");
  genBtn.addEventListener("click", enqueueImage);
  el.appendChild(genBtn);
  el.appendChild(genStatusLine());

  updateGenRefPreview();
}

// 生成パネル上部の基準画像プレビューを更新（再描画せず src だけ差し替え）
function updateGenRefPreview() {
  const box = document.getElementById("gen-ref");
  if (!box) return;
  box.innerHTML = "";
  if (!state.genRef) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const label = document.createElement("div");
  label.className = "gen-ref-label";
  label.textContent = state.genRef.label || "元の画像";
  const img = document.createElement("img");
  img.className = "gen-ref-img";
  img.src = `/api/library/file/${state.genRef.id}/${state.genRef.image}`;
  img.title = "クリックで原寸表示";
  img.addEventListener("click", () =>
    showImagePopup(`/api/library/file/${state.genRef.id}/${state.genRef.image}`)
  );
  box.append(label, img);
}

// ---------------------------------------------------------------------------
// 生成キュー
// ---------------------------------------------------------------------------

let queueSeq = 0;
let queueRunning = false;

function enqueueImage() {
  if (state.folder === null) {
    setGenStatus("フォルダを選択してください", true);
    return;
  }
  saveGenSettings();
  const params = { ...state.genImage };
  if (state.genNearId) params.near_item = state.genNearId;
  enqueueImageJob(state.folder, params);
}

// 指定フォルダ・指定パラメータで画像生成をキューに積む
function enqueueImageJob(folder, params) {
  const label = (params.positive || "(プロンプトなし)").slice(0, 24);
  state.queue.push({
    id: ++queueSeq,
    type: "image",
    folder,
    params: { ...params },
    status: "pending",
    label: `画像: ${label}`,
    message: "",
  });
  updateQueueUI();
  processQueue();
  setGenStatus("生成キューに追加しました");
}

function enqueueVideo(itemId, label) {
  saveGenSettings();
  enqueueVideoJob(itemId, currentVideoSettings(), label);
}

// 指定アイテム・指定パラメータで動画生成をキューに積む
function enqueueVideoJob(itemId, params, label) {
  state.queue.push({
    id: ++queueSeq,
    type: "video",
    itemId,
    // LLM アンロードは共通設定（state.genVideo）から常に反映する
    params: { ...params, unload_llm: state.genVideo.unload_llm !== false },
    status: "pending",
    label: `動画: ${label || itemId}`,
    message: "",
  });
  updateQueueUI();
  processQueue();
  setGenStatus("生成キューに追加しました");
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  updateQueueUI();
  try {
    while (true) {
      const job = state.queue.find((j) => j.status === "pending");
      if (!job) break;
      job.status = "running";
      updateQueueUI();
      try {
        if (job.type === "image") await runImageJob(job);
        else await runVideoJob(job);
        job.status = "done";
      } catch (e) {
        job.status = "error";
        job.message = e.message;
        setStatus(`生成エラー: ${e.message}`, true);
      }
      updateQueueUI();
    }
  } finally {
    queueRunning = false;
    updateQueueUI();
  }
}

async function runImageJob(job) {
  let err = null;
  let result = null;
  let status = "";
  await streamGenerate("/api/generation/image", { folder: job.folder, ...job.params }, (ev) => {
    if (ev.type === "status") setStatus(`[画像] ${ev.content}`);
    else if (ev.type === "error") err = ev.content;
    else if (ev.type === "item") {
      result = ev.item;
      status = ev.status || "生成完了";
    }
  });
  if (err) throw new Error(err);
  job.message = status;
  if (result) markItemNew(result.id);
  if (result && result.seed !== null && result.seed !== undefined) {
    state.lastImageSeed = result.seed;
  }
  await loadTree();
  if (state.folder === job.folder) {
    // 選択状態は state に保持されているため、選択中でも一覧へ反映してよい
    await loadItems();
    // 生成パネル表示中なら基準画像を更新
    if (!state.selectedId && !state.videoPanel && result) {
      state.genRef = { id: result.id, image: result.image, label: "直近の生成" };
      updateGenRefPreview();
    }
  }
  setStatus(status);
}

async function runVideoJob(job) {
  let err = null;
  let result = null;
  let status = "";
  await streamGenerate("/api/generation/video", { item_id: job.itemId, ...job.params }, (ev) => {
    if (ev.type === "status") setStatus(`[動画] ${ev.content}`);
    else if (ev.type === "error") err = ev.content;
    else if (ev.type === "video") {
      result = ev.item;
      status = ev.status || "動画を生成しました";
    }
  });
  if (err) throw new Error(err);
  job.message = status;
  // 追加された動画（videos の末尾）に NEW を付ける
  if (result?.videos?.length) {
    markVideoNew(job.itemId, result.videos[result.videos.length - 1].file);
  }
  // ランダム指定（-1）でも、サーバーが記録した実際の seed を復元用に控える
  const usedSeed = result?.video_settings?.seed;
  if (typeof usedSeed === "number" && usedSeed >= 0) {
    state.lastVideoSeed = usedSeed;
  } else if (typeof job.params.seed === "number" && job.params.seed >= 0) {
    state.lastVideoSeed = job.params.seed;
  }
  await loadTree();
  await loadItems();
  if (state.selectedId === job.itemId && result) {
    state.currentItem = result;
    renderVideoStrip();
  }
  setStatus(status);
}

// キューボタン・パネルの表示更新
function updateQueueUI() {
  const active = state.queue.filter(
    (j) => j.status === "pending" || j.status === "running"
  ).length;
  const btn = $("#btn-queue");
  btn.hidden = state.queue.length === 0;
  const running = state.queue.some((j) => j.status === "running");
  setIconLabel(btn, "clock", active > 0 ? `キュー ${active}` : "キュー");
  btn.classList.toggle("is-running", running);
  renderQueue();
}

function renderQueue() {
  const list = $("#queue-list");
  if (!list) return;
  list.innerHTML = "";
  if (state.queue.length === 0) {
    list.innerHTML = '<p class="queue-empty">キューは空です</p>';
    return;
  }
  const icons = { pending: "clock", running: "play", done: "check", error: "alert" };
  for (const job of state.queue) {
    const row = document.createElement("div");
    row.className = `queue-item is-${job.status}`;
    const icon = document.createElement("span");
    icon.className = "queue-icon";
    icon.innerHTML = icons[job.status] ? iconSvg(icons[job.status]) : "";
    const label = document.createElement("span");
    label.className = "queue-label";
    label.textContent = job.label;
    label.title = job.message || job.label;
    row.append(icon, label);
    if (job.status === "pending") {
      const rm = document.createElement("button");
      setIconLabel(rm, "x");
      rm.title = "キューから削除";
      rm.addEventListener("click", () => {
        state.queue = state.queue.filter((j) => j.id !== job.id);
        updateQueueUI();
      });
      row.appendChild(rm);
    }
    list.appendChild(row);
  }
}

// 動画生成パネル -------------------------------------------------------------

function renderVideoGenContext(el, item) {
  const h = document.createElement("h2");
  h.textContent = `動画を生成: ${item.id}`;
  el.appendChild(h);

  const img = document.createElement("img");
  img.className = "preview";
  img.src = `/api/library/file/${item.id}/${item.thumb || "thumb.jpg"}`;
  el.appendChild(img);

  const g = state.genVideo;
  // 保存済みの動画設定があれば復元（初回のみ）。なければ画像プロンプトを既定に。
  if (!g._loadedFor || g._loadedFor !== item.id) {
    const vs = item.video_settings;
    if (vs) {
      g.prompt = vs.prompt ?? "";
      g.extra = vs.extra_instruction ?? "";
      if (Array.isArray(vs.sections) && vs.sections.length) g.sections = vs.sections;
      g.workflow = vs.workflow ?? g.workflow;
      g.width = vs.width ?? "";
      g.height = vs.height ?? "";
      g.frames = vs.frames ?? "";
      g.seed = vs.seed ?? -1;
      if (typeof vs.seed === "number" && vs.seed >= 0) state.lastVideoSeed = vs.seed;
    } else if (!g.prompt) {
      g.prompt = item.prompt || "";
    }
    g._loadedFor = item.id;
  }
  if (!g.workflow && state.options.video_workflows.length > 0) {
    g.workflow = state.options.video_workflows[0];
  }

  // 動画プロンプト本文（LLM 生成の流し込み先になるため先に作る）
  const promptField = attachSnippetAutocomplete(
    autoGrowTextarea(g.prompt, (v) => (g.prompt = v))
  );
  el.appendChild(buildLlmPromptBox(item.id, g, promptField, (t) => (g.prompt = t)));
  el.appendChild(labeled("動画プロンプト", promptField));
  el.appendChild(
    labeled("ワークフロー", makeSelect(state.options.video_workflows, g.workflow, (v) => (g.workflow = v)))
  );

  const row = document.createElement("div");
  row.className = "row";
  row.append(
    labeled("Width（空でWF値）", makeInput("number", g.width, (v) => (g.width = v))),
    labeled("Height", makeInput("number", g.height, (v) => (g.height = v)))
  );
  el.appendChild(row);

  el.appendChild(labeled("Frames（空でWF値）", makeInput("number", g.frames, (v) => (g.frames = v))));
  el.appendChild(seedField("Seed", g, () => state.lastVideoSeed));

  // 生成前に LLM をアンロードして VRAM を空ける（既定オン）
  const unloadLbl = document.createElement("label");
  unloadLbl.className = "section-check unload-llm-check";
  const unloadCb = document.createElement("input");
  unloadCb.type = "checkbox";
  unloadCb.checked = g.unload_llm !== false;
  unloadCb.addEventListener("change", () => {
    g.unload_llm = unloadCb.checked;
    saveGenSettings();
  });
  unloadLbl.append(
    unloadCb,
    document.createTextNode(" 生成前に LLM をアンロード（VRAM を空ける）")
  );
  el.appendChild(unloadLbl);

  const genBtn = document.createElement("button");
  genBtn.className = "primary";
  setIconLabel(genBtn, "film", "動画生成をキューに追加");
  genBtn.addEventListener("click", () => enqueueVideo(item.id, item.prompt || item.id));
  el.appendChild(genBtn);

  const saveSettingsBtn = document.createElement("button");
  setIconLabel(saveSettingsBtn, "save", "この設定を保存（生成せず）");
  saveSettingsBtn.title = "追加指示・プロンプト等を画像に保存します（次回この画像を開くと復元されます）";
  saveSettingsBtn.addEventListener("click", async () => {
    await run(async () => {
      await apiJson(`/api/library/items/${item.id}`, "PATCH", {
        video_settings: currentVideoSettings(),
      });
    }, "動画設定を保存しました");
  });
  el.appendChild(saveSettingsBtn);

  const backBtn = document.createElement("button");
  setIconLabel(backBtn, "arrow-left", "画像詳細に戻る");
  backBtn.addEventListener("click", async () => {
    state.videoPanel = false;
    updateHash();
    await renderContext();
  });
  el.appendChild(backBtn);
  el.appendChild(genStatusLine());
}

// 「🤖 LLM で動画プロンプトを生成」ボックス（動画生成パネル / 動画プロパティ共用）。
// s は { extra, sections } を持つ編集対象（state.genVideo または編集ドラフト）。
// 生成結果は promptField に流し込みつつ onText で編集対象へ反映する。
function buildLlmPromptBox(itemId, s, promptField, onText) {
  const llmBox = document.createElement("div");
  llmBox.className = "llm-box";

  const llmHead = document.createElement("div");
  llmHead.className = "llm-head";
  setIconLabel(llmHead, "bot", "LLM で動画プロンプトを生成");
  llmBox.appendChild(llmHead);

  llmBox.appendChild(
    labeled(
      "追加指示（任意）",
      autoGrowTextarea(s.extra, (v) => (s.extra = v))
    )
  );

  // モデル選択（未ロード時のみ表示）
  const modelRow = document.createElement("div");
  modelRow.className = "llm-model-row";
  llmBox.appendChild(modelRow);

  const renderModelRow = () => {
    modelRow.innerHTML = "";
    // モデル選択は常に表示（生成時に自動ロードされる）
    const sel = makeSelect(
      state.llm.models.length ? state.llm.models : ["（models/ に GGUF がありません）"],
      state.llm.selected || state.llm.models[0] || "",
      (v) => (state.llm.selected = v)
    );
    if (!state.llm.selected && state.llm.models[0]) state.llm.selected = state.llm.models[0];
    modelRow.appendChild(labeled("LLM モデル", sel));

    const btn = document.createElement("button");
    if (state.llm.loaded) {
      btn.textContent = "アンロード";
      btn.title = `ロード中: ${state.llm.loaded}`;
      btn.addEventListener("click", async () => {
        await run(() => api("/api/llm/unload", { method: "POST" }));
        state.llm.loaded = null;
        renderModelRow();
      });
    } else {
      btn.textContent = "ロード";
      btn.title = "今すぐロード（生成時に自動ロードもされます）";
      btn.addEventListener("click", async () => {
        const model = state.llm.selected || state.llm.models[0];
        if (!model || !state.llm.models.length) {
          setGenStatus("models/ に GGUF モデルが見つかりません", true);
          return;
        }
        btn.disabled = true;
        setGenStatus(`モデルをロード中: ${model} ...`);
        const ok = await run(() => apiJson("/api/llm/load", "POST", { model }));
        btn.disabled = false;
        if (ok) {
          state.llm.loaded = ok.loaded;
          setGenStatus(`モデルをロードしました: ${ok.loaded}`);
          renderModelRow();
        }
      });
    }
    modelRow.appendChild(btn);
  };
  renderModelRow();
  // モデル一覧・ロード状態を取得して行を更新
  loadLlmModels().then(renderModelRow);

  // 生成するセクションのチェックボックス
  const secWrap = document.createElement("div");
  secWrap.className = "field";
  secWrap.innerHTML = "<label>生成するセクション</label>";
  const secRow = document.createElement("div");
  secRow.className = "section-checks";
  if (!Array.isArray(s.sections) || !s.sections.length) s.sections = [...VIDEO_SECTIONS];
  for (const name of VIDEO_SECTIONS) {
    const lbl = document.createElement("label");
    lbl.className = "section-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s.sections.includes(name);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!s.sections.includes(name)) s.sections.push(name);
      } else {
        s.sections = s.sections.filter((n) => n !== name);
      }
    });
    lbl.append(cb, document.createTextNode(" " + name));
    secRow.appendChild(lbl);
  }
  secWrap.appendChild(secRow);
  llmBox.appendChild(secWrap);

  const genPromptBtn = document.createElement("button");
  genPromptBtn.className = "primary";
  setIconLabel(genPromptBtn, "sparkles", "動画プロンプトを生成");
  genPromptBtn.addEventListener("click", () =>
    generateVideoPrompt(genPromptBtn, itemId, promptField, s, onText)
  );
  llmBox.appendChild(genPromptBtn);
  return llmBox;
}

async function loadLlmModels() {
  try {
    const res = await api("/api/llm/models");
    state.llm.models = res.models;
    state.llm.loaded = res.ready ? res.loaded : null;
    // 前回ロードしたモデルを既定選択に
    if (!state.llm.selected && res.last) state.llm.selected = res.last;
  } catch {
    state.llm.models = [];
    state.llm.loaded = null;
  }
}

async function generateVideoPrompt(btn, itemId, promptField, s, onText) {
  if (btn.disabled) return;
  if (!state.llm.models.length) {
    setGenStatus("models/ フォルダに GGUF モデルが見つかりません", true);
    return;
  }
  const sections = s.sections || [];
  if (sections.length === 0) {
    setGenStatus("生成するセクションを1つ以上選んでください", true);
    return;
  }
  btn.disabled = true;
  btn.textContent = "生成中...";
  let text = "";
  try {
    await streamGenerate(
      "/api/llm/video-prompt",
      {
        item_id: itemId,
        extra_instruction: s.extra,
        model: state.llm.selected || state.llm.models[0],
        sections,
      },
      (ev) => {
        if (ev.type === "status") {
          setGenStatus(ev.content);
        } else if (ev.type === "model_loaded") {
          state.llm.loaded = ev.content;
        } else if (ev.type === "token") {
          text += ev.content;
          promptField.value = text;
          onText(text);
          // 自動高さを反映（プログラム変更では input が飛ばないため手動で）
          promptField.style.height = "auto";
          promptField.style.height = `${promptField.scrollHeight + 2}px`;
        } else if (ev.type === "error") {
          setGenStatus(ev.content, true);
        } else if (ev.type === "done_prompt") {
          setGenStatus("動画プロンプトを生成しました");
        }
      }
    );
  } catch (e) {
    setGenStatus(`生成エラー: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    setIconLabel(btn, "sparkles", "動画プロンプトを生成");
  }
}

// 動画パネルの現在の設定を meta.json / API 用の形にまとめる
function currentVideoSettings() {
  const g = state.genVideo;
  return {
    prompt: g.prompt,
    extra_instruction: g.extra || "",
    sections: g.sections || VIDEO_SECTIONS,
    workflow: g.workflow,
    width: g.width,
    height: g.height,
    frames: g.frames,
    seed: g.seed,
  };
}

// 画像選択時の右パネル。生成パネルと同じ編集 UI をこの画像の値で初期化して表示し、
// 「保存」（画像へ書き戻し）と「生成キューに追加」（そのまま新規生成）を選べる。
function renderItemContext(el, item) {
  const h = document.createElement("h2");
  h.textContent = item.id;
  el.appendChild(h);

  const img = document.createElement("img");
  img.className = "preview";
  img.src = `/api/library/file/${item.id}/${item.image}`;
  img.title = "クリックで原寸表示";
  img.style.cursor = "zoom-in";
  img.addEventListener("click", () =>
    showImagePopup(`/api/library/file/${item.id}/${item.image}`)
  );
  el.appendChild(img);

  const p = item.params || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  // 編集ドラフト。バックエンド切替などの再描画で編集内容が消えないよう保持する
  let d = state.itemDraft?.id === item.id ? state.itemDraft.draft : null;
  if (!d) {
    d = {
      backend:
        p.backend === "ComfyUI" || p.backend === "WebUI Forge"
          ? p.backend
          : state.genImage.backend,
      workflow: p.workflow || state.genImage.workflow,
      positive: item.prompt || "",
      negative: item.negative_prompt || "",
      width: num(p.width) ?? state.genImage.width,
      height: num(p.height) ?? state.genImage.height,
      steps: num(p.steps) ?? state.genImage.steps,
      cfg: num(p.cfg) ?? num(p.cfg_scale) ?? state.genImage.cfg,
      sampler:
        p.sampler && state.options.forge_samplers.includes(p.sampler)
          ? p.sampler
          : state.genImage.sampler,
      seed: item.seed ?? -1,
      tags: (item.tags || []).join(", "),
      caption: item.caption || "",
      rest: null, // 専用フィールドで扱わない params の編集値
    };
    state.itemDraft = { id: item.id, draft: d };
  }

  el.appendChild(
    labeled("バックエンド", makeSelect(state.options.backends, d.backend, (v) => {
      if (restEditor) d.rest = restEditor.getValues();
      d.backend = v;
      renderContext();
    }))
  );

  if (d.backend === "ComfyUI") {
    el.appendChild(
      labeled("ワークフロー", makeSelect(state.options.image_workflows, d.workflow, (v) => (d.workflow = v)))
    );
    if (!d.workflow && state.options.image_workflows.length > 0) {
      d.workflow = state.options.image_workflows[0];
    }
  }

  el.appendChild(
    editableField(
      "Prompt",
      attachSnippetAutocomplete(autoGrowTextarea(d.positive, (v) => (d.positive = v)))
    )
  );
  el.appendChild(
    editableField(
      "Negative Prompt",
      attachSnippetAutocomplete(autoGrowTextarea(d.negative, (v) => (d.negative = v)))
    )
  );

  const row1 = document.createElement("div");
  row1.className = "row";
  row1.append(
    labeled("Width", makeInput("number", d.width, (v) => (d.width = parseInt(v, 10) || 1024))),
    labeled("Height", makeInput("number", d.height, (v) => (d.height = parseInt(v, 10) || 1024)))
  );
  el.appendChild(row1);

  if (d.backend !== "ComfyUI") {
    const row2 = document.createElement("div");
    row2.className = "row";
    row2.append(
      labeled("Steps", makeInput("number", d.steps, (v) => (d.steps = parseInt(v, 10) || 28))),
      labeled("CFG", makeInput("number", d.cfg, (v) => (d.cfg = parseFloat(v) || 7.0)))
    );
    el.appendChild(row2);
    el.appendChild(
      labeled("Sampler", makeSelect(state.options.forge_samplers, d.sampler, (v) => (d.sampler = v)))
    );
  }

  el.appendChild(seedField("Seed", d, () => state.lastImageSeed));

  // 専用フィールドで扱わない params は従来通り表で編集できるようにする
  const SHOWN_KEYS = new Set(["backend", "workflow", "width", "height", "steps", "cfg", "cfg_scale", "sampler"]);
  const restParams =
    d.rest ||
    Object.fromEntries(Object.entries(p).filter(([k]) => !SHOWN_KEYS.has(k)));
  const restEditor =
    Object.keys(restParams).length > 0
      ? editableParamsField("その他の Params", restParams)
      : null;
  if (restEditor) el.appendChild(restEditor);

  // タグ・キャプション
  el.appendChild(
    editableField("タグ（カンマ区切り）", makeInput("text", d.tags, (v) => (d.tags = v)))
  );
  el.appendChild(
    editableField("キャプション", makeTextarea(d.caption, 2, (v) => (d.caption = v)))
  );

  // 編集中の値から params を組み立てる（保存・生成で共用）
  const buildParams = () => {
    const params = { ...p, ...(restEditor ? restEditor.getValues() : {}) };
    params.backend = d.backend;
    if (d.backend === "ComfyUI") params.workflow = d.workflow;
    params.width = d.width;
    params.height = d.height;
    if (d.backend !== "ComfyUI") {
      params.steps = d.steps;
      params.cfg = d.cfg;
      // 旧形式のキーが残っていると値が食い違うため揃える
      if ("cfg_scale" in params) params.cfg_scale = d.cfg;
      params.sampler = d.sampler;
    }
    return params;
  };

  const btnRow = document.createElement("div");
  btnRow.className = "row";

  const saveBtn = document.createElement("button");
  setIconLabel(saveBtn, "save", "保存");
  saveBtn.title = "編集した内容をこの画像に保存します（生成はしません）";
  saveBtn.addEventListener("click", async () => {
    const patch = {
      prompt: d.positive,
      negative_prompt: d.negative,
      seed: d.seed >= 0 ? d.seed : null,
      tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean),
      caption: d.caption,
      params: buildParams(),
    };
    await run(async () => {
      await apiJson(`/api/library/items/${item.id}`, "PATCH", patch);
      await loadItems();
    }, "保存しました");
  });
  btnRow.appendChild(saveBtn);

  const genBtn = document.createElement("button");
  genBtn.className = "primary";
  setIconLabel(genBtn, "image", "新規生成でキューに追加");
  genBtn.title = "この内容で新しい画像を生成します（この画像は変更されません）";
  genBtn.addEventListener("click", () => {
    enqueueImageJob(item.folder ?? state.folder ?? "", {
      backend: d.backend,
      workflow: d.workflow,
      positive: d.positive,
      negative: d.negative,
      width: d.width,
      height: d.height,
      steps: d.steps,
      cfg: d.cfg,
      sampler: d.sampler,
      seed: d.seed,
      near_item: item.id, // 生成結果はこの画像の隣に並べる
    });
  });
  btnRow.appendChild(genBtn);

  el.appendChild(btnRow);
  el.appendChild(genStatusLine());

  // 動画生成（動画一覧は下部ストリップに表示）
  const genVideoBtn = document.createElement("button");
  genVideoBtn.className = "primary";
  const vcount = (item.videos || []).length;
  setIconLabel(genVideoBtn, "film", vcount > 0 ? `動画を生成...（${vcount}件は下に表示）` : "動画を生成...");
  genVideoBtn.addEventListener("click", async () => {
    state.videoPanel = true;
    updateHash();
    await renderContext();
  });
  el.appendChild(genVideoBtn);

  // ファイル操作
  const revealBtn = document.createElement("button");
  setIconLabel(revealBtn, "folder-open", "ファイルの場所を開く");
  revealBtn.addEventListener("click", () => revealItem(item.id));
  el.appendChild(revealBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "danger";
  setIconLabel(delBtn, "trash", "画像を削除");
  delBtn.addEventListener("click", () =>
    deleteItemById(item.id, (item.videos || []).length)
  );
  el.appendChild(delBtn);
}

// 動画のプロパティ（下部ストリップで動画を選択したとき、右パネルに表示）
function renderVideoPropsContext(el, item, v) {
  const h = document.createElement("h2");
  h.textContent = "動画プロパティ";
  el.appendChild(h);

  const back = document.createElement("button");
  setIconLabel(back, "arrow-left", "画像のプロパティに戻る");
  back.addEventListener("click", async () => {
    state.selectedVideoFile = null;
    renderVideoStrip();
    await renderContext();
  });
  el.appendChild(back);

  const video = document.createElement("video");
  video.className = "preview";
  video.controls = true;
  video.src = `/api/library/file/${item.id}/${v.file}`;
  el.appendChild(video);

  const fileLabel = document.createElement("div");
  fileLabel.className = "palette-sub";
  fileLabel.textContent = `${v.file}　${(v.created_at || "").replace("T", " ").slice(0, 16)}`;
  el.appendChild(fileLabel);

  // 選択した時点で編集できる生成フォーム。この動画の設定を初期値にする
  const vs = v.settings || {};
  const d = {
    prompt: v.prompt || vs.prompt || "",
    extra: vs.extra_instruction || "",
    sections:
      Array.isArray(vs.sections) && vs.sections.length
        ? [...vs.sections]
        : [...VIDEO_SECTIONS],
    workflow: vs.workflow || v.workflow || state.genVideo.workflow,
    width: vs.width ?? "",
    height: vs.height ?? "",
    frames: vs.frames ?? "",
    seed: typeof vs.seed === "number" ? vs.seed : -1,
  };

  // LLM プロンプト生成（追加指示・モデル・セクション選択を含む）
  const promptField = attachSnippetAutocomplete(
    autoGrowTextarea(d.prompt, (val) => (d.prompt = val))
  );
  el.appendChild(buildLlmPromptBox(item.id, d, promptField, (t) => (d.prompt = t)));
  el.appendChild(editableField("動画プロンプト", promptField));
  el.appendChild(
    labeled("ワークフロー", makeSelect(state.options.video_workflows, d.workflow, (val) => (d.workflow = val)))
  );
  if (!d.workflow && state.options.video_workflows.length > 0) {
    d.workflow = state.options.video_workflows[0];
  }

  const sizeRow = document.createElement("div");
  sizeRow.className = "row";
  sizeRow.append(
    labeled("Width（空でWF値）", makeInput("number", d.width, (val) => (d.width = val))),
    labeled("Height", makeInput("number", d.height, (val) => (d.height = val)))
  );
  el.appendChild(sizeRow);
  el.appendChild(
    labeled("Frames（空でWF値）", makeInput("number", d.frames, (val) => (d.frames = val)))
  );
  el.appendChild(seedField("Seed", d, () => state.lastVideoSeed));

  // 編集中の値を保存・生成で共用する形にまとめる
  const buildSettings = () => ({
    ...vs,
    prompt: d.prompt,
    extra_instruction: d.extra,
    sections: d.sections,
    workflow: d.workflow,
    width: d.width,
    height: d.height,
    frames: d.frames,
    seed: d.seed,
  });

  const btnRow = document.createElement("div");
  btnRow.className = "row";

  const saveBtn = document.createElement("button");
  setIconLabel(saveBtn, "save", "保存");
  saveBtn.title = "編集した内容をこの動画に保存します（生成はしません）";
  saveBtn.addEventListener("click", async () => {
    const name = v.file.split("/").pop();
    await run(async () => {
      await apiJson(`/api/library/items/${item.id}/videos/${encodeURIComponent(name)}`, "PATCH", {
        prompt: d.prompt,
        settings: buildSettings(),
      });
      await reloadCurrentItem();
    }, "保存しました");
  });
  btnRow.appendChild(saveBtn);

  const genBtn = document.createElement("button");
  genBtn.className = "primary";
  setIconLabel(genBtn, "film", "新規生成でキューに追加");
  genBtn.title = "この内容で新しい動画を生成します（この動画は変更されません）";
  genBtn.addEventListener("click", () => {
    enqueueVideoJob(item.id, buildSettings(), (d.prompt || item.id).slice(0, 24));
  });
  btnRow.appendChild(genBtn);

  el.appendChild(btnRow);
  el.appendChild(genStatusLine());

  const del = document.createElement("button");
  del.className = "danger";
  setIconLabel(del, "trash", "この動画を削除");
  del.addEventListener("click", async () => {
    if (!confirm(`動画 ${v.file} を削除しますか？`)) return;
    const name = v.file.split("/").pop();
    await run(async () => {
      await api(`/api/library/items/${item.id}/videos/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      state.selectedVideoFile = null;
      state.selectedVideoFiles = new Set();
      await reloadCurrentItem();
      await loadItems();
    }, "動画を削除しました");
  });
  el.appendChild(del);
}

// 選択中画像の詳細を再取得して、ストリップと右パネルを更新
async function reloadCurrentItem() {
  if (!state.selectedId) return;
  state.currentItem = await run(() => api(`/api/library/items/${state.selectedId}`));
  renderVideoStrip();
  await renderContext();
}

// ---------------------------------------------------------------------------
// その他
// ---------------------------------------------------------------------------

// バックエンドの起動状態インジケーター ----------------------------------------

let statusPollTimer = null;

const SVC_STATES = {
  ready: { cls: "is-up", text: "", label: "起動中" },
  starting: { cls: "is-busy", text: "起動中…", label: "起動中…" },
  installing: { cls: "is-busy", text: "セットアップ中…", label: "セットアップ中…" },
  error: { cls: "is-error", text: "エラー", label: "エラー" },
  off: { cls: "is-down", text: "", label: "停止" },
};

async function refreshServiceStatus() {
  const container = $("#service-status");
  let busy = false;
  try {
    const res = await api("/api/status");
    container.innerHTML = "";
    for (const s of res.services) {
      const state = SVC_STATES[s.state] || (s.ready ? SVC_STATES.ready : SVC_STATES.off);
      if (s.state === "starting" || s.state === "installing") busy = true;
      const chip = document.createElement("span");
      chip.className = `svc-chip ${state.cls}`;
      // 遷移中はサーバーからの詳細（例: モデルをロード中…）を優先して表示する
      const busyText = s.state === "starting" || s.state === "installing" ? s.detail || state.text : state.text;
      const stateText = busyText ? `<span class="svc-state">${busyText}</span>` : "";
      chip.innerHTML = `<span class="svc-dot"></span>${s.label}${stateText}`;
      chip.title = `${s.label}: ${state.label}${s.detail ? ` — ${s.detail}` : ""} (${s.url})`;
      container.appendChild(chip);
    }
  } catch {
    container.innerHTML = '<span class="svc-chip is-down">状態不明</span>';
  }
  // 起動・ロードの遷移中は短い間隔で追いかけ、完了したら通常間隔に戻す
  scheduleStatusPoll(busy ? 1500 : 8000);
}

function scheduleStatusPoll(delay) {
  clearTimeout(statusPollTimer);
  statusPollTimer = setTimeout(refreshServiceStatus, delay);
}

function startStatusPolling() {
  refreshServiceStatus();
  // クリックで即再確認
  $("#service-status").addEventListener("click", refreshServiceStatus);
}

// システムリソース（GPU / VRAM / CPU / RAM） ---------------------------------

let sysPollTimer = null;

function bar(label, pct, text) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return (
    `<span class="sys-item"><span class="sys-label">${label}</span>` +
    `<span class="sys-meter"><span class="sys-fill" style="width:${p}%"></span></span>` +
    `<span class="sys-text">${text}</span></span>`
  );
}

async function refreshSystemStats() {
  const el = $("#sysstats");
  try {
    const s = await api("/api/status/system");
    const parts = [];
    if (s.cpu_util !== null) parts.push(bar("CPU", s.cpu_util, `${Math.round(s.cpu_util)}%`));
    if (s.ram_total)
      parts.push(bar("RAM", (s.ram_used / s.ram_total) * 100, `${s.ram_used}/${s.ram_total}GB`));
    if (s.gpu_util !== null) parts.push(bar("GPU", s.gpu_util, `${Math.round(s.gpu_util)}%`));
    if (s.vram_total)
      parts.push(bar("VRAM", (s.vram_used / s.vram_total) * 100, `${s.vram_used}/${s.vram_total}GB`));
    el.innerHTML = parts.join("");
  } catch {
    el.innerHTML = "";
  }
}

function startSystemPolling() {
  refreshSystemStats();
  clearInterval(sysPollTimer);
  sysPollTimer = setInterval(refreshSystemStats, 2000);
}

// ペインのリサイズ ----------------------------------------------------------

const PANE_LIMITS = { left: [150, 500], right: [260, 720] };

function applyPaneWidths(widths) {
  const panes = $("#view-library");
  if (widths.left) panes.style.setProperty("--left-w", `${widths.left}px`);
  if (widths.right) panes.style.setProperty("--right-w", `${widths.right}px`);
}

let paneSaveTimer = null;
function savePaneWidths(widths) {
  clearTimeout(paneSaveTimer);
  paneSaveTimer = setTimeout(() => {
    apiJson("/api/settings", "PUT", { pane_widths: widths }).catch(() => {});
  }, 400);
}

function initPaneResizers(saved) {
  const widths = { left: 240, right: 420, ...(saved || {}) };
  applyPaneWidths(widths);

  for (const resizer of document.querySelectorAll(".pane-resizer")) {
    const side = resizer.dataset.resize;
    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      resizer.classList.add("is-dragging");
      const startX = e.clientX;
      const startW = widths[side];
      const [min, max] = PANE_LIMITS[side];
      // 右ペインは左方向ドラッグで広がるので符号を反転
      const dir = side === "left" ? 1 : -1;

      const onMove = (ev) => {
        const next = Math.max(min, Math.min(max, startW + dir * (ev.clientX - startX)));
        widths[side] = Math.round(next);
        applyPaneWidths(widths);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        resizer.classList.remove("is-dragging");
        document.body.style.userSelect = "";
        savePaneWidths(widths);
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // ダブルクリックで既定幅に戻す
    resizer.addEventListener("dblclick", () => {
      widths[side] = side === "left" ? 240 : 420;
      applyPaneWidths(widths);
      savePaneWidths(widths);
    });
  }
}

// ライブラリルートの表示・変更 ----------------------------------------------

async function loadRoot() {
  try {
    const res = await api("/api/library/root");
    state.rootInfo = res;
    $("#root-path").textContent = res.root;
    $("#root-path").title = `ライブラリの保存先: ${res.root}`;
    const settingsPath = $("#settings-root-path");
    if (settingsPath) {
      settingsPath.textContent = res.root;
      settingsPath.title = res.root;
    }
    if (state.tree) renderTree();
    return res;
  } catch {
    return null;
  }
}

async function changeLibraryRoot(reset = false) {
  const current = await loadRoot();
  let path;
  if (reset) {
    if (!confirm(`ライブラリの保存先を既定（${current?.default || "data/library"}）に戻しますか？`)) return;
    path = "";
  } else if (window.electronAPI?.selectFolder) {
    path = await window.electronAPI.selectFolder(current?.root);
    if (!path) return; // キャンセル
  } else {
    path = await showInputDialog("ライブラリの保存先フォルダ（絶対パス）:", current?.root || "");
    if (path === null) return;
  }
  await run(async () => {
    const res = await apiJson("/api/library/root", "POST", { path });
    await loadRoot();
    await selectFolder("");
    setStatus(`ライブラリの保存先を変更しました: ${res.root}（${res.indexed} 件をインデックス）`);
  });
}

$("#btn-root").addEventListener("click", (e) => changeLibraryRoot(e.shiftKey));
$("#btn-root-change").addEventListener("click", () => changeLibraryRoot(false));
$("#btn-root-reset").addEventListener("click", () => changeLibraryRoot(true));

$("#btn-embed").addEventListener("click", async () => {
  const btn = $("#btn-embed");
  btn.disabled = true;
  try {
    const res = await fetch("/api/library/embeddings/rebuild", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "status") setStatus(ev.content);
        else if (ev.type === "result") setStatus(ev.status);
        else if (ev.type === "error") setStatus(ev.content, true);
      }
    }
  } catch (e) {
    setStatus(`embedding 更新エラー: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

// モード切替（ライブラリ / シーケンス / スニペット）
for (const tab of document.querySelectorAll(".topbar-tab")) {
  tab.addEventListener("click", async () => {
    if (tab.classList.contains("is-active")) return;
    document.querySelectorAll(".topbar-tab").forEach((t) => t.classList.remove("is-active"));
    tab.classList.add("is-active");
    const mode = tab.dataset.mode;
    $("#view-library").hidden = mode !== "library";
    $("#view-sequence").hidden = mode !== "sequence";
    $("#view-snippets").hidden = mode !== "snippets";
    if (mode === "sequence") await run(activateSequenceView);
    else if (mode === "snippets") await run(activateSnippetsView);
  });
}

initSequenceView();
initSnippetsView();

// 設定パネルの開閉
$("#btn-settings").addEventListener("click", () => {
  const panel = $("#settings-panel");
  panel.hidden = !panel.hidden;
});
$("#btn-settings-close").addEventListener("click", () => {
  $("#settings-panel").hidden = true;
});
// パネルの外側クリックで閉じる（歯車ボタン自体のクリックはトグルに任せる）
document.addEventListener("click", (e) => {
  const panel = $("#settings-panel");
  if (!panel.hidden && !e.target.closest("#settings-panel, #btn-settings")) {
    panel.hidden = true;
  }
});

// 生成キューのパネル開閉
$("#btn-queue").addEventListener("click", () => {
  const panel = $("#queue-panel");
  panel.hidden = !panel.hidden;
});
$("#btn-queue-close").addEventListener("click", () => {
  $("#queue-panel").hidden = true;
});
$("#btn-queue-clear").addEventListener("click", () => {
  state.queue = state.queue.filter((j) => j.status === "pending" || j.status === "running");
  updateQueueUI();
});

// 表示順の切り替え（設定パネル）
function updateSortOrderButton() {
  setIconLabel(
    $("#btn-sort-order"),
    "sort",
    sortOrder === "desc" ? "新しい→古い" : "古い→新しい"
  );
}
updateSortOrderButton();
$("#btn-sort-order").addEventListener("click", async () => {
  sortOrder = sortOrder === "desc" ? "asc" : "desc";
  localStorage.setItem(SORT_ORDER_KEY, sortOrder);
  updateSortOrderButton();
  await run(loadItems);
});

$("#btn-reindex").addEventListener("click", async () => {
  await run(async () => {
    const res = await api("/api/library/reindex", { method: "POST" });
    await refresh();
    setStatus(`インデックスを再構築しました（${res.count} 件）`);
  });
});

async function refresh() {
  await loadTree();
  await loadItems();
  if (!state.selectedId) {
    state.currentItem = null;
    state.selectedVideoFile = null;
  }
  renderVideoStrip();
  await renderContext();
}

// シーケンス編集のノード右クリックなどから「ライブラリの元動画を表示」する
window.addEventListener("open-library-item", async (e) => {
  const { itemId, file } = e.detail || {};
  if (!itemId) return;
  const item = await api(`/api/library/items/${itemId}`).catch(() => null);
  if (!item) {
    setStatus("元の画像が見つかりません（削除された可能性があります）", true);
    return;
  }
  // ライブラリタブへ切り替え
  const tab = document.querySelector('.topbar-tab[data-mode="library"]');
  if (tab && !tab.classList.contains("is-active")) tab.click();
  if (state.folder !== (item.folder ?? "")) {
    await selectFolder(item.folder ?? "");
  }
  await selectItem(itemId);
  const hasVideo = file && (item.videos || []).some((v) => v.file === file);
  if (hasVideo) {
    if (markVideoSeen(itemId, file)) renderGrid();
    state.selectedVideoFile = file;
    state.selectedVideoFiles = new Set([file]);
    renderVideoStrip();
    await renderContext();
  }
  document.querySelector(`.card[data-id="${itemId}"]`)?.scrollIntoView({ block: "nearest" });
  setStatus(
    hasVideo
      ? "ライブラリの元動画を表示しました"
      : "元の画像を表示しました（この動画ファイルは見つかりません）"
  );
});

run(async () => {
  const [, , saved, options] = await Promise.all([
    loadTree(),
    loadRoot(),
    api("/api/settings").catch(() => ({})),
    api("/api/generation/options").catch(() => null),
  ]);
  if (options) state.options = options;
  if (saved.gen_image) Object.assign(state.genImage, saved.gen_image);
  if (saved.gen_video) Object.assign(state.genVideo, saved.gen_video);
  initPaneResizers(saved.pane_widths);
  startStatusPolling();
  startSystemPolling();
  const p = new URLSearchParams(location.hash.slice(1));
  const itemId = p.get("item");
  const videoPanel = p.get("video") === "1";
  await selectFolder(p.get("folder") || "");
  if (itemId) {
    await selectItem(itemId);
    if (videoPanel) {
      state.videoPanel = true;
      updateHash();
      await renderContext();
    }
  }
  const modeTab = document.querySelector(`.topbar-tab[data-mode="${p.get("mode")}"]`);
  if (modeTab && !modeTab.classList.contains("is-active")) modeTab.click();
});
