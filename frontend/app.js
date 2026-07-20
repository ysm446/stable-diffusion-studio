/**
 * ライブラリ画面（3ペイン）
 * 左: フォルダツリー / 中央: サムネイルグリッド / 右: コンテキストパネル
 */

import { initSequenceView, activateSequenceView } from "/frontend/sequence.js";
import { showInputDialog } from "/frontend/dialog.js";

const state = {
  tree: null,
  folder: null, // 選択中フォルダ rel（"" はルート、null は未選択）
  items: [],
  selectedId: null,
  currentItem: null, // 選択中画像の詳細（動画一覧を含む）
  selectedVideoFile: null, // 下部ストリップで選択中の動画 file
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
  },
  rootInfo: null, // /api/library/root の結果
  llm: { models: [], loaded: null, selected: "" },
};

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

function buildTreeList(node, isRoot) {
  const ul = document.createElement("ul");
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-node";
  row.dataset.rel = node.rel;
  if (state.folder === node.rel) row.classList.add("is-selected");

  const label = document.createElement("span");
  label.textContent = isRoot ? `📚 ${rootName()}` : `📁 ${node.name}`;
  if (isRoot) label.title = state.rootInfo?.root || "";
  row.appendChild(label);

  if (node.item_count > 0) {
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(node.item_count);
    row.appendChild(count);
  }

  row.addEventListener("click", () => selectFolder(node.rel));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (state.folder !== node.rel) selectFolder(node.rel);
    const entries = [
      {
        label: "📁 新規フォルダ（この中に）",
        action: () => createFolderIn(node.rel),
      },
      {
        label: "📂 エクスプローラーで開く",
        action: () => revealFolder(node.rel),
      },
    ];
    if (!isRoot) {
      entries.push(
        {
          label: "✎ 名前の変更",
          action: () => renameFolderRel(node.rel),
        },
        {
          label: "🗑 削除",
          danger: true,
          action: () => deleteFolderRel(node.rel),
        }
      );
    }
    showContextMenu(e.clientX, e.clientY, entries);
  });
  setupFolderDrop(row, node.rel);
  li.appendChild(row);

  for (const child of node.children) {
    li.appendChild(buildTreeList(child, false));
  }
  ul.appendChild(li);
  return ul;
}

function setupFolderDrop(row, rel) {
  row.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("application/x-item-id")) {
      e.preventDefault();
      row.classList.add("is-drop-target");
    }
  });
  row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
  row.addEventListener("drop", async (e) => {
    e.preventDefault();
    row.classList.remove("is-drop-target");
    const itemId = e.dataTransfer.getData("application/x-item-id");
    if (!itemId) return;
    await run(async () => {
      await apiJson(`/api/library/items/${itemId}/move`, "POST", { folder: rel });
      if (state.selectedId === itemId) state.selectedId = null;
      await refresh();
    }, "移動しました");
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
  state.videoPanel = false;
  state.query = "";
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

$("#btn-folder-rename").addEventListener("click", async () => {
  if (!requireFolder()) return;
  await renameFolderRel(state.folder);
});

$("#btn-folder-delete").addEventListener("click", async () => {
  if (!requireFolder()) return;
  await deleteFolderRel(state.folder);
});

// ---------------------------------------------------------------------------
// グリッド
// ---------------------------------------------------------------------------

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
  if (res.note) setStatus(res.note, true);
  renderGrid();
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
  for (const item of state.items) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = item.id;
    if (item.id === state.selectedId) card.classList.add("is-selected");
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      internalDragId = item.id;
      e.dataTransfer.setData("application/x-item-id", item.id);
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      internalDragId = null;
      card.classList.remove("drop-before", "drop-after");
    });
    // グリッド内での並べ替え
    card.addEventListener("dragover", (e) => {
      if (!internalDragId || internalDragId === item.id) return;
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
      const dragged = e.dataTransfer.getData("application/x-item-id");
      card.classList.remove("drop-before", "drop-after");
      if (!dragged || dragged === item.id) return;
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
      badge.textContent = `🎞 ${item.video_count}`;
      card.appendChild(badge);
    }

    const caption = document.createElement("div");
    caption.className = "card-caption";
    caption.textContent = item.prompt || item.caption || item.id;
    card.appendChild(caption);

    card.addEventListener("click", () => selectItem(item.id));
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (state.selectedId !== item.id) selectItem(item.id);
      showContextMenu(e.clientX, e.clientY, [
        {
          label: "✨ この設定で新規生成",
          action: async () => {
            const full = await run(() => api(`/api/library/items/${item.id}`));
            if (full) useItemForGeneration(full);
          },
        },
        {
          label: "📂 ファイルの場所を開く",
          action: () => revealItem(item.id),
        },
        {
          label: "🎞 動画を生成...",
          action: async () => {
            await selectItem(item.id);
            state.videoPanel = true;
            updateHash();
            await renderContext();
          },
        },
        {
          label: "🗑 削除",
          danger: true,
          action: () => deleteItemById(item.id, item.video_count || 0),
        },
      ]);
    });
    grid.appendChild(card);
  }
}

async function selectItem(itemId) {
  state.selectedId = itemId;
  state.selectedVideoFile = null;
  state.videoPanel = false;
  state.currentItem = await run(() => api(`/api/library/items/${itemId}`));
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
  // 画像を選択している間は常に表示（動画ファイルのドロップ受け口にする）
  if (!state.selectedId) {
    strip.hidden = true;
    list.innerHTML = "";
    return;
  }
  strip.hidden = false;
  $("#video-strip-title").textContent = videos.length
    ? `動画（${videos.length}）— クリックでプロパティ / 動画ファイルをドロップで追加`
    : "この画像に動画を追加：動画ファイルをここにドロップ";
  list.innerHTML = "";
  if (videos.length === 0) {
    const hint = document.createElement("div");
    hint.className = "vstrip-empty";
    hint.textContent = "🎞 生成済みの動画ファイルをドロップして登録";
    list.appendChild(hint);
  }
  for (const v of videos) {
    const card = document.createElement("div");
    card.className = "vstrip-card";
    if (v.file === state.selectedVideoFile) card.classList.add("is-selected");
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
    card.addEventListener("click", async () => {
      state.selectedVideoFile = v.file;
      renderVideoStrip();
      await renderContext();
    });
    list.appendChild(card);
  }
}

async function deleteItemById(itemId, videoCount = 0) {
  const warn = videoCount > 0 ? `\n紐づく動画 ${videoCount} 件も削除されます。` : "";
  if (!confirm(`この画像を削除しますか？${warn}`)) return;
  await run(async () => {
    await api(`/api/library/items/${itemId}`, { method: "DELETE" });
    if (state.selectedId === itemId) state.selectedId = null;
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
  if (item.seed !== null && item.seed !== undefined) g.seed = item.seed;

  const folder = item.folder ?? state.folder ?? "";
  // フォルダ選択に切り替える（selectedId を外して生成パネルを表示）
  state.folder = folder;
  state.selectedId = null;
  state.videoPanel = false;
  state.query = "";
  $("#search").value = "";
  updateHash();
  renderTree();
  await loadItems();
  await renderContext();
  setStatus("プロンプト・パラメータを生成パネルに読み込みました。編集して生成できます");
}

// ---------------------------------------------------------------------------
// 右クリックメニュー
// ---------------------------------------------------------------------------

let contextMenuEl = null;

function hideContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

function showContextMenu(x, y, entries) {
  hideContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  for (const entry of entries) {
    const item = document.createElement("button");
    item.className = "context-menu-item" + (entry.danger ? " danger" : "");
    item.textContent = entry.label;
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
let internalDragId = null;

async function reorderItems(draggedId, targetId, after) {
  const ids = state.items.map((it) => it.id);
  const from = ids.indexOf(draggedId);
  let to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return;
  ids.splice(from, 1);
  to = ids.indexOf(targetId);
  ids.splice(after ? to + 1 : to, 0, draggedId);
  // 楽観的に並べ替えて即描画
  const byId = new Map(state.items.map((it) => [it.id, it]));
  state.items = ids.map((id) => byId.get(id));
  renderGrid();
  await run(() =>
    apiJson("/api/library/items/reorder", "POST", { folder: state.folder, order: ids })
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
  if (!internalDragId && [...e.dataTransfer.types].includes("Files")) {
    e.preventDefault();
    grid.classList.add("is-drop-target");
  }
});
grid.addEventListener("dragleave", () => grid.classList.remove("is-drop-target"));
grid.addEventListener("drop", async (e) => {
  grid.classList.remove("is-drop-target");
  if (internalDragId) return; // アプリ内ドラッグは取り込まない
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) await importFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------------------
// 右パネル
// ---------------------------------------------------------------------------

async function renderContext() {
  const el = $("#context");
  el.innerHTML = "";
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
function autoGrowTextarea(value) {
  const ta = document.createElement("textarea");
  ta.className = "auto-grow";
  ta.value = value ?? "";
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  ta.addEventListener("input", fit);
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

// 折りたたみ式のパラメータ表（プルダウン・読み取り専用）
function paramsField(labelText, params, open = false) {
  const details = document.createElement("details");
  details.className = "params-field";
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = `${labelText}（${Object.keys(params).length}）`;
  details.appendChild(summary);

  const table = document.createElement("div");
  table.className = "params-table";
  for (const [k, v] of Object.entries(params)) {
    const row = document.createElement("div");
    row.className = "params-row";
    const key = document.createElement("span");
    key.className = "params-key";
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "params-val";
    val.textContent = String(v);
    val.title = String(v);
    row.append(key, val);
    table.appendChild(row);
  }
  details.appendChild(table);
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

  el.appendChild(labeled("Prompt", makeTextarea(g.positive, 5, (v) => (g.positive = v))));

  // ライブラリの類似プロンプト参照（旧 {library_context} 相当）
  const simBtn = document.createElement("button");
  simBtn.textContent = "🔍 ライブラリから類似プロンプトを探す";
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

  el.appendChild(labeled("Negative Prompt", makeTextarea(g.negative, 2, (v) => (g.negative = v))));

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
    labeled("Seed（-1 でランダム）", makeInput("number", g.seed, (v) => (g.seed = parseInt(v, 10) ?? -1)))
  );

  const genBtn = document.createElement("button");
  genBtn.className = "primary";
  genBtn.textContent = state.genBusy ? "生成中..." : "🖼 生成してこのフォルダに保存";
  genBtn.disabled = state.genBusy;
  genBtn.addEventListener("click", () => runImageGeneration(genBtn));
  el.appendChild(genBtn);
  el.appendChild(genStatusLine());
}

async function runImageGeneration(btn) {
  if (state.genBusy) return;
  const folder = state.folder;
  state.genBusy = true;
  btn.disabled = true;
  btn.textContent = "生成中...";
  saveGenSettings();
  try {
    await streamGenerate(
      "/api/generation/image",
      { folder, ...state.genImage },
      async (ev) => {
        if (ev.type === "status") setGenStatus(ev.content);
        else if (ev.type === "error") setGenStatus(ev.content, true);
        else if (ev.type === "item") {
          setGenStatus(ev.status || "生成完了");
          await loadTree();
          if (state.folder === folder && !state.selectedId) await loadItems();
        }
      }
    );
  } catch (e) {
    setGenStatus(`生成エラー: ${e.message}`, true);
  } finally {
    state.genBusy = false;
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = "🖼 生成してこのフォルダに保存";
    }
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
    } else if (!g.prompt) {
      g.prompt = item.prompt || "";
    }
    g._loadedFor = item.id;
  }
  el.appendChild(
    labeled("ワークフロー", makeSelect(state.options.video_workflows, g.workflow, (v) => (g.workflow = v)))
  );
  if (!g.workflow && state.options.video_workflows.length > 0) {
    g.workflow = state.options.video_workflows[0];
  }

  // LLM で動画プロンプトを生成 --------------------------------------------
  const llmBox = document.createElement("div");
  llmBox.className = "llm-box";

  const llmHead = document.createElement("div");
  llmHead.className = "llm-head";
  llmHead.textContent = "🤖 LLM で動画プロンプトを生成";
  llmBox.appendChild(llmHead);

  llmBox.appendChild(
    labeled(
      "追加指示（任意）",
      makeTextarea(g.extra, 2, (v) => (g.extra = v))
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
  if (!Array.isArray(g.sections)) g.sections = [...VIDEO_SECTIONS];
  for (const name of VIDEO_SECTIONS) {
    const lbl = document.createElement("label");
    lbl.className = "section-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = g.sections.includes(name);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!g.sections.includes(name)) g.sections.push(name);
      } else {
        g.sections = g.sections.filter((s) => s !== name);
      }
    });
    lbl.append(cb, document.createTextNode(" " + name));
    secRow.appendChild(lbl);
  }
  secWrap.appendChild(secRow);
  llmBox.appendChild(secWrap);

  const genPromptBtn = document.createElement("button");
  genPromptBtn.className = "primary";
  genPromptBtn.textContent = "✨ 動画プロンプトを生成";
  genPromptBtn.addEventListener("click", () =>
    generateVideoPrompt(genPromptBtn, item.id, promptField)
  );
  llmBox.appendChild(genPromptBtn);
  el.appendChild(llmBox);

  // 動画プロンプト本文
  const promptField = makeTextarea(g.prompt, 5, (v) => (g.prompt = v));
  el.appendChild(labeled("動画プロンプト", promptField));

  const row = document.createElement("div");
  row.className = "row";
  row.append(
    labeled("Width（空でWF値）", makeInput("number", g.width, (v) => (g.width = v))),
    labeled("Height", makeInput("number", g.height, (v) => (g.height = v)))
  );
  el.appendChild(row);

  const row2 = document.createElement("div");
  row2.className = "row";
  row2.append(
    labeled("Frames（空でWF値）", makeInput("number", g.frames, (v) => (g.frames = v))),
    labeled("Seed（-1ランダム）", makeInput("number", g.seed, (v) => (g.seed = parseInt(v, 10) ?? -1)))
  );
  el.appendChild(row2);

  const genBtn = document.createElement("button");
  genBtn.className = "primary";
  genBtn.textContent = state.genBusy ? "生成中..." : "🎞 動画を生成してこの画像に紐づけ";
  genBtn.disabled = state.genBusy;
  genBtn.addEventListener("click", () => runVideoGeneration(genBtn, item.id));
  el.appendChild(genBtn);

  const saveSettingsBtn = document.createElement("button");
  saveSettingsBtn.textContent = "💾 この設定を保存（生成せず）";
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
  backBtn.textContent = "← 画像詳細に戻る";
  backBtn.addEventListener("click", async () => {
    state.videoPanel = false;
    updateHash();
    await renderContext();
  });
  el.appendChild(backBtn);
  el.appendChild(genStatusLine());
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

async function generateVideoPrompt(btn, itemId, promptField) {
  if (btn.disabled) return;
  if (!state.llm.models.length) {
    setGenStatus("models/ フォルダに GGUF モデルが見つかりません", true);
    return;
  }
  const sections = state.genVideo.sections || [];
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
        extra_instruction: state.genVideo.extra,
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
          state.genVideo.prompt = text;
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
    btn.textContent = "✨ 動画プロンプトを生成";
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

async function runVideoGeneration(btn, itemId) {
  if (state.genBusy) return;
  state.genBusy = true;
  btn.disabled = true;
  btn.textContent = "生成中...";
  saveGenSettings();
  try {
    await streamGenerate(
      "/api/generation/video",
      { item_id: itemId, ...currentVideoSettings() },
      async (ev) => {
        if (ev.type === "status") setGenStatus(ev.content);
        else if (ev.type === "error") setGenStatus(ev.content, true);
        else if (ev.type === "video") {
          setGenStatus(ev.status || "動画を生成しました");
          await loadTree();
          await loadItems();
          if (state.currentItem) state.currentItem = ev.item;
          renderVideoStrip();
        }
      }
    );
  } catch (e) {
    setGenStatus(`生成エラー: ${e.message}`, true);
  } finally {
    state.genBusy = false;
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = "🎞 動画を生成してこの画像に紐づけ";
    }
  }
}

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
    window.open(`/api/library/file/${item.id}/${item.image}`, "_blank")
  );
  el.appendChild(img);

  // プロンプト・パラメータ（編集可能）
  const promptInput = autoGrowTextarea(item.prompt || "");
  el.appendChild(editableField("Prompt", promptInput));

  const negInput = autoGrowTextarea(item.negative_prompt || "");
  el.appendChild(editableField("Negative Prompt", negInput));

  const seedInput = document.createElement("input");
  seedInput.type = "text";
  seedInput.value =
    item.seed !== null && item.seed !== undefined ? String(item.seed) : "";
  el.appendChild(editableField("Seed", seedInput));

  const paramsEditor =
    item.params && Object.keys(item.params).length > 0
      ? editableParamsField("Params", item.params)
      : null;
  if (paramsEditor) el.appendChild(paramsEditor);

  // タグ・キャプション
  const tagsInput = document.createElement("input");
  tagsInput.type = "text";
  tagsInput.value = (item.tags || []).join(", ");
  el.appendChild(editableField("タグ（カンマ区切り）", tagsInput));

  const capInput = document.createElement("textarea");
  capInput.rows = 2;
  capInput.value = item.caption || "";
  el.appendChild(editableField("キャプション", capInput));

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "💾 プロパティを保存";
  saveBtn.addEventListener("click", async () => {
    const seedRaw = seedInput.value.trim();
    const seedNum = seedRaw === "" ? null : Number(seedRaw);
    const patch = {
      prompt: promptInput.value,
      negative_prompt: negInput.value,
      seed: Number.isFinite(seedNum) ? seedNum : null,
      tags: tagsInput.value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      caption: capInput.value,
    };
    if (paramsEditor) patch.params = paramsEditor.getValues();
    await run(async () => {
      await apiJson(`/api/library/items/${item.id}`, "PATCH", patch);
      await loadItems();
    }, "保存しました");
  });
  el.appendChild(saveBtn);

  // この画像のプロンプト・パラメータを生成パネルに読み込む
  const useBtn = document.createElement("button");
  useBtn.className = "primary";
  useBtn.textContent = "✨ この設定で新規生成";
  useBtn.title = "プロンプト・パラメータを生成パネルに読み込み、編集して生成できます";
  useBtn.addEventListener("click", () => useItemForGeneration(item));
  el.appendChild(useBtn);

  // 動画生成（動画一覧は下部ストリップに表示）
  const genVideoBtn = document.createElement("button");
  genVideoBtn.className = "primary";
  const vcount = (item.videos || []).length;
  genVideoBtn.textContent = vcount > 0 ? `🎞 動画を生成...（${vcount}件は下に表示）` : "🎞 動画を生成...";
  genVideoBtn.addEventListener("click", async () => {
    state.videoPanel = true;
    updateHash();
    await renderContext();
  });
  el.appendChild(genVideoBtn);

  // ファイル操作
  const revealBtn = document.createElement("button");
  revealBtn.textContent = "📂 ファイルの場所を開く";
  revealBtn.addEventListener("click", () => revealItem(item.id));
  el.appendChild(revealBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "danger";
  delBtn.textContent = "🗑 画像を削除";
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
  back.textContent = "← 画像のプロパティに戻る";
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

  const vs = v.settings || {};
  const vpInput = autoGrowTextarea(v.prompt || vs.prompt || "");
  el.appendChild(editableField("動画プロンプト", vpInput));
  const veInput = autoGrowTextarea(vs.extra_instruction || "");
  el.appendChild(editableField("追加指示", veInput));

  if (vs && Object.keys(vs).length > 0) {
    const shown = {};
    for (const k of ["workflow", "width", "height", "frames", "seed"]) {
      if (vs[k] !== undefined && vs[k] !== "") shown[k] = vs[k];
    }
    if (Object.keys(shown).length) el.appendChild(paramsField("生成パラメータ", shown));
  }

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "💾 保存";
  saveBtn.addEventListener("click", async () => {
    const name = v.file.split("/").pop();
    await run(async () => {
      await apiJson(`/api/library/items/${item.id}/videos/${encodeURIComponent(name)}`, "PATCH", {
        prompt: vpInput.value,
        settings: { ...vs, prompt: vpInput.value, extra_instruction: veInput.value },
      });
      await reloadCurrentItem();
    }, "保存しました");
  });
  el.appendChild(saveBtn);

  const regenBtn = document.createElement("button");
  regenBtn.className = "primary";
  regenBtn.textContent = "✨ この設定で新規動画生成";
  regenBtn.addEventListener("click", async () => {
    const g = state.genVideo;
    g.prompt = vpInput.value;
    g.extra = veInput.value;
    g.workflow = vs.workflow || v.workflow || g.workflow;
    g.width = vs.width ?? "";
    g.height = vs.height ?? "";
    g.frames = vs.frames ?? "";
    g.seed = vs.seed ?? -1;
    g._loadedFor = item.id;
    state.selectedVideoFile = null;
    state.videoPanel = true;
    updateHash();
    renderVideoStrip();
    await renderContext();
  });
  el.appendChild(regenBtn);

  const del = document.createElement("button");
  del.className = "danger";
  del.textContent = "🗑 この動画を削除";
  del.addEventListener("click", async () => {
    if (!confirm(`動画 ${v.file} を削除しますか？`)) return;
    const name = v.file.split("/").pop();
    await run(async () => {
      await api(`/api/library/items/${item.id}/videos/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      state.selectedVideoFile = null;
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

async function refreshServiceStatus() {
  const container = $("#service-status");
  try {
    const res = await api("/api/status");
    container.innerHTML = "";
    for (const s of res.services) {
      const chip = document.createElement("span");
      chip.className = `svc-chip ${s.ready ? "is-up" : "is-down"}`;
      chip.innerHTML = `<span class="svc-dot"></span>${s.label}`;
      chip.title = `${s.label}: ${s.ready ? "起動中" : "停止"} (${s.url})`;
      container.appendChild(chip);
    }
  } catch {
    container.innerHTML = '<span class="svc-chip is-down">状態不明</span>';
  }
}

function startStatusPolling() {
  refreshServiceStatus();
  clearInterval(statusPollTimer);
  statusPollTimer = setInterval(refreshServiceStatus, 8000);
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
    if (state.tree) renderTree();
    return res;
  } catch {
    return null;
  }
}

$("#btn-root").addEventListener("click", async (e) => {
  const current = await loadRoot();
  let path;
  if (e.shiftKey) {
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
});

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

// モード切替（ライブラリ / シーケンス）
for (const tab of document.querySelectorAll(".topbar-tab")) {
  tab.addEventListener("click", async () => {
    if (tab.classList.contains("is-active")) return;
    document.querySelectorAll(".topbar-tab").forEach((t) => t.classList.remove("is-active"));
    tab.classList.add("is-active");
    const isSeq = tab.dataset.mode === "sequence";
    $("#view-library").hidden = isSeq;
    $("#view-sequence").hidden = !isSeq;
    if (isSeq) await run(activateSequenceView);
  });
}

initSequenceView();

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
  if (p.get("mode") === "sequence") {
    document.querySelector('.topbar-tab[data-mode="sequence"]').click();
  }
});
