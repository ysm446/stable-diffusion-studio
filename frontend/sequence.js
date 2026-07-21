/**
 * シーケンスモード（ノードグラフ編集）
 * 左: シーケンス一覧 / 中央: ノードグラフキャンバス + プレビュー / 右: クリップパレット
 *
 * クリップ = ノード（自由配置）、ノードの out→in ポートをドラッグでつないで
 * 一本道の順路を作る。再生・書き出しは順路に沿って行う。
 */

import { showInputDialog } from "/frontend/dialog.js";

const $ = (sel) => document.querySelector(sel);

const NODE_W = 150;
const NODE_H = 120; // 概算の高さ（フィット計算・範囲選択の当たり判定用）
const PORT_CY = 50; // ノード上端からポート中心までの Y

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
  seq: null, // { id, name, nodes:[resolved], edges:[{src,dst}] }
  videos: [],
  filter: "",
  view: { panX: 40, panY: 40, zoom: 1 },
  selectedNode: null,
  selectedNodes: new Set(), // 範囲選択されたノード id（一括移動・一括削除用）
  playOrder: [],
  playPos: -1,
  playHighlight: null,
  playToken: 0, // 再生の世代。古い loadedmetadata コールバックを無効化する
  transport: null, // { nodes, durations, offsets, total }
  bgmList: [], // ライブラリの BGM 一覧
  paletteTree: null, // フォルダツリー
  paletteFolder: "", // パレットで選択中のフォルダ rel
  paletteExpanded: new Set([""]), // 展開中フォルダ
  loop: false, // ループ再生
  dirty: false, // 未保存の変更があるか
  busy: false,
};

function setSeqStatus(text, isError = false) {
  const el = $("#seq-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

const clipUrl = (n) => `/api/library/file/${n.item_id}/${n.file}`;
const thumbUrl = (itemId, thumb) => `/api/library/file/${itemId}/${thumb || "thumb.jpg"}`;

// ---------------------------------------------------------------------------
// 順路計算（最長の一本道）
// ---------------------------------------------------------------------------

function nodeOrder(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const nextOf = new Map();
  const hasIncoming = new Set();
  for (const e of edges) {
    if (ids.has(e.src) && ids.has(e.dst)) {
      nextOf.set(e.src, e.dst);
      hasIncoming.add(e.dst);
    }
  }
  const starts = nodes.map((n) => n.id).filter((id) => !hasIncoming.has(id));
  let best = [];
  for (const start of starts) {
    const chain = [];
    const seen = new Set();
    let cur = start;
    while (cur != null && !seen.has(cur)) {
      chain.push(cur);
      seen.add(cur);
      cur = nextOf.get(cur);
    }
    if (chain.length > best.length) best = chain;
  }
  return best;
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
    // 保存ボタン（行の右端）。編集できるのは選択中のシーケンスだけなので、
    // 有効になるのは「選択中かつ未保存の変更あり」のときのみ。
    const save = document.createElement("button");
    save.type = "button";
    save.className = "seq-save";
    save.title = "シーケンスを保存";
    save.textContent = "💾";
    if (s.id === seqState.currentId) {
      save.id = "btn-seq-save";
      save.disabled = !seqState.dirty;
      save.classList.toggle("is-dirty", !!seqState.dirty);
      save.addEventListener("click", (e) => {
        e.stopPropagation();
        saveSequence();
      });
    } else {
      save.disabled = true;
    }
    row.append(label, count, save);
    row.addEventListener("click", () => selectSequence(s.id));
    el.appendChild(row);
  }
}

async function selectSequence(id) {
  if (id === seqState.currentId) return;
  // 未保存の変更があれば確認
  if (seqState.dirty && !confirm("未保存の変更があります。破棄して切り替えますか？")) return;
  stopPlayback();
  seqState.currentId = id;
  seqState.selectedNode = null;
  seqState.selectedNodes = new Set();
  seqState.dirty = false;
  try {
    seqState.seq = await api(`/api/sequences/${id}`);
  } catch (e) {
    setSeqStatus(e.message, true);
    seqState.seq = null;
  }
  renderList();
  renderGraph();
  renderBgm();
  updateSaveButton();
  if (seqState.seq && seqState.seq.nodes.length) fitView();
  warnMissingNodes();
  loadSequenceIntoPlayer();
}

// 参照切れ（元の画像・動画が削除された）ノードがあればステータスで警告する
function warnMissingNodes() {
  const count = (seqState.seq?.nodes || []).filter((n) => n.missing).length;
  if (count > 0) {
    setSeqStatus(
      `⚠ 参照切れのクリップが ${count} 件あります（元の画像または動画が削除されています）`,
      true
    );
  }
}

// シーケンス選択時：先頭クリップをプレイヤーに頭出しロード（再生はしない）。
// シークバーは順路全体の長さにしておく。
async function loadSequenceIntoPlayer() {
  const player = $("#seq-player");
  if (!seqState.seq) {
    player.removeAttribute("src");
    player.load?.();
    return;
  }
  const forId = seqState.currentId;
  const order = nodeOrder(seqState.seq.nodes, seqState.seq.edges);
  const t = await measureOrder(order);
  // 計測中に別シーケンスへ切り替わっていたら破棄
  if (seqState.currentId !== forId) return;
  seqState.playOrder = order;
  seqState.transport = t;
  seqState.playPos = -1;
  seqState.playHighlight = null;
  seqState.playToken++; // 保留中の再生開始コールバックを無効化
  player.onended = null;
  player.ontimeupdate = null;
  player.onloadedmetadata = null;
  if (t.nodes.length) {
    player.src = clipUrl(t.nodes[0]);
    player.load?.();
  } else {
    player.removeAttribute("src");
    player.load?.();
  }
  updateTransportUI(0, t.total);
  setPlayToggle(false);
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

// 変更は保存ボタンを押すまで確定しない（未保存フラグを立てるだけ）
function markDirty() {
  if (!seqState.seq) return;
  seqState.dirty = true;
  updateSaveButton();
}

function updateSaveButton() {
  const btn = $("#btn-seq-save");
  if (!btn) return;
  btn.disabled = !seqState.seq || !seqState.dirty;
  btn.classList.toggle("is-dirty", !!seqState.dirty);
}

async function saveSequence() {
  if (!seqState.seq || !seqState.dirty) return;
  const payload = {
    nodes: seqState.seq.nodes.map((n) => ({
      id: n.id,
      item_id: n.item_id,
      file: n.file,
      x: n.x,
      y: n.y,
    })),
    edges: seqState.seq.edges,
    bgm: seqState.seq.bgm || null,
  };
  try {
    const updated = await apiJson(`/api/sequences/${seqState.currentId}`, "PATCH", payload);
    // resolved なノード情報で置き換え（missing / thumb 更新）
    seqState.seq.nodes = updated.nodes;
    seqState.seq.edges = updated.edges;
    seqState.seq.bgm = updated.bgm || null;
    seqState.dirty = false;
    updateSaveButton();
    await loadList();
    setSeqStatus("保存しました");
  } catch (e) {
    setSeqStatus(e.message, true);
  }
}

// ---------------------------------------------------------------------------
// 座標変換
// ---------------------------------------------------------------------------

function applyView() {
  const inner = $("#seq-canvas-inner");
  const { panX, panY, zoom } = seqState.view;
  inner.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

function screenToGraph(clientX, clientY) {
  const rect = $("#seq-canvas").getBoundingClientRect();
  const { panX, panY, zoom } = seqState.view;
  return {
    x: (clientX - rect.left - panX) / zoom,
    y: (clientY - rect.top - panY) / zoom,
  };
}

function fitView() {
  const nodes = seqState.seq?.nodes || [];
  if (!nodes.length) {
    seqState.view = { panX: 40, panY: 40, zoom: 1 };
    applyView();
    return;
  }
  const rect = $("#seq-canvas").getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  }
  const pad = 40;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const zoom = Math.min(1.2, Math.max(0.3, Math.min(rect.width / w, rect.height / h)));
  seqState.view.zoom = zoom;
  seqState.view.panX = -(minX - pad) * zoom + (rect.width - w * zoom) / 2;
  seqState.view.panY = -(minY - pad) * zoom + (rect.height - h * zoom) / 2;
  applyView();
}

// ---------------------------------------------------------------------------
// グラフ描画
// ---------------------------------------------------------------------------

function renderGraph() {
  const nodesEl = $("#seq-nodes");
  const hint = $("#seq-canvas-hint");
  nodesEl.innerHTML = "";
  if (!seqState.seq) {
    hint.textContent = "シーケンスを選択してください";
    hint.style.display = "block";
    renderEdges();
    return;
  }
  if (seqState.seq.nodes.length === 0) {
    hint.textContent = "右のパレットからクリップを追加してノードを配置しましょう";
    hint.style.display = "block";
  } else {
    hint.style.display = "none";
  }

  const order = nodeOrder(seqState.seq.nodes, seqState.seq.edges);
  const orderIndex = new Map(order.map((id, i) => [id, i + 1]));

  for (const node of seqState.seq.nodes) {
    const el = document.createElement("div");
    el.className = "seq-node";
    if (node.missing) el.classList.add("missing");
    if (node.id === seqState.selectedNode || seqState.selectedNodes.has(node.id)) {
      el.classList.add("selected");
    }
    if (seqState.playPos >= 0 && node.id === seqState.playHighlight) el.classList.add("playing");
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.dataset.id = node.id;

    // 順番バッジ
    if (orderIndex.has(node.id)) {
      const badge = document.createElement("span");
      badge.className = "seq-node-order";
      badge.textContent = String(orderIndex.get(node.id));
      el.appendChild(badge);
    }

    const thumb = document.createElement("div");
    thumb.className = "seq-node-thumb";
    if (node.missing) {
      thumb.innerHTML =
        '<div class="seq-node-missing"><span class="seq-node-missing-icon">⚠</span>元の画像/動画が<br>削除されています</div>';
      el.title = `参照切れ: ${node.item_id}/${node.file}`;
    } else {
      const img = document.createElement("img");
      img.src = thumbUrl(node.item_id, node.thumb);
      img.draggable = false;
      thumb.appendChild(img);
    }
    el.appendChild(thumb);

    const label = document.createElement("div");
    label.className = "seq-node-label";
    label.textContent = node.prompt || node.file.split("/").pop();
    label.title = `${node.item_id}/${node.file}`;
    el.appendChild(label);

    // ポート
    const inPort = document.createElement("div");
    inPort.className = "seq-port in";
    inPort.dataset.port = "in";
    const outPort = document.createElement("div");
    outPort.className = "seq-port out";
    outPort.dataset.port = "out";
    el.append(inPort, outPort);

    // 削除ボタン
    const rm = document.createElement("button");
    rm.className = "seq-node-remove";
    rm.textContent = "✕";
    rm.title = "ノードを削除";
    rm.addEventListener("mousedown", (e) => e.stopPropagation());
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      removeNode(node.id);
    });
    el.appendChild(rm);

    nodesEl.appendChild(el);
  }
  renderEdges();
}

function portAnchor(node, kind) {
  return {
    x: kind === "out" ? node.x + NODE_W : node.x,
    y: node.y + PORT_CY,
  };
}

function edgePath(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function renderEdges(preview) {
  const svg = $("#seq-edges");
  svg.innerHTML = "";
  if (!seqState.seq) return;
  const byId = new Map(seqState.seq.nodes.map((n) => [n.id, n]));
  for (const e of seqState.seq.edges) {
    const s = byId.get(e.src);
    const d = byId.get(e.dst);
    if (!s || !d) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", edgePath(portAnchor(s, "out"), portAnchor(d, "in")));
    path.setAttribute("class", "seq-edge-line");
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("d", path.getAttribute("d"));
    hit.setAttribute("class", "seq-edge-hit");
    hit.addEventListener("click", () => {
      seqState.seq.edges = seqState.seq.edges.filter(
        (x) => !(x.src === e.src && x.dst === e.dst)
      );
      renderGraph();
      markDirty();
    });
    svg.append(path, hit);
  }
  if (preview) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", edgePath(preview.from, preview.to));
    path.setAttribute("class", "seq-edge-line preview");
    svg.appendChild(path);
  }
}

// ---------------------------------------------------------------------------
// ノード操作
// ---------------------------------------------------------------------------

function nextNodeId() {
  const ids = seqState.seq.nodes.map((n) => n.id);
  return (ids.length ? Math.max(...ids) : 0) + 1;
}

// グラフ座標 (gx, gy) を中心にノードを配置
function addNodeAt(v, gx, gy) {
  if (!seqState.seq) {
    setSeqStatus("先にシーケンスを選択（または作成）してください", true);
    return;
  }
  seqState.seq.nodes.push({
    id: nextNodeId(),
    item_id: v.item_id,
    file: v.file,
    x: Math.round(gx - NODE_W / 2),
    y: Math.round(gy - PORT_CY),
    thumb: v.thumb,
    prompt: v.prompt || v.item_prompt || "",
    missing: false,
  });
  renderGraph();
  markDirty();
  setSeqStatus("ノードを追加しました");
}

// ＋ ボタン：ビュー中央あたりに配置（少しずらして重なりを避ける）
function addNodeFromVideo(v) {
  if (!seqState.seq) {
    setSeqStatus("先にシーケンスを選択（または作成）してください", true);
    return;
  }
  const rect = $("#seq-canvas").getBoundingClientRect();
  const center = screenToGraph(rect.left + rect.width / 2, rect.top + rect.height / 3);
  const offset = seqState.seq.nodes.length * 24;
  addNodeAt(v, center.x + offset, center.y + PORT_CY + offset);
}

function removeNode(id) {
  seqState.seq.nodes = seqState.seq.nodes.filter((n) => n.id !== id);
  seqState.seq.edges = seqState.seq.edges.filter((e) => e.src !== id && e.dst !== id);
  if (seqState.selectedNode === id) seqState.selectedNode = null;
  seqState.selectedNodes.delete(id);
  stopPlayback();
  renderGraph();
  markDirty();
}

// 範囲選択されたノード（＋フォーカス中ノード）をまとめて削除
function removeSelectedNodes() {
  if (!seqState.seq) return;
  const ids = new Set(seqState.selectedNodes);
  if (seqState.selectedNode != null) ids.add(seqState.selectedNode);
  if (!ids.size) return;
  seqState.seq.nodes = seqState.seq.nodes.filter((n) => !ids.has(n.id));
  seqState.seq.edges = seqState.seq.edges.filter((e) => !ids.has(e.src) && !ids.has(e.dst));
  seqState.selectedNode = null;
  seqState.selectedNodes = new Set();
  stopPlayback();
  renderGraph();
  markDirty();
  setSeqStatus(`${ids.size} 件のノードを削除しました`);
}

function addEdge(src, dst) {
  if (src === dst) return;
  // 一本道: src の out と dst の in は1本ずつ。既存を張り替え
  seqState.seq.edges = seqState.seq.edges.filter((e) => e.src !== src && e.dst !== dst);
  // 循環防止: dst から辿って src に戻らないか
  const next = new Map(seqState.seq.edges.map((e) => [e.src, e.dst]));
  let cur = dst;
  const seen = new Set();
  while (cur != null && !seen.has(cur)) {
    if (cur === src) {
      setSeqStatus("循環になるため接続できません", true);
      renderGraph();
      return;
    }
    seen.add(cur);
    cur = next.get(cur);
  }
  seqState.seq.edges.push({ src, dst });
  renderGraph();
  markDirty();
}

// ---------------------------------------------------------------------------
// キャンバスのマウス操作（パン・ノードドラッグ・接続・ズーム）
// ---------------------------------------------------------------------------

function initCanvasInteractions() {
  const canvas = $("#seq-canvas");
  const nodesEl = $("#seq-nodes");

  // パレットからのクリップをドロップしてノード配置
  canvas.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("application/x-clip")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      canvas.classList.add("is-drop-target");
    }
  });
  canvas.addEventListener("dragleave", (e) => {
    if (!canvas.contains(e.relatedTarget)) canvas.classList.remove("is-drop-target");
  });
  canvas.addEventListener("drop", (e) => {
    canvas.classList.remove("is-drop-target");
    const raw = e.dataTransfer.getData("application/x-clip");
    if (!raw) return;
    e.preventDefault();
    let clip;
    try {
      clip = JSON.parse(raw);
    } catch {
      return;
    }
    const g = screenToGraph(e.clientX, e.clientY);
    addNodeAt(clip, g.x, g.y);
  });

  // ズーム
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const { zoom } = seqState.view;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.max(0.25, Math.min(2.5, zoom * factor));
    // カーソル位置を中心にズーム
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    seqState.view.panX = cx - (cx - seqState.view.panX) * (newZoom / zoom);
    seqState.view.panY = cy - (cy - seqState.view.panY) * (newZoom / zoom);
    seqState.view.zoom = newZoom;
    applyView();
  });

  canvas.addEventListener("mousedown", (e) => {
    if (!seqState.seq) return;
    // 中ボタンドラッグ → パン（どこを掴んでもよい）
    if (e.button === 1) {
      e.preventDefault();
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    const portEl = e.target.closest(".seq-port");
    const nodeEl = e.target.closest(".seq-node");

    // ポートから接続開始
    if (portEl && nodeEl) {
      e.preventDefault();
      e.stopPropagation();
      startConnect(parseInt(nodeEl.dataset.id, 10), portEl.dataset.port, e);
      return;
    }
    // ノードドラッグ / 選択・再生
    if (nodeEl) {
      e.preventDefault();
      startNodeDrag(parseInt(nodeEl.dataset.id, 10), e);
      return;
    }
    // 空きを左ドラッグ → 範囲選択（クリックだけなら選択解除）
    startRubberBand(e);
  });

  // Del キー：範囲選択したノードを削除（入力中は無効）
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Delete") return;
    if ($("#view-sequence").hidden) return;
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || document.activeElement?.isContentEditable) return;
    if (!seqState.selectedNodes.size && seqState.selectedNode == null) return;
    e.preventDefault();
    removeSelectedNodes();
  });
}

function startPan(e) {
  const start = { x: e.clientX, y: e.clientY };
  const origin = { ...seqState.view };
  const onMove = (ev) => {
    seqState.view.panX = origin.panX + (ev.clientX - start.x);
    seqState.view.panY = origin.panY + (ev.clientY - start.y);
    applyView();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// 選択状態のハイライトだけを更新（ドラッグ中の再描画を避ける）
function updateNodeSelectionClasses() {
  document.querySelectorAll("#seq-nodes .seq-node").forEach((el) => {
    const id = parseInt(el.dataset.id, 10);
    el.classList.toggle(
      "selected",
      seqState.selectedNodes.has(id) || id === seqState.selectedNode
    );
  });
}

// 空き地の左ドラッグで矩形の範囲選択。Shift 押下で既存の選択に追加する
function startRubberBand(e) {
  const canvas = $("#seq-canvas");
  const rect = canvas.getBoundingClientRect();
  const start = { x: e.clientX, y: e.clientY };
  const base = e.shiftKey ? new Set(seqState.selectedNodes) : new Set();
  let box = null;
  const onMove = (ev) => {
    if (!box) {
      if (Math.abs(ev.clientX - start.x) < 3 && Math.abs(ev.clientY - start.y) < 3) return;
      box = document.createElement("div");
      box.className = "seq-select-box";
      canvas.appendChild(box);
    }
    const left = Math.min(start.x, ev.clientX);
    const top = Math.min(start.y, ev.clientY);
    const right = Math.max(start.x, ev.clientX);
    const bottom = Math.max(start.y, ev.clientY);
    box.style.left = `${left - rect.left}px`;
    box.style.top = `${top - rect.top}px`;
    box.style.width = `${right - left}px`;
    box.style.height = `${bottom - top}px`;
    // グラフ座標で矩形とノードの交差判定
    const a = screenToGraph(left, top);
    const b = screenToGraph(right, bottom);
    const sel = new Set(base);
    for (const n of seqState.seq.nodes) {
      if (n.x < b.x && n.x + NODE_W > a.x && n.y < b.y && n.y + NODE_H > a.y) {
        sel.add(n.id);
      }
    }
    seqState.selectedNodes = sel;
    updateNodeSelectionClasses();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (box) {
      box.remove();
      if (seqState.selectedNodes.size) {
        setSeqStatus(`${seqState.selectedNodes.size} 件のノードを選択中（ドラッグで移動 / Del で削除）`);
      }
    } else {
      // ドラッグせずクリック → 選択解除
      seqState.selectedNodes = new Set();
      seqState.selectedNode = null;
      updateNodeSelectionClasses();
    }
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startNodeDrag(id, e) {
  const node = seqState.seq.nodes.find((n) => n.id === id);
  if (!node) return;
  // 範囲選択に含まれるノードを掴んだ場合は選択全体を一括移動する
  const group =
    seqState.selectedNodes.has(id) && seqState.selectedNodes.size > 1
      ? seqState.seq.nodes.filter((n) => seqState.selectedNodes.has(n.id))
      : [node];
  const start = screenToGraph(e.clientX, e.clientY);
  const origs = new Map(group.map((n) => [n.id, { x: n.x, y: n.y }]));
  const els = new Map(
    group.map((n) => [n.id, $(`.seq-node[data-id="${n.id}"]`)])
  );
  let moved = false;
  const onMove = (ev) => {
    const g = screenToGraph(ev.clientX, ev.clientY);
    const dx = g.x - start.x;
    const dy = g.y - start.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    for (const n of group) {
      const orig = origs.get(n.id);
      n.x = Math.round(orig.x + dx);
      n.y = Math.round(orig.y + dy);
      const el = els.get(n.id);
      if (el) {
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
      }
    }
    renderEdges();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (moved) {
      markDirty();
    } else {
      // クリック = 選択してそのノードから再生
      seqState.selectedNode = id;
      seqState.selectedNodes = new Set();
      renderGraph();
      playFrom(id);
    }
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startConnect(srcId, kind, e) {
  const node = seqState.seq.nodes.find((n) => n.id === srcId);
  if (!node) return;
  // in ポートから始めた場合も out→in で扱う（開始側が dst になる）
  const fromOut = kind === "out";
  const anchor = portAnchor(node, kind);
  const onMove = (ev) => {
    const g = screenToGraph(ev.clientX, ev.clientY);
    renderEdges(fromOut ? { from: anchor, to: g } : { from: g, to: anchor });
  };
  const onUp = (ev) => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    const targetPort = ev.target.closest(".seq-port");
    const targetNode = ev.target.closest(".seq-node");
    if (targetPort && targetNode) {
      const dstId = parseInt(targetNode.dataset.id, 10);
      const dstKind = targetPort.dataset.port;
      // out→in の向きになるよう調整
      if (fromOut && dstKind === "in") addEdge(srcId, dstId);
      else if (!fromOut && dstKind === "out") addEdge(dstId, srcId);
      else {
        setSeqStatus("out ポートと in ポートをつないでください", true);
        renderEdges();
      }
    } else {
      renderEdges();
    }
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ---------------------------------------------------------------------------
// 連続再生（独自プレイヤー：シークバーは順路全体の長さ）
// ---------------------------------------------------------------------------

const durationCache = new Map(); // clipUrl -> 秒

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// order（ノード id 列）の各クリップの尺を取得し、[durations, offsets, total] を返す
async function measureOrder(order) {
  const nodes = order
    .map((id) => seqState.seq.nodes.find((n) => n.id === id))
    .filter((n) => n && !n.missing);
  const durations = await Promise.all(nodes.map((n) => clipDuration(clipUrl(n))));
  const offsets = [];
  let acc = 0;
  for (const d of durations) {
    offsets.push(acc);
    acc += d;
  }
  return { nodes, durations, offsets, total: acc };
}

function clipDuration(url) {
  if (durationCache.has(url)) return Promise.resolve(durationCache.get(url));
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = url;
    v.addEventListener("loadedmetadata", () => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      durationCache.set(url, d);
      resolve(d);
    });
    v.addEventListener("error", () => {
      durationCache.set(url, 0);
      resolve(0);
    });
  });
}

function stopPlayback() {
  seqState.playPos = -1;
  seqState.playOrder = [];
  seqState.transport = null;
  seqState.playToken++; // 保留中の再生開始コールバックを無効化
  const player = $("#seq-player");
  if (player) {
    player.pause();
    player.onended = null;
    player.ontimeupdate = null;
    player.onloadedmetadata = null;
  }
  updateTransportUI(0, 0);
  setPlayToggle(false);
  pauseBgm();
}

function setPlayToggle(playing) {
  const btn = $("#seq-play-toggle");
  if (btn) btn.textContent = playing ? "⏸" : "▶";
}

// BGM を用意（src / volume をセット）。用意できなければ null を返す
function ensureBgmAudio() {
  // 試聴が鳴っていたら止める（重複再生を防ぐ）
  if (previewName) {
    previewAudio.pause();
    previewName = null;
    renderBgm();
  }
  const bgm = seqState.seq?.bgm;
  if (!bgm || !bgm.file) return null;
  const audio = $("#seq-bgm-audio");
  const url = `/api/library/bgm/${encodeURIComponent(bgm.file)}/file`;
  if (audio.src !== new URL(url, location.href).href) audio.src = url;
  audio.volume = bgm.volume ?? 0.8;
  return audio;
}

// 現在位置から継続再生（一時停止からの復帰・クリップ送りで使う）
function startBgm() {
  const audio = ensureBgmAudio();
  if (audio) audio.play().catch(() => {});
}

// 順路全体の時刻 globalTime に合わせて BGM をジャンプ（ループを考慮）して再生
function syncBgm(globalTime) {
  const audio = ensureBgmAudio();
  if (!audio) return;
  const apply = () => {
    const d = audio.duration;
    audio.currentTime = Number.isFinite(d) && d > 0 ? globalTime % d : globalTime;
    audio.play().catch(() => {});
  };
  if (audio.readyState >= 1 && Number.isFinite(audio.duration)) apply();
  else audio.addEventListener("loadedmetadata", apply, { once: true });
}

function pauseBgm() {
  $("#seq-bgm-audio").pause();
}

function updateTransportUI(cur, total) {
  const fill = $("#seq-seek-fill");
  if (fill) fill.style.width = total > 0 ? `${(cur / total) * 100}%` : "0%";
  const c = $("#seq-time-cur");
  const t = $("#seq-time-total");
  if (c) c.textContent = fmtTime(cur);
  if (t) t.textContent = fmtTime(total);
}

async function playSequence() {
  const order = nodeOrder(seqState.seq.nodes, seqState.seq.edges);
  if (!order.length) {
    setSeqStatus("順路がありません。ノードを線でつないでください", true);
    return;
  }
  seqState.playOrder = order;
  const t = await measureOrder(order);
  if (!t.nodes.length) {
    setSeqStatus("再生できるクリップがありません", true);
    return;
  }
  seqState.transport = t;
  playAt(0, 0, { bgmGlobal: 0 });
}

async function playFrom(nodeId) {
  const order = nodeOrder(seqState.seq.nodes, seqState.seq.edges);
  const idx = order.indexOf(nodeId);
  if (idx >= 0) {
    seqState.playOrder = order;
    seqState.transport = await measureOrder(order);
    const node = seqState.seq.nodes.find((n) => n.id === nodeId);
    const idx2 = seqState.transport.nodes.indexOf(node);
    playAt(idx2, 0, { bgmGlobal: seqState.transport.offsets[idx2] || 0 });
  } else {
    // 順路外 → 単体再生
    seqState.playOrder = [nodeId];
    seqState.transport = await measureOrder([nodeId]);
    playAt(0, 0, { bgmGlobal: 0 });
  }
}

// opts.bgmGlobal: BGM をこの順路全体時刻に合わせる（シーク時）。未指定なら継続再生
function playAt(pos, seekInClip = 0, opts = {}) {
  const t = seqState.transport;
  if (!t || !t.nodes.length) {
    stopPlayback();
    renderGraph();
    return;
  }
  if (pos < 0 || pos >= t.nodes.length) {
    // 末尾まで再生し終えた：ループ ON なら先頭から再生、OFF なら頭出しして待機
    if (seqState.loop) {
      playAt(0, 0, { bgmGlobal: 0 });
    } else {
      resetToHead();
    }
    return;
  }
  const node = t.nodes[pos];
  seqState.playPos = pos;
  // ノードグラフの再生中ハイライトは元の order 上の位置で
  seqState.playHighlight = node.id;
  renderGraph();

  const player = $("#seq-player");
  player.loop = false; // 順路はクリップ送りで進むので単体ループは無効
  const url = clipUrl(node);
  const token = ++seqState.playToken;
  const startPlayback = () => {
    if (token !== seqState.playToken) return; // 古い世代のコールバックは無視
    if (seekInClip > 0) {
      try {
        player.currentTime = seekInClip;
      } catch {}
    }
    player.play().catch(() => {});
    setPlayToggle(true);
    // シーク時は BGM も同じ位置へジャンプ、通常送りは継続再生
    if (opts.bgmGlobal != null) syncBgm(opts.bgmGlobal);
    else startBgm();
  };
  player.onloadedmetadata = null;
  if (player.src !== new URL(url, location.href).href) {
    player.src = url;
    player.onloadedmetadata = startPlayback;
  } else {
    startPlayback();
  }
  player.ontimeupdate = () => {
    const cur = t.offsets[pos] + (player.currentTime || 0);
    updateTransportUI(cur, t.total);
  };
  player.onended = () => {
    if (seqState.playPos === pos) playAt(pos + 1);
  };
}

// シークバーのクリック → 全体尺に対する位置へジャンプ
function seekTo(fraction) {
  const t = seqState.transport;
  if (!t || t.total <= 0) return;
  const target = Math.max(0, Math.min(t.total, fraction * t.total));
  let pos = 0;
  while (pos < t.nodes.length - 1 && t.offsets[pos + 1] <= target) pos++;
  playAt(pos, target - t.offsets[pos], { bgmGlobal: target });
}

// 先頭クリップに頭出しして待機（再生はしない）。トランスポートは保持
function resetToHead() {
  const t = seqState.transport;
  seqState.playPos = -1;
  seqState.playHighlight = null;
  seqState.playToken++; // 保留中の再生開始コールバックを無効化
  renderGraph();
  const player = $("#seq-player");
  player.onended = null;
  player.ontimeupdate = null;
  player.onloadedmetadata = null;
  if (t && t.nodes.length) {
    player.src = clipUrl(t.nodes[0]);
    player.load?.();
  }
  updateTransportUI(0, t ? t.total : 0);
  setPlayToggle(false);
  pauseBgm();
}

function togglePlay() {
  const player = $("#seq-player");
  if (!seqState.transport || !seqState.transport.nodes.length) {
    if (seqState.seq) playSequence();
    return;
  }
  if (seqState.playPos < 0) {
    // 頭出しロード済み → 現在位置（先頭 or シーク位置）から再生開始
    playAt(0, player.currentTime || 0, { bgmGlobal: player.currentTime || 0 });
    return;
  }
  if (player.paused) {
    player.play().catch(() => {});
    setPlayToggle(true);
    startBgm();
  } else {
    player.pause();
    setPlayToggle(false);
    pauseBgm();
  }
}

// ---------------------------------------------------------------------------
// BGM
// ---------------------------------------------------------------------------

// 試聴用の共有オーディオ（連打・重複再生を防ぐ）
const previewAudio = new Audio();
let previewName = null;
previewAudio.addEventListener("ended", () => {
  previewName = null;
  renderBgm();
});

function bgmFileUrl(name) {
  return `/api/library/bgm/${encodeURIComponent(name)}/file`;
}

function togglePreview(name) {
  if (previewName === name && !previewAudio.paused) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    previewName = null;
  } else {
    previewAudio.src = bgmFileUrl(name);
    previewAudio.currentTime = 0;
    previewAudio.play().catch(() => {});
    previewName = name;
  }
  renderBgm();
}

async function loadBgm() {
  try {
    seqState.bgmList = (await api("/api/library/bgm")).bgm;
  } catch {
    seqState.bgmList = [];
  }
  renderBgm();
}

function renderBgm() {
  const el = $("#seq-bgm");
  el.innerHTML = "";

  const head = document.createElement("div");
  head.className = "seq-bgm-head";
  head.textContent = "🎵 BGM";
  el.appendChild(head);

  // このシーケンスの BGM 選択
  if (seqState.seq) {
    const cur = seqState.seq.bgm || {};
    const row = document.createElement("div");
    row.className = "seq-bgm-select";
    const sel = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "（なし）";
    sel.appendChild(none);
    for (const b of seqState.bgmList) {
      const opt = document.createElement("option");
      opt.value = b.name;
      opt.textContent = b.name;
      sel.appendChild(opt);
    }
    sel.value = cur.file || "";
    sel.addEventListener("change", () => setSequenceBgm(sel.value));
    row.appendChild(sel);
    el.appendChild(row);

    // 音量
    const vol = document.createElement("input");
    vol.type = "range";
    vol.min = "0";
    vol.max = "1";
    vol.step = "0.05";
    vol.value = cur.volume ?? 0.8;
    vol.title = "BGM 音量";
    vol.addEventListener("input", () => {
      const audio = $("#seq-bgm-audio");
      audio.volume = parseFloat(vol.value);
    });
    vol.addEventListener("change", () => {
      if (seqState.seq?.bgm) setSequenceBgm(seqState.seq.bgm.file, parseFloat(vol.value));
    });
    el.appendChild(vol);
  }

  // BGM ファイル一覧（ドロップで追加・削除）
  const drop = document.createElement("div");
  drop.className = "seq-bgm-drop";
  drop.id = "seq-bgm-drop";
  drop.textContent = "🎵 mp3 をここにドロップして追加";
  el.appendChild(drop);

  const list = document.createElement("div");
  list.className = "seq-bgm-list";
  for (const b of seqState.bgmList) {
    const item = document.createElement("div");
    item.className = "seq-bgm-item";
    const playing = previewName === b.name;
    const play = document.createElement("button");
    play.textContent = playing ? "⏹" : "▶";
    play.title = playing ? "停止" : "試聴";
    play.addEventListener("click", () => togglePreview(b.name));
    const name = document.createElement("span");
    name.className = "seq-bgm-name";
    name.textContent = b.name;
    name.title = b.name;
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "✕";
    del.title = "BGM を削除";
    del.addEventListener("click", async () => {
      if (!confirm(`BGM「${b.name}」を削除しますか？`)) return;
      if (previewName === b.name) {
        previewAudio.pause();
        previewName = null;
      }
      await api(`/api/library/bgm/${encodeURIComponent(b.name)}`, { method: "DELETE" });
      await loadBgm();
    });
    item.append(play, name, del);
    list.appendChild(item);
  }
  el.appendChild(list);

  setupBgmDrop(drop);
}

function setupBgmDrop(drop) {
  drop.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("Files")) {
      e.preventDefault();
      drop.classList.add("is-drop-target");
    }
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-drop-target"));
  drop.addEventListener("drop", async (e) => {
    drop.classList.remove("is-drop-target");
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    const audio = [...e.dataTransfer.files].filter((f) =>
      /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name)
    );
    if (audio.length === 0) {
      setSeqStatus("音声ファイル（mp3 等）をドロップしてください", true);
      return;
    }
    for (const file of audio) {
      const form = new FormData();
      form.append("file", file);
      try {
        await api("/api/library/bgm", { method: "POST", body: form });
      } catch (err) {
        setSeqStatus(err.message, true);
      }
    }
    setSeqStatus(`${audio.length} 件の BGM を追加しました`);
    await loadBgm();
  });
}

function setSequenceBgm(file, volume) {
  if (!seqState.seq) return;
  // ローカルに反映（保存ボタンで確定）
  seqState.seq.bgm = file
    ? { file, volume: volume ?? seqState.seq.bgm?.volume ?? 0.8 }
    : null;
  markDirty();
  applyBgmToPlayback();
  renderBgm();
}

// 現在の再生状態に BGM を同期させる
function applyBgmToPlayback() {
  const audio = $("#seq-bgm-audio");
  const bgm = seqState.seq?.bgm;
  const player = $("#seq-player");
  if (!bgm || !bgm.file) {
    audio.pause();
    audio.removeAttribute("src");
    return;
  }
  const url = `/api/library/bgm/${encodeURIComponent(bgm.file)}/file`;
  if (audio.src !== new URL(url, location.href).href) audio.src = url;
  audio.volume = bgm.volume ?? 0.8;
  // 動画が再生中なら BGM も再生、止まっていれば止める
  if (player && !player.paused && seqState.playPos >= 0) {
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
}

// ---------------------------------------------------------------------------
// クリップパレット
// ---------------------------------------------------------------------------

async function loadPalette() {
  const [videos, tree] = await Promise.all([
    api("/api/library/videos").then((r) => r.videos).catch(() => []),
    api("/api/library/tree").catch(() => null),
  ]);
  seqState.videos = videos;
  seqState.paletteTree = tree;
  renderPalette();
}

// フォルダ rel 以下（再帰）の動画数
function paletteVideoCount(rel) {
  return seqState.videos.filter((v) => {
    const f = v.folder || "";
    return rel === "" ? true : f === rel || f.startsWith(rel + "/");
  }).length;
}

function renderPalette() {
  const el = $("#seq-palette");
  el.innerHTML = "";
  const q = seqState.filter.toLowerCase();

  // 検索中はフォルダ横断で結果を出す
  if (q) {
    const hits = seqState.videos.filter(
      (v) =>
        (v.prompt || "").toLowerCase().includes(q) ||
        (v.item_prompt || "").toLowerCase().includes(q) ||
        (v.workflow || "").toLowerCase().includes(q) ||
        (v.folder || "").toLowerCase().includes(q)
    );
    const list = document.createElement("div");
    list.className = "palette-clips";
    renderClipCards(list, hits, "検索結果がありません");
    el.appendChild(list);
    return;
  }

  // フォルダツリー
  if (seqState.paletteTree) {
    const treeWrap = document.createElement("div");
    treeWrap.className = "palette-tree";
    treeWrap.appendChild(buildPaletteTree(seqState.paletteTree, true));
    el.appendChild(treeWrap);
  }

  // 選択フォルダ直下のクリップ（非再帰）
  const clips = seqState.videos.filter((v) => (v.folder || "") === seqState.paletteFolder);
  const list = document.createElement("div");
  list.className = "palette-clips";
  renderClipCards(
    list,
    clips,
    "このフォルダに動画はありません（サブフォルダを選択してください）"
  );
  el.appendChild(list);
}

function buildPaletteTree(node, isRoot) {
  const ul = document.createElement("ul");
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "palette-tree-node";
  if (seqState.paletteFolder === node.rel) row.classList.add("is-selected");

  const hasChildren = node.children && node.children.length > 0;
  const expanded = seqState.paletteExpanded.has(node.rel);

  const toggle = document.createElement("span");
  toggle.className = "palette-tree-toggle";
  toggle.textContent = hasChildren ? (expanded ? "▼" : "▶") : "";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!hasChildren) return;
    if (expanded) seqState.paletteExpanded.delete(node.rel);
    else seqState.paletteExpanded.add(node.rel);
    renderPalette();
  });
  row.appendChild(toggle);

  const label = document.createElement("span");
  label.className = "palette-tree-label";
  label.textContent = isRoot ? "📚 ライブラリ" : `📁 ${node.name}`;
  row.appendChild(label);

  const count = paletteVideoCount(node.rel);
  const badge = document.createElement("span");
  badge.className = "palette-tree-count";
  badge.textContent = count > 0 ? `🎞 ${count}` : "";
  row.appendChild(badge);

  row.addEventListener("click", () => {
    seqState.paletteFolder = node.rel;
    seqState.paletteExpanded.add(node.rel);
    renderPalette();
  });
  li.appendChild(row);

  if (hasChildren && expanded) {
    for (const child of node.children) li.appendChild(buildPaletteTree(child, false));
  }
  ul.appendChild(li);
  return ul;
}

function renderClipCards(container, videos, emptyMsg) {
  if (videos.length === 0) {
    const p = document.createElement("p");
    p.className = "grid-empty";
    p.textContent = emptyMsg || "動画がありません";
    container.appendChild(p);
    return;
  }
  for (const v of videos) {
    const card = document.createElement("div");
    card.className = "palette-card";
    card.title = "クリックで試聴 / ドラッグでノード配置";
    // ノードエリアへドラッグして配置
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(
        "application/x-clip",
        JSON.stringify({ item_id: v.item_id, file: v.file, thumb: v.thumb, prompt: v.prompt || v.item_prompt || "" })
      );
      e.dataTransfer.effectAllowed = "copy";
    });
    const img = document.createElement("img");
    img.src = thumbUrl(v.item_id, v.thumb);
    img.loading = "lazy";
    img.draggable = false;
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
    // クリックでプレイヤーに読み込んで試聴
    card.addEventListener("click", () => previewClip(v));
    const add = document.createElement("button");
    add.textContent = "＋";
    add.title = "ノードとして追加";
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      addNodeFromVideo(v);
    });
    card.appendChild(add);
    container.appendChild(card);
  }
}

// パレットのクリップをプレイヤーで単体再生（順路とは独立）
function previewClip(v) {
  stopPlayback();
  seqState.transport = null;
  seqState.playOrder = [];
  seqState.playPos = -1;
  const player = $("#seq-player");
  player.onended = null;
  player.ontimeupdate = () => {
    const d = player.duration || 0;
    updateTransportUI(player.currentTime || 0, d);
  };
  player.src = `/api/library/file/${v.item_id}/${v.file}`;
  player.loop = seqState.loop;
  player.play().catch(() => {});
  setPlayToggle(true);
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

async function exportSequence() {
  if (!seqState.seq || seqState.busy) return;
  // 書き出しはサーバー保存済みの内容を使うので、未保存なら先に保存
  if (seqState.dirty) {
    if (!confirm("未保存の変更があります。保存してから書き出します。")) return;
    await saveSequence();
    if (seqState.dirty) return; // 保存に失敗
  }
  seqState.busy = true;
  const btn = $("#btn-seq-export");
  btn.disabled = true;
  try {
    const res = await fetch(`/api/sequences/${seqState.currentId}/export`, { method: "POST" });
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
  initCanvasInteractions();

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
    // 名前だけ即時保存（グラフには触れないので未保存の編集は保持される）
    seqState.seq.name = name;
    try {
      await apiJson(`/api/sequences/${seqState.currentId}`, "PATCH", { name });
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
      seqState.dirty = false;
      await loadList();
      renderGraph();
      updateSaveButton();
    } catch (e) {
      setSeqStatus(e.message, true);
    }
  });

  $("#btn-seq-play").addEventListener("click", () => seqState.seq && playSequence());
  $("#seq-play-toggle").addEventListener("click", togglePlay);
  const loopBtn = $("#seq-loop-toggle");
  loopBtn.addEventListener("click", () => {
    seqState.loop = !seqState.loop;
    loopBtn.classList.toggle("is-active", seqState.loop);
    // 単体試聴中ならその場でループ設定を反映
    const player = $("#seq-player");
    if (!seqState.transport) player.loop = seqState.loop;
    setSeqStatus(seqState.loop ? "ループ再生: ON" : "ループ再生: OFF");
  });

  // プレイヤー画面：クリックで再生/一時停止、ダブルクリックで全画面
  const player = $("#seq-player");
  const playerWrap = $(".seq-player-wrap");
  let clickTimer = null;
  // シークのドラッグが動画の上で終わると click が playerWrap に飛ぶため抑止する
  let seekDragging = false;
  playerWrap.addEventListener("click", (e) => {
    // transport バー上のクリック（シーク・ボタン）は再生トグルにしない
    if (seekDragging || e.target.closest(".seq-transport")) return;
    // シングルクリックはダブルクリック確定を少し待ってから実行
    clearTimeout(clickTimer);
    clickTimer = setTimeout(togglePlay, 200);
  });
  playerWrap.addEventListener("dblclick", (e) => {
    if (e.target.closest(".seq-transport")) return;
    clearTimeout(clickTimer);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      (playerWrap.requestFullscreen
        ? playerWrap.requestFullscreen()
        : player.requestFullscreen?.()
      )?.catch?.(() => {});
    }
  });
  $("#seq-seek").addEventListener("mousedown", (e) => {
    const bar = $("#seq-seek");
    const seekAt = (clientX) => {
      const rect = bar.getBoundingClientRect();
      seekTo((clientX - rect.left) / rect.width);
    };
    seekDragging = true;
    seekAt(e.clientX);
    const onMove = (ev) => seekAt(ev.clientX);
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // mouseup 直後の click を抑止してから解除する
      setTimeout(() => (seekDragging = false), 0);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  $("#btn-seq-fit").addEventListener("click", fitView);
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
  await Promise.all([loadList(), loadPalette(), loadBgm()]);
  if (!seqState.currentId && seqState.list.length > 0) {
    await selectSequence(seqState.list[0].id);
  } else {
    // ライブラリ側で画像や動画が削除されていても missing 表示が更新されるよう、
    // 未保存の編集がなければ表示中のシーケンスを再解決する
    if (seqState.currentId && seqState.seq && !seqState.dirty) {
      try {
        seqState.seq = await api(`/api/sequences/${seqState.currentId}`);
      } catch {}
      warnMissingNodes();
    }
    applyView();
    renderGraph();
    renderBgm();
  }
}
