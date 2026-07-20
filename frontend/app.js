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
  genVideo: { prompt: "", workflow: "", width: "", height: "", frames: "", seed: -1 },
};

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
  label.textContent = isRoot ? "📚 ライブラリ" : `📁 ${node.name}`;
  row.appendChild(label);

  if (node.item_count > 0) {
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(node.item_count);
    row.appendChild(count);
  }

  row.addEventListener("click", () => selectFolder(node.rel));
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

$("#btn-folder-new").addEventListener("click", async () => {
  if (!requireFolder()) return;
  const name = await showInputDialog("新しいフォルダ名:");
  if (!name) return;
  await run(async () => {
    const res = await apiJson("/api/library/folders", "POST", {
      parent: state.folder,
      name,
    });
    await loadTree();
    await selectFolder(res.rel);
  }, "フォルダを作成しました");
});

$("#btn-folder-rename").addEventListener("click", async () => {
  if (!requireFolder()) return;
  if (state.folder === "") {
    setStatus("ルートはリネームできません", true);
    return;
  }
  const current = state.folder.split("/").pop();
  const name = await showInputDialog("新しいフォルダ名:", current);
  if (!name || name === current) return;
  await run(async () => {
    const res = await apiJson("/api/library/folders/rename", "POST", {
      rel: state.folder,
      new_name: name,
    });
    await loadTree();
    await selectFolder(res.rel);
  }, "リネームしました");
});

$("#btn-folder-delete").addEventListener("click", async () => {
  if (!requireFolder()) return;
  if (state.folder === "") {
    setStatus("ルートは削除できません", true);
    return;
  }
  const rel = state.folder;
  if (!confirm(`フォルダ「${rel}」を削除しますか？\n中の画像・動画もすべて削除されます。`)) return;
  await run(async () => {
    await api(
      `/api/library/folders?rel=${encodeURIComponent(rel)}&recursive=true`,
      { method: "DELETE" }
    );
    await loadTree();
    await selectFolder("");
  }, "フォルダを削除しました");
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
      e.dataTransfer.setData("application/x-item-id", item.id);
      e.dataTransfer.effectAllowed = "move";
    });

    const img = document.createElement("img");
    img.loading = "lazy";
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
  state.videoPanel = false;
  updateHash();
  renderGrid();
  await renderContext();
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
  if (!e.target.closest(".card")) hideContextMenu();
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

const grid = $("#grid");
grid.addEventListener("dragover", (e) => {
  if ([...e.dataTransfer.types].includes("Files")) {
    e.preventDefault();
    grid.classList.add("is-drop-target");
  }
});
grid.addEventListener("dragleave", () => grid.classList.remove("is-drop-target"));
grid.addEventListener("drop", async (e) => {
  e.preventDefault();
  grid.classList.remove("is-drop-target");
  if (e.dataTransfer.files.length > 0) await importFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------------------
// 右パネル
// ---------------------------------------------------------------------------

async function renderContext() {
  const el = $("#context");
  el.innerHTML = "";
  if (state.selectedId) {
    const item = await run(() => api(`/api/library/items/${state.selectedId}`));
    if (item) {
      if (state.videoPanel) renderVideoGenContext(el, item);
      else renderItemContext(el, item);
      return;
    }
    state.selectedId = null;
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
  h.textContent = state.folder === null ? "未選択" : state.folder || "ライブラリ（ルート）";
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
  if (!g.prompt) g.prompt = item.prompt || "";
  el.appendChild(
    labeled("ワークフロー", makeSelect(state.options.video_workflows, g.workflow, (v) => (g.workflow = v)))
  );
  if (!g.workflow && state.options.video_workflows.length > 0) {
    g.workflow = state.options.video_workflows[0];
  }

  el.appendChild(labeled("動画プロンプト", makeTextarea(g.prompt, 5, (v) => (g.prompt = v))));

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

async function runVideoGeneration(btn, itemId) {
  if (state.genBusy) return;
  state.genBusy = true;
  btn.disabled = true;
  btn.textContent = "生成中...";
  saveGenSettings();
  try {
    await streamGenerate(
      "/api/generation/video",
      { item_id: itemId, ...state.genVideo },
      async (ev) => {
        if (ev.type === "status") setGenStatus(ev.content);
        else if (ev.type === "error") setGenStatus(ev.content, true);
        else if (ev.type === "video") {
          setGenStatus(ev.status || "動画を生成しました");
          await loadTree();
          await loadItems();
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

  if (item.prompt) el.appendChild(field("Prompt", item.prompt));
  if (item.negative_prompt) el.appendChild(field("Negative Prompt", item.negative_prompt));
  if (item.seed !== null && item.seed !== undefined)
    el.appendChild(field("Seed", String(item.seed)));
  if (item.params && Object.keys(item.params).length > 0)
    el.appendChild(
      field(
        "Params",
        Object.entries(item.params)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      )
    );

  // タグ・キャプション編集
  const tagsDiv = document.createElement("div");
  tagsDiv.className = "field";
  tagsDiv.innerHTML = '<label>タグ（カンマ区切り）</label>';
  const tagsInput = document.createElement("input");
  tagsInput.type = "text";
  tagsInput.style.width = "100%";
  tagsInput.value = (item.tags || []).join(", ");
  tagsDiv.appendChild(tagsInput);
  el.appendChild(tagsDiv);

  const capDiv = document.createElement("div");
  capDiv.className = "field";
  capDiv.innerHTML = "<label>キャプション</label>";
  const capInput = document.createElement("textarea");
  capInput.rows = 2;
  capInput.style.width = "100%";
  capInput.value = item.caption || "";
  capDiv.appendChild(capInput);
  el.appendChild(capDiv);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "タグ・キャプションを保存";
  saveBtn.addEventListener("click", async () => {
    await run(async () => {
      await apiJson(`/api/library/items/${item.id}`, "PATCH", {
        tags: tagsInput.value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        caption: capInput.value,
      });
      await loadItems();
    }, "保存しました");
  });
  el.appendChild(saveBtn);

  // 動画一覧
  const vh = document.createElement("h2");
  vh.textContent = `動画（${(item.videos || []).length}）`;
  el.appendChild(vh);

  for (const v of item.videos || []) {
    const entry = document.createElement("div");
    entry.className = "video-entry";
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = `/api/library/file/${item.id}/${v.file}`;
    entry.appendChild(video);

    const row = document.createElement("div");
    row.className = "video-row";
    const info = document.createElement("span");
    info.textContent = v.prompt || v.workflow || v.file;
    info.title = `${v.file}\n${v.created_at || ""}`;
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "削除";
    del.addEventListener("click", async () => {
      if (!confirm(`動画 ${v.file} を削除しますか？`)) return;
      const name = v.file.split("/").pop();
      await run(async () => {
        await api(`/api/library/items/${item.id}/videos/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
        await refresh();
      }, "動画を削除しました");
    });
    row.append(info, del);
    entry.appendChild(row);
    el.appendChild(entry);
  }

  const genVideoBtn = document.createElement("button");
  genVideoBtn.className = "primary";
  genVideoBtn.textContent = "🎞 動画を生成...";
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

// ---------------------------------------------------------------------------
// その他
// ---------------------------------------------------------------------------

// ライブラリルートの表示・変更 ----------------------------------------------

async function loadRoot() {
  try {
    const res = await api("/api/library/root");
    $("#root-path").textContent = res.root;
    $("#root-path").title = `ライブラリの保存先: ${res.root}`;
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
  await renderContext();
}

run(async () => {
  const [, saved, options] = await Promise.all([
    loadTree(),
    api("/api/settings").catch(() => ({})),
    api("/api/generation/options").catch(() => null),
  ]);
  loadRoot();
  if (options) state.options = options;
  if (saved.gen_image) Object.assign(state.genImage, saved.gen_image);
  if (saved.gen_video) Object.assign(state.genVideo, saved.gen_video);
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
