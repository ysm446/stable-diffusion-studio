/**
 * スニペット編集モード
 * 左: ファイル一覧 / 右: 生テキスト（.code-snippets JSON）エディタ
 */

import { showInputDialog } from "/frontend/dialog.js";

const $ = (sel) => document.querySelector(sel);

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

const snipState = {
  files: [],
  current: null, // 選択中ファイルの path
  dirty: false,
};

function setStatus(text) {
  $("#status").textContent = text;
}

async function loadFiles() {
  try {
    snipState.files = (await api("/api/snippets/files")).files;
  } catch (e) {
    snipState.files = [];
    setStatus(e.message);
  }
  renderFiles();
  loadRoot();
}

async function loadRoot() {
  try {
    const r = await api("/api/snippets/root");
    $("#snip-root").textContent = r.root;
    $("#snip-root").title = r.root;
  } catch {}
}

function renderFiles() {
  const el = $("#snip-files");
  el.innerHTML = "";
  if (snipState.files.length === 0) {
    el.innerHTML = '<p class="grid-empty">スニペットファイルがありません（＋で作成）</p>';
    return;
  }
  for (const f of snipState.files) {
    const row = document.createElement("div");
    row.className = "tree-node";
    if (f.path === snipState.current) row.classList.add("is-selected");
    const label = document.createElement("span");
    label.className = "palette-tree-label";
    label.textContent = `📄 ${f.path}`;
    label.title = f.path;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(f.count);
    row.append(label, count);
    row.addEventListener("click", () => selectFile(f.path));
    el.appendChild(row);
  }
}

async function selectFile(path) {
  if (snipState.dirty && !confirm("未保存の変更があります。破棄して切り替えますか？")) return;
  try {
    const res = await api(`/api/snippets/file?path=${encodeURIComponent(path)}`);
    snipState.current = path;
    snipState.dirty = false;
    $("#snip-editor").value = res.content;
    $("#snip-editing").textContent = path;
    updateSaveButton();
    renderFiles();
  } catch (e) {
    setStatus(e.message);
  }
}

function updateSaveButton() {
  $("#btn-snip-save").disabled = !snipState.current || !snipState.dirty;
}

async function saveFile() {
  if (!snipState.current || !snipState.dirty) return;
  try {
    await apiJson("/api/snippets/file", "PUT", {
      path: snipState.current,
      content: $("#snip-editor").value,
    });
    snipState.dirty = false;
    updateSaveButton();
    setStatus("スニペットを保存しました");
    // 件数更新
    snipState.files = (await api("/api/snippets/files")).files;
    renderFiles();
  } catch (e) {
    setStatus(`保存エラー: ${e.message}`);
  }
}

export function initSnippetsView() {
  $("#snip-editor").addEventListener("input", () => {
    if (snipState.current) {
      snipState.dirty = true;
      updateSaveButton();
    }
  });
  $("#snip-editor").addEventListener("keydown", (e) => {
    // Tab でタブ挿入（フォーカス移動を防ぐ）
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.target;
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + "\t" + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + 1;
      snipState.dirty = true;
      updateSaveButton();
    }
  });

  $("#btn-snip-save").addEventListener("click", saveFile);

  $("#btn-snip-new").addEventListener("click", async () => {
    const name = await showInputDialog("新しいスニペットファイル名:", "my_snippets");
    if (!name) return;
    try {
      const res = await apiJson("/api/snippets/file", "POST", { path: name });
      await loadFiles();
      await selectFile(res.path);
    } catch (e) {
      setStatus(e.message);
    }
  });

  $("#btn-snip-delete").addEventListener("click", async () => {
    if (!snipState.current) return;
    if (!confirm(`スニペットファイル「${snipState.current}」を削除しますか？`)) return;
    try {
      await api(`/api/snippets/file?path=${encodeURIComponent(snipState.current)}`, {
        method: "DELETE",
      });
      snipState.current = null;
      snipState.dirty = false;
      $("#snip-editor").value = "";
      $("#snip-editing").textContent = "";
      updateSaveButton();
      await loadFiles();
    } catch (e) {
      setStatus(e.message);
    }
  });

  $("#btn-snip-root").addEventListener("click", async () => {
    const cur = await api("/api/snippets/root").catch(() => ({}));
    let path;
    if (window.electronAPI?.selectFolder) {
      path = await window.electronAPI.selectFolder(cur.root);
      if (!path) return;
    } else {
      path = await showInputDialog("スニペットフォルダ（絶対パス）:", cur.root || "");
      if (path === null) return;
    }
    try {
      await apiJson("/api/snippets/root", "POST", { path });
      snipState.current = null;
      $("#snip-editor").value = "";
      $("#snip-editing").textContent = "";
      updateSaveButton();
      await loadFiles();
    } catch (e) {
      setStatus(e.message);
    }
  });

  $("#btn-snip-reveal").addEventListener("click", async () => {
    // フォルダはエクスプローラーで開けないため、パスをステータスに表示
    const r = await api("/api/snippets/root").catch(() => null);
    if (r) setStatus(`スニペットフォルダ: ${r.root}`);
  });
}

export async function activateSnippetsView() {
  await loadFiles();
}
