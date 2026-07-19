/**
 * ライブラリ画面（3ペイン）
 * 左: フォルダツリー / 中央: サムネイルグリッド / 右: コンテキストパネル
 */

const state = {
  tree: null,
  folder: null, // 選択中フォルダ rel（"" はルート、null は未選択）
  items: [],
  selectedId: null,
  query: "",
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

async function selectFolder(rel) {
  state.folder = rel;
  state.selectedId = null;
  state.query = "";
  $("#search").value = "";
  location.hash = rel ? `folder=${encodeURIComponent(rel)}` : "";
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
  const name = prompt("新しいフォルダ名:");
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
  const name = prompt("新しいフォルダ名:", current);
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
  if (state.query) params.set("q", state.query);
  const res = await api(`/api/library/items?${params}`);
  state.items = res.items;
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
    grid.appendChild(card);
  }
}

async function selectItem(itemId) {
  state.selectedId = itemId;
  renderGrid();
  await renderContext();
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
      renderItemContext(el, item);
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

function renderFolderContext(el) {
  const h = document.createElement("h2");
  h.textContent = state.folder === null ? "未選択" : state.folder || "ライブラリ（ルート）";
  el.appendChild(h);

  const info = document.createElement("div");
  info.className = "placeholder";
  info.textContent =
    state.folder === null
      ? "左のツリーからフォルダを選択してください"
      : `画像 ${state.items.length} 件\n\n画像生成パネルはマイルストーン3で実装予定です`;
  info.style.whiteSpace = "pre-wrap";
  el.appendChild(info);
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
  genVideoBtn.textContent = "🎞 動画を生成（マイルストーン4）";
  genVideoBtn.disabled = true;
  el.appendChild(genVideoBtn);

  // アイテム削除
  const delBtn = document.createElement("button");
  delBtn.className = "danger";
  delBtn.textContent = "画像を削除";
  delBtn.addEventListener("click", async () => {
    const n = (item.videos || []).length;
    const warn = n > 0 ? `\n紐づく動画 ${n} 件も削除されます。` : "";
    if (!confirm(`この画像を削除しますか？${warn}`)) return;
    await run(async () => {
      await api(`/api/library/items/${item.id}`, { method: "DELETE" });
      state.selectedId = null;
      await refresh();
    }, "画像を削除しました");
  });
  el.appendChild(delBtn);
}

// ---------------------------------------------------------------------------
// その他
// ---------------------------------------------------------------------------

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
  await loadTree();
  const m = location.hash.match(/^#folder=(.*)$/);
  await selectFolder(m ? decodeURIComponent(m[1]) : "");
});
