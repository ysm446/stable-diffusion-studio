/**
 * シーケンスモード
 * 左: シーケンス一覧 / 中央: プレビュー + クリップ並び / 右: クリップパレット
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

const seqState = {
  list: [],
  currentId: null,
  seq: null, // 選択中シーケンス（clips は解決済み）
  videos: [],
  filter: "",
  playIndex: -1,
  busy: false,
};

function setSeqStatus(text, isError = false) {
  const el = $("#seq-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function clipUrl(clip) {
  return `/api/library/file/${clip.item_id}/${clip.file}`;
}

function thumbUrl(itemId, thumb) {
  return `/api/library/file/${itemId}/${thumb || "thumb.jpg"}`;
}

// ---------------------------------------------------------------------------
// シーケンス一覧
// ---------------------------------------------------------------------------

async function loadList() {
  seqState.list = (await api("/api/sequences")).sequences;
  renderList();
}

function renderList() {
  const el = $("#seq-list");
  el.innerHTML = "";
  if (seqState.list.length === 0) {
    el.innerHTML = '<p class="grid-empty">「＋」で新しいシーケンスを作成</p>';
    return;
  }
  for (const s of seqState.list) {
    const row = document.createElement("div");
    row.className = "tree-node";
    if (s.id === seqState.currentId) row.classList.add("is-selected");
    const label = document.createElement("span");
    label.textContent = `🎬 ${s.name}`;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(s.clip_count);
    row.append(label, count);
    row.addEventListener("click", () => selectSequence(s.id));
    el.appendChild(row);
  }
}

async function selectSequence(id) {
  stopPlayback();
  seqState.currentId = id;
  try {
    seqState.seq = await api(`/api/sequences/${id}`);
  } catch (e) {
    setSeqStatus(e.message, true);
    seqState.seq = null;
  }
  renderList();
  renderClips();
}

// ---------------------------------------------------------------------------
// クリップ並び
// ---------------------------------------------------------------------------

async function patchClips() {
  if (!seqState.seq) return;
  const clips = seqState.seq.clips.map((c) => ({ item_id: c.item_id, file: c.file }));
  seqState.seq = await apiJson(`/api/sequences/${seqState.currentId}`, "PATCH", { clips });
  await loadList();
  renderClips();
}

function renderClips() {
  const el = $("#seq-clips");
  el.innerHTML = "";
  if (!seqState.seq) {
    el.innerHTML = '<p class="grid-empty">シーケンスを選択してください</p>';
    return;
  }
  const clips = seqState.seq.clips;
  if (clips.length === 0) {
    el.innerHTML = '<p class="grid-empty">右のパレットからクリップを追加</p>';
    return;
  }
  clips.forEach((clip, i) => {
    const card = document.createElement("div");
    card.className = "seq-clip";
    if (clip.missing) card.classList.add("is-missing");
    if (i === seqState.playIndex) card.classList.add("is-playing");
    card.draggable = true;

    const idx = document.createElement("span");
    idx.className = "seq-clip-index";
    idx.textContent = String(i + 1);
    card.appendChild(idx);

    const img = document.createElement("img");
    img.src = thumbUrl(clip.item_id, clip.thumb);
    img.loading = "lazy";
    card.appendChild(img);

    const label = document.createElement("div");
    label.className = "seq-clip-label";
    label.textContent = clip.missing
      ? `⚠ 欠落: ${clip.file}`
      : clip.prompt || clip.file.split("/").pop();
    label.title = `${clip.item_id}/${clip.file}`;
    card.appendChild(label);

    const del = document.createElement("button");
    del.className = "seq-clip-remove danger";
    del.textContent = "✕";
    del.title = "シーケンスから外す";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      seqState.seq.clips.splice(i, 1);
      stopPlayback();
      await patchClips();
    });
    card.appendChild(del);

    if (!clip.missing) {
      card.addEventListener("click", () => playFrom(i, false));
    }

    // ドラッグ並べ替え
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-clip-index", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragover", (e) => {
      if (e.dataTransfer.types.includes("application/x-clip-index")) {
        e.preventDefault();
        card.classList.add("is-drop-target");
      }
    });
    card.addEventListener("dragleave", () => card.classList.remove("is-drop-target"));
    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      card.classList.remove("is-drop-target");
      const from = parseInt(e.dataTransfer.getData("application/x-clip-index"), 10);
      if (Number.isNaN(from) || from === i) return;
      const [moved] = seqState.seq.clips.splice(from, 1);
      seqState.seq.clips.splice(i, 0, moved);
      stopPlayback();
      await patchClips();
    });

    el.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// 連続再生
// ---------------------------------------------------------------------------

function stopPlayback() {
  seqState.playIndex = -1;
  const player = $("#seq-player");
  player.pause();
  player.onended = null;
}

function playFrom(index, continuous = true) {
  const playable = seqState.seq?.clips || [];
  if (index < 0 || index >= playable.length) return;
  const clip = playable[index];
  if (clip.missing) {
    if (continuous) playFrom(index + 1, true);
    return;
  }
  seqState.playIndex = index;
  renderClips();
  const player = $("#seq-player");
  player.src = clipUrl(clip);
  player.onended = continuous
    ? () => {
        if (seqState.playIndex === index && index + 1 < playable.length) {
          playFrom(index + 1, true);
        } else {
          stopPlayback();
          renderClips();
        }
      }
    : () => {
        stopPlayback();
        renderClips();
      };
  player.play().catch(() => {});
}

// ---------------------------------------------------------------------------
// クリップパレット
// ---------------------------------------------------------------------------

async function loadPalette() {
  seqState.videos = (await api("/api/library/videos")).videos;
  renderPalette();
}

function renderPalette() {
  const el = $("#seq-palette");
  el.innerHTML = "";
  const q = seqState.filter.toLowerCase();
  const videos = seqState.videos.filter(
    (v) =>
      !q ||
      (v.prompt || "").toLowerCase().includes(q) ||
      (v.item_prompt || "").toLowerCase().includes(q) ||
      (v.workflow || "").toLowerCase().includes(q) ||
      (v.folder || "").toLowerCase().includes(q)
  );
  if (videos.length === 0) {
    el.innerHTML = '<p class="grid-empty">ライブラリに動画がありません</p>';
    return;
  }
  for (const v of videos) {
    const card = document.createElement("div");
    card.className = "palette-card";

    const img = document.createElement("img");
    img.src = thumbUrl(v.item_id, v.thumb);
    img.loading = "lazy";
    card.appendChild(img);

    const info = document.createElement("div");
    info.className = "palette-info";
    const title = document.createElement("div");
    title.className = "palette-title";
    title.textContent = v.prompt || v.item_prompt || v.file;
    title.title = `${v.folder || "(ルート)"} / ${v.item_id} / ${v.file}`;
    const sub = document.createElement("div");
    sub.className = "palette-sub";
    sub.textContent = v.workflow || v.file;
    info.append(title, sub);
    card.appendChild(info);

    const add = document.createElement("button");
    add.textContent = "＋";
    add.title = "シーケンスに追加";
    add.addEventListener("click", async () => {
      if (!seqState.seq) {
        setSeqStatus("先にシーケンスを選択（または作成）してください", true);
        return;
      }
      seqState.seq.clips.push({ item_id: v.item_id, file: v.file });
      await patchClips();
      setSeqStatus("クリップを追加しました");
    });
    card.appendChild(add);
    el.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

async function exportSequence() {
  if (!seqState.seq || seqState.busy) return;
  seqState.busy = true;
  const btn = $("#btn-seq-export");
  btn.disabled = true;
  try {
    const res = await fetch(`/api/sequences/${seqState.currentId}/export`, {
      method: "POST",
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
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "status") setSeqStatus(ev.content);
        else if (ev.type === "error") setSeqStatus(ev.content, true);
        else if (ev.type === "export") setSeqStatus(ev.status);
      }
    }
  } catch (e) {
    setSeqStatus(`書き出しエラー: ${e.message}`, true);
  } finally {
    seqState.busy = false;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

export function initSequenceView() {
  $("#btn-seq-new").addEventListener("click", async () => {
    const name = await showInputDialog("シーケンス名:", "新しいシーケンス");
    if (name === null) return;
    try {
      const seq = await apiJson("/api/sequences", "POST", { name });
      await loadList();
      await selectSequence(seq.id);
    } catch (e) {
      setSeqStatus(e.message, true);
    }
  });

  $("#btn-seq-rename").addEventListener("click", async () => {
    if (!seqState.seq) return;
    const name = await showInputDialog("シーケンス名:", seqState.seq.name);
    if (!name || name === seqState.seq.name) return;
    try {
      seqState.seq = await apiJson(`/api/sequences/${seqState.currentId}`, "PATCH", { name });
      await loadList();
    } catch (e) {
      setSeqStatus(e.message, true);
    }
  });

  $("#btn-seq-delete").addEventListener("click", async () => {
    if (!seqState.seq) return;
    if (!confirm(`シーケンス「${seqState.seq.name}」を削除しますか？\n（動画ファイル自体は削除されません）`)) return;
    try {
      await api(`/api/sequences/${seqState.currentId}`, { method: "DELETE" });
      stopPlayback();
      seqState.currentId = null;
      seqState.seq = null;
      await loadList();
      renderClips();
    } catch (e) {
      setSeqStatus(e.message, true);
    }
  });

  $("#btn-seq-play").addEventListener("click", () => playFrom(0, true));
  $("#btn-seq-export").addEventListener("click", exportSequence);

  let timer = null;
  $("#seq-palette-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      seqState.filter = e.target.value.trim();
      renderPalette();
    }, 200);
  });
}

export async function activateSequenceView() {
  await Promise.all([loadList(), loadPalette()]);
  if (!seqState.currentId && seqState.list.length > 0) {
    await selectSequence(seqState.list[0].id);
  } else {
    renderClips();
  }
}
