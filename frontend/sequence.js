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
  playOrder: [],
  playPos: -1,
  playHighlight: null,
  transport: null, // { nodes, durations, offsets, total }
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
    row.append(label, count);
    row.addEventListener("click", () => selectSequence(s.id));
    el.appendChild(row);
  }
}

async function selectSequence(id) {
  stopPlayback();
  seqState.currentId = id;
  seqState.selectedNode = null;
  try {
    seqState.seq = await api(`/api/sequences/${id}`);
  } catch (e) {
    setSeqStatus(e.message, true);
    seqState.seq = null;
  }
  renderList();
  renderGraph();
  if (seqState.seq && seqState.seq.nodes.length) fitView();
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

let saveTimer = null;
function saveGraph(immediate = false) {
  if (!seqState.seq) return;
  clearTimeout(saveTimer);
  const doSave = async () => {
    const payload = {
      nodes: seqState.seq.nodes.map((n) => ({
        id: n.id,
        item_id: n.item_id,
        file: n.file,
        x: n.x,
        y: n.y,
      })),
      edges: seqState.seq.edges,
    };
    try {
      const updated = await apiJson(`/api/sequences/${seqState.currentId}`, "PATCH", payload);
      // resolved なノード情報で置き換え（missing / thumb 更新）
      seqState.seq.nodes = updated.nodes;
      seqState.seq.edges = updated.edges;
      await loadList();
    } catch (e) {
      setSeqStatus(e.message, true);
    }
  };
  if (immediate) doSave();
  else saveTimer = setTimeout(doSave, 500);
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
    maxY = Math.max(maxY, n.y + 120);
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
    if (node.id === seqState.selectedNode) el.classList.add("selected");
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
      thumb.innerHTML = '<span class="seq-node-missing">⚠ 欠落</span>';
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
      saveGraph();
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

function addNodeFromVideo(v) {
  if (!seqState.seq) {
    setSeqStatus("先にシーケンスを選択（または作成）してください", true);
    return;
  }
  // ビュー中央あたりに配置（少しずらして重なりを避ける）
  const rect = $("#seq-canvas").getBoundingClientRect();
  const center = screenToGraph(rect.left + rect.width / 2, rect.top + rect.height / 3);
  const offset = seqState.seq.nodes.length * 24;
  seqState.seq.nodes.push({
    id: nextNodeId(),
    item_id: v.item_id,
    file: v.file,
    x: Math.round(center.x - NODE_W / 2 + offset),
    y: Math.round(center.y + offset),
    thumb: v.thumb,
    prompt: v.prompt || v.item_prompt || "",
    missing: false,
  });
  renderGraph();
  saveGraph();
  setSeqStatus("ノードを追加しました");
}

function removeNode(id) {
  seqState.seq.nodes = seqState.seq.nodes.filter((n) => n.id !== id);
  seqState.seq.edges = seqState.seq.edges.filter((e) => e.src !== id && e.dst !== id);
  if (seqState.selectedNode === id) seqState.selectedNode = null;
  stopPlayback();
  renderGraph();
  saveGraph();
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
  saveGraph();
}

// ---------------------------------------------------------------------------
// キャンバスのマウス操作（パン・ノードドラッグ・接続・ズーム）
// ---------------------------------------------------------------------------

function initCanvasInteractions() {
  const canvas = $("#seq-canvas");
  const nodesEl = $("#seq-nodes");

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
    // 空きをドラッグ → パン
    startPan(e);
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

function startNodeDrag(id, e) {
  const node = seqState.seq.nodes.find((n) => n.id === id);
  if (!node) return;
  const start = screenToGraph(e.clientX, e.clientY);
  const orig = { x: node.x, y: node.y };
  let moved = false;
  const nodeEl = $(`.seq-node[data-id="${id}"]`);
  const onMove = (ev) => {
    const g = screenToGraph(ev.clientX, ev.clientY);
    node.x = Math.round(orig.x + (g.x - start.x));
    node.y = Math.round(orig.y + (g.y - start.y));
    if (Math.abs(g.x - start.x) > 2 || Math.abs(g.y - start.y) > 2) moved = true;
    if (nodeEl) {
      nodeEl.style.left = `${node.x}px`;
      nodeEl.style.top = `${node.y}px`;
    }
    renderEdges();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (moved) {
      saveGraph();
    } else {
      // クリック = 選択してそのノードから再生
      seqState.selectedNode = id;
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
  const player = $("#seq-player");
  if (player) {
    player.pause();
    player.onended = null;
    player.ontimeupdate = null;
  }
  updateTransportUI(0, 0);
  setPlayToggle(false);
}

function setPlayToggle(playing) {
  const btn = $("#seq-play-toggle");
  if (btn) btn.textContent = playing ? "⏸" : "▶";
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
  playAt(0);
}

async function playFrom(nodeId) {
  const order = nodeOrder(seqState.seq.nodes, seqState.seq.edges);
  const idx = order.indexOf(nodeId);
  if (idx >= 0) {
    seqState.playOrder = order;
    seqState.transport = await measureOrder(order);
    const node = seqState.seq.nodes.find((n) => n.id === nodeId);
    playAt(seqState.transport.nodes.indexOf(node));
  } else {
    // 順路外 → 単体再生
    seqState.playOrder = [nodeId];
    seqState.transport = await measureOrder([nodeId]);
    playAt(0);
  }
}

function playAt(pos, seekInClip = 0) {
  const t = seqState.transport;
  if (!t || pos < 0 || pos >= t.nodes.length) {
    stopPlayback();
    renderGraph();
    return;
  }
  const node = t.nodes[pos];
  seqState.playPos = pos;
  // ノードグラフの再生中ハイライトは元の order 上の位置で
  seqState.playHighlight = node.id;
  renderGraph();

  const player = $("#seq-player");
  const url = clipUrl(node);
  const startPlayback = () => {
    if (seekInClip > 0) {
      try {
        player.currentTime = seekInClip;
      } catch {}
    }
    player.play().catch(() => {});
    setPlayToggle(true);
  };
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
  playAt(pos, target - t.offsets[pos]);
}

function togglePlay() {
  const player = $("#seq-player");
  if (!seqState.transport) {
    // 未再生 → 連続再生を開始
    if (seqState.seq) playSequence();
    return;
  }
  if (player.paused) {
    player.play().catch(() => {});
    setPlayToggle(true);
  } else {
    player.pause();
    setPlayToggle(false);
  }
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
    add.title = "ノードとして追加";
    add.addEventListener("click", () => addNodeFromVideo(v));
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
      renderGraph();
    } catch (e) {
      setSeqStatus(e.message, true);
    }
  });

  $("#btn-seq-play").addEventListener("click", () => seqState.seq && playSequence());
  $("#seq-play-toggle").addEventListener("click", togglePlay);
  $("#seq-seek").addEventListener("mousedown", (e) => {
    const bar = $("#seq-seek");
    const seekAt = (clientX) => {
      const rect = bar.getBoundingClientRect();
      seekTo((clientX - rect.left) / rect.width);
    };
    seekAt(e.clientX);
    const onMove = (ev) => seekAt(ev.clientX);
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
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
  await Promise.all([loadList(), loadPalette()]);
  if (!seqState.currentId && seqState.list.length > 0) {
    await selectSequence(seqState.list[0].id);
  } else {
    applyView();
    renderGraph();
  }
}
