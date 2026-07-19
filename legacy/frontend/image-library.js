'use strict';

const gridEl = document.getElementById('library-grid');
const statusEl = document.getElementById('library-status');
const subtitleEl = document.getElementById('library-subtitle');
const fileInput = document.getElementById('library-file-input');
const searchInput = document.getElementById('library-search');
const searchModeSelect = document.getElementById('library-search-mode');
const sortSelect = document.getElementById('library-sort');
const dropOverlay = document.getElementById('library-drop-overlay');
const detailModal = document.getElementById('library-detail-modal');
const detailFrame = document.getElementById('library-detail-frame');
const detailCloseBtn = document.getElementById('library-detail-close');
const detailPrevBtn = document.getElementById('library-detail-prev');
const detailNextBtn = document.getElementById('library-detail-next');
const detailNavIndex = document.getElementById('library-detail-nav-index');
const scrollAreaEl = document.getElementById('library-scroll-area');
const sidebarEl = document.getElementById('library-sidebar');
const sidebarResizerEl = document.getElementById('library-sidebar-resizer');
const sentinelEl = document.getElementById('library-sentinel');
const loadingEl = document.getElementById('library-loading');
const folderAllBtn = document.getElementById('library-folder-all');
const folderListEl = document.getElementById('library-folder-list');

const PAGE_SIZE = 50;
const SIDEBAR_WIDTH_KEY = 'imageLibrarySidebarWidth';
const SEARCH_MODE_KEY = 'imageLibrarySearchMode';
const BATCH_PANEL_OPEN_KEY = 'imageLibraryBatchPanelOpen';
const SIDEBAR_MIN_WIDTH = 150;
const SIDEBAR_MAX_WIDTH = 380;
const EXPANDED_FOLDERS_KEY = 'imageLibraryExpandedFolders';
let images = [];
let totalCount = 0;
let currentOffset = 0;
let isLoading = false;
let hasMore = false;
let loadGen = 0;
let searchTimer = null;
let draggedId = null;
let folderDraggedId = null;
let dragDepth = 0;
let isReorderDrag = false;
let isFolderRenaming = false;
let batchAbortCtrl = null;
let currentFolderId = 0; // 0 = ルート（未分類）, N = フォルダN
let currentDetailId = null;
let currentFolders = [];
const expandedFolderIds = new Set();
let committedSearchQuery = '';

function setBatchPanelOpen(open) {
  const toggle = document.getElementById('batch-panel-toggle');
  const body = document.getElementById('batch-panel-body');
  if (!toggle || !body) return;
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  body.hidden = !open;
  localStorage.setItem(BATCH_PANEL_OPEN_KEY, open ? '1' : '0');
}

function updateBatchPanelSummary(text = '') {
  const summaryEl = document.getElementById('batch-panel-summary');
  if (summaryEl) summaryEl.textContent = text ? ` / ${text}` : '';
}

function setBatchProgress(progressEl, text) {
  if (progressEl) progressEl.textContent = text;
  updateBatchPanelSummary(text);
}

function initBatchPanel() {
  const toggle = document.getElementById('batch-panel-toggle');
  if (!toggle) return;
  setBatchPanelOpen(localStorage.getItem(BATCH_PANEL_OPEN_KEY) === '1');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    setBatchPanelOpen(open);
  });
}

function loadExpandedState() {
  try {
    const raw = localStorage.getItem(EXPANDED_FOLDERS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) arr.forEach(id => expandedFolderIds.add(Number(id)));
    }
  } catch (_) {}
}

function saveExpandedState() {
  try {
    localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...expandedFolderIds]));
  } catch (_) {}
}

loadExpandedState();

// 複数選択
const selectedIds = new Set();
let lastClickedId = null;

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"]/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
  ));
}

function setStatus(text, isError = false) {
  statusEl.textContent = text || '';
  statusEl.style.color = isError ? 'var(--danger)' : '';
}

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error(resp.ok ? text : `HTTP ${resp.status}: ${text}`);
    }
  }
  if (!resp.ok) {
    throw new Error(data?.detail || data?.message || `HTTP ${resp.status}`);
  }
  return data || {};
}

function clampSidebarWidth(width) {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
}

function setSidebarWidth(width, shouldSave = false) {
  const nextWidth = clampSidebarWidth(width);
  sidebarEl.style.width = `${nextWidth}px`;
  sidebarResizerEl?.setAttribute('aria-valuenow', String(nextWidth));
  if (shouldSave) {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
    } catch (_) {}
  }
}

function initSidebarResize() {
  if (!sidebarEl || !sidebarResizerEl) return;

  try {
    const savedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(savedWidth) && savedWidth > 0) setSidebarWidth(savedWidth);
  } catch (_) {}

  let startX = 0;
  let startWidth = 0;

  sidebarResizerEl.addEventListener('pointerdown', event => {
    event.preventDefault();
    startX = event.clientX;
    startWidth = sidebarEl.getBoundingClientRect().width;
    document.body.classList.add('is-resizing-sidebar');
    sidebarResizerEl.setPointerCapture?.(event.pointerId);
  });

  sidebarResizerEl.addEventListener('pointermove', event => {
    if (!document.body.classList.contains('is-resizing-sidebar')) return;
    setSidebarWidth(startWidth + event.clientX - startX);
  });

  function finishResize(event) {
    if (!document.body.classList.contains('is-resizing-sidebar')) return;
    document.body.classList.remove('is-resizing-sidebar');
    sidebarResizerEl.releasePointerCapture?.(event.pointerId);
    setSidebarWidth(sidebarEl.getBoundingClientRect().width, true);
  }

  sidebarResizerEl.addEventListener('pointerup', finishResize);
  sidebarResizerEl.addEventListener('pointercancel', finishResize);
  sidebarResizerEl.addEventListener('dblclick', () => setSidebarWidth(200, true));
  sidebarResizerEl.addEventListener('keydown', event => {
    const currentWidth = sidebarEl.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSidebarWidth(currentWidth - (event.shiftKey ? 30 : 10), true);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSidebarWidth(currentWidth + (event.shiftKey ? 30 : 10), true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MIN_WIDTH, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MAX_WIDTH, true);
    }
  });
}

function trashIcon() {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 15h10l1-15"></path>
    <path d="M10 11v6"></path><path d="M14 11v6"></path>
  </svg>`;
}

function checkIcon() {
  return `<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="1.5,6 5,9.5 10.5,2.5"></polyline>
  </svg>`;
}

function cardHtml(item) {
  const sel = selectedIds.has(item.id);
  return `
    <article class="library-card${sel ? ' is-selected' : ''}" data-id="${item.id}" draggable="true">
      <button class="library-card-select-btn${sel ? ' is-checked' : ''}" type="button" data-action="select" aria-label="選択">${sel ? checkIcon() : ''}</button>
      <button class="library-thumb-btn" type="button" data-action="open" title="詳細を開く">
        <img src="/api/library/images/${item.id}/file?thumb=1" alt="${escapeHtml(item.filename)}" loading="lazy" draggable="false">
      </button>
      <div class="library-card-title">${escapeHtml(item.filename)}</div>
      <div class="library-card-meta">${item.width || '-'} x ${item.height || '-'} / #${item.id}</div>
      <div class="library-card-caption">${escapeHtml(item.caption || item.positive_prompt || '')}</div>
      <div class="library-card-controls">
        <button class="library-delete-btn" type="button" data-action="delete" aria-label="削除" title="削除">${trashIcon()}</button>
      </div>
    </article>
  `;
}

// ---------------------------------------------------------------------------
// 選択管理
// ---------------------------------------------------------------------------

function updateSelectionUI() {
  document.querySelectorAll('.library-card').forEach(card => {
    const id = Number(card.dataset.id);
    const sel = selectedIds.has(id);
    card.classList.toggle('is-selected', sel);
    const btn = card.querySelector('.library-card-select-btn');
    if (!btn) return;
    btn.classList.toggle('is-checked', sel);
    btn.innerHTML = sel ? checkIcon() : '';
  });
}

function clearSelection() {
  selectedIds.clear();
  lastClickedId = null;
  updateSelectionUI();
}

function toggleSelection(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  lastClickedId = id;
  updateSelectionUI();
}

function rangeSelect(fromId, toId) {
  const allIds = images.map(item => item.id);
  const fromIdx = allIds.indexOf(fromId);
  const toIdx = allIds.indexOf(toId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [start, end] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
  for (let i = start; i <= end; i++) selectedIds.add(allIds[i]);
  updateSelectionUI();
}

// ---------------------------------------------------------------------------
// グリッド描画
// ---------------------------------------------------------------------------

function appendCards(newImages) {
  const isManualOrder = sortSelect.value === 'custom' && !committedSearchQuery;
  gridEl.classList.toggle('is-reorderable', isManualOrder);
  const tmpl = document.createElement('template');
  tmpl.innerHTML = newImages.map(item => cardHtml(item)).join('');
  gridEl.appendChild(tmpl.content);
}

function render() {
  const isManualOrder = sortSelect.value === 'custom' && !committedSearchQuery;
  gridEl.classList.toggle('is-reorderable', isManualOrder);
  if (!images.length) {
    gridEl.innerHTML = '<div class="status-small">画像はまだ登録されていません。</div>';
    return;
  }
  gridEl.innerHTML = images.map(item => cardHtml(item)).join('');
}

function updateSubtitle() {
  if (totalCount === 0) {
    subtitleEl.textContent = '0 images';
  } else if (images.length < totalCount) {
    subtitleEl.textContent = `${images.length} / ${totalCount} images`;
  } else {
    subtitleEl.textContent = `${totalCount} images`;
  }
}

async function loadMore() {
  if (isLoading) return;
  isLoading = true;
  loadingEl.hidden = false;
  const myGen = loadGen;
  try {
    const params = new URLSearchParams({
      q: committedSearchQuery,
      sort: sortSelect.value,
      limit: PAGE_SIZE,
      offset: currentOffset,
      search_mode: searchModeSelect?.value || 'hybrid',
    });
    if (!committedSearchQuery) {
      params.set('folder_id', String(currentFolderId));
    }
    const data = await fetchJson(`/api/library/images?${params}`);
    if (myGen !== loadGen) return;
    const newImages = Array.isArray(data.images) ? data.images : [];
    totalCount = typeof data.total === 'number' ? data.total : (currentOffset + newImages.length);
    images.push(...newImages);
    currentOffset += newImages.length;
    hasMore = currentOffset < totalCount;
    if (images.length === 0) {
      gridEl.innerHTML = '<div class="status-small">画像はまだ登録されていません。</div>';
    } else {
      appendCards(newImages);
    }
    updateSubtitle();
  } catch (err) {
    if (myGen === loadGen) setStatus(String(err), true);
  } finally {
    if (myGen === loadGen) {
      isLoading = false;
      loadingEl.hidden = true;
    }
  }
}

async function loadImages() {
  clearSelection();
  sortSelect.disabled = !!committedSearchQuery;
  loadGen++;
  isLoading = false;
  images = [];
  currentOffset = 0;
  totalCount = 0;
  hasMore = false;
  gridEl.innerHTML = '';
  await loadMore();
}

const scrollObserver = new IntersectionObserver(
  ([entry]) => {
    if (entry.isIntersecting && hasMore && !isLoading) {
      void loadMore();
    }
  },
  { root: scrollAreaEl, rootMargin: '200px' }
);
scrollObserver.observe(sentinelEl);

// ---------------------------------------------------------------------------
// フォルダサイドバー
// ---------------------------------------------------------------------------

async function loadFolders() {
  const data = await fetchJson('/api/library/folders');
  currentFolders = Array.isArray(data.folders) ? data.folders : [];
  renderFolders(currentFolders);
}

async function assignToFolder(sourceId, targetFolderId) {
  const ids = selectedIds.has(sourceId) && selectedIds.size > 0
    ? [...selectedIds]
    : [sourceId];
  for (const id of ids) {
    await fetch(`/api/library/images/${id}/folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: targetFolderId }),
    });
  }
  clearSelection();
  await loadFolders();
  await loadImages();
}

async function reorderFolders(fromId, toId, insertAfter = false) {
  const fromEl = folderListEl.querySelector(`.library-folder-item[data-folder-id="${fromId}"]`);
  if (!fromEl) return;
  const parentId = fromEl.dataset.parentId ?? '';
  const items = Array.from(folderListEl.querySelectorAll(
    `.library-folder-item[data-folder-id][data-parent-id="${parentId}"]`
  ));
  const ids = items.map(el => Number(el.dataset.folderId));
  const fromIdx = ids.indexOf(fromId);
  const toIdx = ids.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return;
  ids.splice(fromIdx, 1);
  const insertIdx = ids.indexOf(toId);
  ids.splice(insertAfter ? insertIdx + 1 : insertIdx, 0, fromId);
  await fetch('/api/library/folders/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  await loadFolders();
}

async function nestFolder(folderId, newParentId) {
  await fetch(`/api/library/folders/${folderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent_id: newParentId }),
  }).catch(() => {});
  if (newParentId != null) {
    expandedFolderIds.add(newParentId);
    saveExpandedState();
  }
  await loadFolders();
}

function makeFolderDropTarget(el, targetFolderId) {
  el.addEventListener('dragover', e => {
    if (isFolderRenaming) return;
    if (folderDraggedId !== null) {
      if (folderDraggedId === targetFolderId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.remove('is-drop-target', 'is-drop-inside', 'is-drop-before', 'is-drop-after');
      if (targetFolderId === null) {
        el.classList.add('is-drop-target');
        return;
      }
      const rect = el.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / rect.height;
      const fromEl = folderListEl.querySelector(`.library-folder-item[data-folder-id="${folderDraggedId}"]`);
      const sameLevel = fromEl && (fromEl.dataset.parentId ?? '') === (el.dataset.parentId ?? '');
      if (sameLevel && relY < 0.3) {
        el.classList.add('is-drop-before');
      } else if (sameLevel && relY > 0.7) {
        el.classList.add('is-drop-after');
      } else {
        el.classList.add('is-drop-inside');
      }
      return;
    }
    if (!draggedId) return;
    e.preventDefault();
    el.classList.add('is-drop-target');
    e.dataTransfer.dropEffect = 'move';
  });
  el.addEventListener('dragleave', () => {
    el.classList.remove('is-drop-target', 'is-drop-inside', 'is-drop-before', 'is-drop-after');
  });
  el.addEventListener('drop', async e => {
    if (isFolderRenaming) return;
    e.preventDefault();
    el.classList.remove('is-drop-target', 'is-drop-inside', 'is-drop-before', 'is-drop-after');
    if (folderDraggedId !== null) {
      const fromId = folderDraggedId;
      folderDraggedId = null;
      if (fromId === targetFolderId) return;
      if (targetFolderId === null) {
        await nestFolder(fromId, null);
        return;
      }
      const rect = el.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / rect.height;
      const fromEl = folderListEl.querySelector(`.library-folder-item[data-folder-id="${fromId}"]`);
      const sameLevel = fromEl && (fromEl.dataset.parentId ?? '') === (el.dataset.parentId ?? '');
      if (sameLevel && relY < 0.3) {
        await reorderFolders(fromId, targetFolderId, false);
      } else if (sameLevel && relY > 0.7) {
        await reorderFolders(fromId, targetFolderId, true);
      } else {
        await nestFolder(fromId, targetFolderId);
      }
      return;
    }
    if (!draggedId) return;
    const sourceId = draggedId;
    draggedId = null;
    await assignToFolder(sourceId, targetFolderId);
  });
}

function startFolderRename(itemEl, folder) {
  if (isFolderRenaming) return;
  isFolderRenaming = true;
  itemEl.draggable = false;
  resetDragState();

  const nameEl = itemEl.querySelector('.library-folder-name');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'library-folder-name-input';
  input.value = folder.name;
  input.draggable = false;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    try {
      const newName = input.value.trim();
      if (newName && newName !== folder.name) {
        await fetch(`/api/library/folders/${folder.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
      }
    } finally {
      isFolderRenaming = false;
      await loadFolders();
    }
  }

  input.addEventListener('blur', commit);
  input.addEventListener('dragstart', e => e.preventDefault());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      committed = true;
      isFolderRenaming = false;
      loadFolders();
    }
  });
}

function startSubfolderCreate(parentFolderId, parentDepth) {
  if (folderListEl.querySelector('.library-folder-creating')) return;
  expandedFolderIds.add(parentFolderId);
  saveExpandedState();
  renderFolders(currentFolders);

  const parentItem = folderListEl.querySelector(`.library-folder-item[data-folder-id="${parentFolderId}"]`);
  if (!parentItem) return;
  const depth = parentDepth + 1;

  const item = document.createElement('div');
  item.className = 'library-folder-item library-folder-creating';
  item.style.paddingLeft = `${6 + depth * 14}px`;
  item.innerHTML = `
    <span class="library-folder-toggle is-leaf"></span>
    <span class="library-folder-icon">&#128193;</span>
    <input type="text" class="library-folder-name-input" placeholder="フォルダ名">
  `;

  let insertAfter = parentItem;
  let next = parentItem.nextElementSibling;
  while (next && next.classList.contains('library-folder-item')) {
    const nextDepth = parseInt(next.dataset.depth ?? '0', 10);
    if (nextDepth > parentDepth) {
      insertAfter = next;
      next = next.nextElementSibling;
    } else {
      break;
    }
  }
  insertAfter.insertAdjacentElement('afterend', item);

  const input = item.querySelector('input');
  input.focus();

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const name = input.value.trim();
    item.remove();
    if (!name) return;
    await fetch('/api/library/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id: parentFolderId }),
    });
    await loadFolders();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { committed = true; item.remove(); }
  });
}

// ---------------------------------------------------------------------------
// フォルダコンテキストメニュー
// ---------------------------------------------------------------------------

const folderMenuEl = document.createElement('div');
folderMenuEl.className = 'library-folder-menu';
folderMenuEl.innerHTML = `
  <button class="library-folder-menu-item" data-menu-action="rename">名前を編集</button>
  <button class="library-folder-menu-item" data-menu-action="add-child">子フォルダを作成</button>
  <div class="library-folder-menu-divider"></div>
  <button class="library-folder-menu-item is-danger" data-menu-action="delete">削除</button>
`;
document.body.appendChild(folderMenuEl);

let _menuNode = null;
let _menuDepth = 0;
let _menuItemEl = null;

function openFolderMenu(btnEl, node, depth, itemEl) {
  _menuNode = node;
  _menuDepth = depth;
  _menuItemEl = itemEl;
  folderMenuEl.classList.add('is-open');

  const rect = btnEl.getBoundingClientRect();
  const mw = 160;
  let left = rect.right + 4;
  if (left + mw > window.innerWidth) left = rect.left - mw - 4;
  let top = rect.top;
  if (top + 120 > window.innerHeight) top = rect.bottom - 120;
  folderMenuEl.style.left = `${left}px`;
  folderMenuEl.style.top = `${top}px`;
}

function closeFolderMenu() {
  folderMenuEl.classList.remove('is-open');
  _menuNode = null;
  _menuDepth = 0;
  _menuItemEl = null;
}

folderMenuEl.addEventListener('click', async e => {
  const btn = e.target.closest('[data-menu-action]');
  if (!btn || !_menuNode) return;
  const action = btn.dataset.menuAction;
  const node = _menuNode;
  const depth = _menuDepth;
  const itemEl = _menuItemEl;
  closeFolderMenu();

  if (action === 'rename') {
    startFolderRename(itemEl, node);
  } else if (action === 'add-child') {
    startSubfolderCreate(node.id, depth);
  } else if (action === 'delete') {
    if (!confirm(`フォルダ「${node.name}」を削除しますか？\n（サブフォルダは親へ移動し、画像はフォルダから外れます）`)) return;
    await fetch(`/api/library/folders/${node.id}`, { method: 'DELETE' });
    if (currentFolderId === node.id) currentFolderId = 0;
    await loadFolders();
    await loadImages();
  }
});

document.addEventListener('pointerdown', e => {
  if (folderMenuEl.classList.contains('is-open') && !folderMenuEl.contains(e.target)) closeFolderMenu();
});

function buildFolderTree(folders) {
  const map = Object.create(null);
  for (const f of folders) map[f.id] = { ...f, children: [] };
  const roots = [];
  for (const f of folders) {
    if (f.parent_id != null && map[f.parent_id]) {
      map[f.parent_id].children.push(map[f.id]);
    } else {
      roots.push(map[f.id]);
    }
  }
  return roots;
}

function renderFolderTree(nodes, depth) {
  for (const node of nodes) {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedFolderIds.has(node.id);

    const item = document.createElement('div');
    item.className = 'library-folder-item' + (currentFolderId === node.id ? ' is-active' : '');
    item.dataset.folderId = String(node.id);
    item.dataset.depth = String(depth);
    item.dataset.parentId = node.parent_id != null ? String(node.parent_id) : '';
    item.draggable = true;
    item.style.paddingLeft = `${6 + depth * 14}px`;
    item.innerHTML = `
      <span class="library-folder-toggle${hasChildren ? '' : ' is-leaf'}" data-action="toggle">${hasChildren ? (isExpanded ? '&#9660;' : '&#9654;') : ''}</span>
      <span class="library-folder-icon">&#128193;</span>
      <span class="library-folder-name">${escapeHtml(node.name)}</span>
      <span class="library-folder-count">${node.image_count ?? 0}</span>
      <button class="library-folder-menu-btn" type="button" title="メニュー" data-action="menu">&#8230;</button>
    `;

    item.querySelector('[data-action="toggle"]').addEventListener('click', e => {
      e.stopPropagation();
      if (!hasChildren) return;
      if (expandedFolderIds.has(node.id)) {
        expandedFolderIds.delete(node.id);
      } else {
        expandedFolderIds.add(node.id);
      }
      saveExpandedState();
      renderFolders(currentFolders);
    });

    item.addEventListener('click', e => {
      if (e.target.closest('input, button')) return;
      currentFolderId = node.id;
      renderFolders(currentFolders);
      void loadImages();
    });

    item.querySelector('.library-folder-name').addEventListener('dblclick', e => {
      e.stopPropagation();
      startFolderRename(item, node);
    });

    item.querySelector('[data-action="menu"]').addEventListener('click', e => {
      e.stopPropagation();
      openFolderMenu(e.currentTarget, node, depth, item);
    });

    item.addEventListener('dragstart', e => {
      if (isFolderRenaming || e.target.closest('input, button')) { e.preventDefault(); return; }
      folderDraggedId = node.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
      item.classList.add('is-dragging');
    });
    item.addEventListener('dragend', () => {
      folderDraggedId = null;
      item.classList.remove('is-dragging');
      folderListEl.querySelectorAll('.library-folder-item.is-drop-target, .library-folder-item.is-drop-inside, .library-folder-item.is-drop-before, .library-folder-item.is-drop-after')
        .forEach(el => el.classList.remove('is-drop-target', 'is-drop-inside', 'is-drop-before', 'is-drop-after'));
    });

    makeFolderDropTarget(item, node.id);
    folderListEl.appendChild(item);

    if (hasChildren && isExpanded) {
      renderFolderTree(node.children, depth + 1);
    }
  }
}

function renderFolders(folders) {
  closeFolderMenu();
  currentFolders = folders;
  folderAllBtn.classList.toggle('is-active', currentFolderId === 0);
  folderListEl.innerHTML = '';
  renderFolderTree(buildFolderTree(folders), 0);
}

folderAllBtn.addEventListener('click', () => {
  currentFolderId = 0;
  folderAllBtn.classList.add('is-active');
  folderListEl.querySelectorAll('.library-folder-item').forEach(el => el.classList.remove('is-active'));
  void loadImages();
});
makeFolderDropTarget(folderAllBtn, null); // null = folder_id を NULL に設定（ルートへ戻す）

document.getElementById('library-folder-add-btn').addEventListener('click', () => {
  if (folderListEl.querySelector('.library-folder-creating')) return;
  const item = document.createElement('div');
  item.className = 'library-folder-item library-folder-creating';
  item.innerHTML = `
    <span class="library-folder-toggle is-leaf"></span>
    <span class="library-folder-icon">&#128193;</span>
    <input type="text" class="library-folder-name-input" placeholder="フォルダ名">
  `;
  folderListEl.prepend(item);
  const input = item.querySelector('input');
  input.focus();

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const name = input.value.trim();
    item.remove();
    if (!name) return;
    await fetch('/api/library/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await loadFolders();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { committed = true; item.remove(); }
  });
});

// ---------------------------------------------------------------------------
// 画像登録
// ---------------------------------------------------------------------------

async function registerFiles(files) {
  const imageFiles = files.filter(file => file.type.startsWith('image/'));
  if (!imageFiles.length) {
    setStatus('画像ファイルをドロップしてください', true);
    return;
  }
  setStatus(`${imageFiles.length} 件を登録中...`);
  const newIds = [];
  for (const file of imageFiles) {
    const form = new FormData();
    form.append('file', file);
    const filePath = window.electronAPI?.getPathForFile?.(file) || '';
    if (filePath) form.append('image_path', filePath);
    const resp = await fetch('/api/library/images', { method: 'POST', body: form });
    if (!resp.ok) {
      const err = await resp.text();
      setStatus(`${file.name}: ${err}`, true);
      continue;
    }
    const data = await resp.json();
    if (data?.image?.id != null) {
      newIds.push(data.image.id);
      if (currentFolderId !== null && currentFolderId !== 0) {
        await fetch(`/api/library/images/${data.image.id}/folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_id: currentFolderId }),
        });
      }
    }
  }
  setStatus('登録しました');
  await loadFolders();
  await loadImages().catch(err => setStatus(String(err), true));
  if (newIds.length) {
    const card = gridEl.querySelector(`.library-card[data-id="${newIds[0]}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      sentinelEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }
}

function setDropActive(active) {
  dropOverlay.classList.toggle('is-active', active);
}

function isFileDrag(event) {
  if (isReorderDrag) return false;
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

async function saveOrder() {
  const ids = images.map(item => item.id);
  const resp = await fetch('/api/library/images/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!resp.ok) {
    setStatus(await resp.text(), true);
    await loadImages();
    return;
  }
  setStatus('並び順を保存しました');
}

function reorderLocal(dragId, targetId) {
  if (!dragId || !targetId || dragId === targetId) return false;
  const from = images.findIndex(item => Number(item.id) === Number(dragId));
  const to = images.findIndex(item => Number(item.id) === Number(targetId));
  if (from < 0 || to < 0) return false;
  const [item] = images.splice(from, 1);
  images.splice(to, 0, item);
  render();
  return true;
}

async function deleteImage(id) {
  if (!window.confirm('この画像をライブラリから削除しますか？')) return;
  await fetch(`/api/library/images/${id}`, { method: 'DELETE' });
  selectedIds.delete(id);
  updateSelectionUI();
  const savedScroll = scrollAreaEl.scrollTop;
  await Promise.all([loadFolders(), loadImages()]);
  while (hasMore && !isLoading &&
         scrollAreaEl.scrollHeight - scrollAreaEl.clientHeight < savedScroll) {
    await loadMore();
  }
  scrollAreaEl.scrollTop = savedScroll;
}

function openDetail(id) {
  currentDetailId = id;
  detailFrame.src = `/frontend/image-library-detail.html?id=${encodeURIComponent(id)}&embedded=1`;
  if (!detailModal.classList.contains('is-open')) {
    detailModal.classList.add('is-open');
    detailModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('library-modal-open');
  }
  _updateNavButtons();
}

function _updateNavButtons() {
  const idx = images.findIndex(img => img.id === currentDetailId);
  if (detailPrevBtn) detailPrevBtn.disabled = idx <= 0;
  if (detailNextBtn) detailNextBtn.disabled = idx === -1 || (idx >= images.length - 1 && !hasMore);
  if (detailNavIndex) {
    detailNavIndex.textContent = idx >= 0 ? `(${idx + 1} / ${hasMore ? totalCount : images.length})` : '';
  }
}

async function navigateDetail(direction) {
  if (currentDetailId === null) return;
  const idx = images.findIndex(img => img.id === currentDetailId);
  if (idx === -1) return;

  if (direction === 'prev' && idx > 0) {
    openDetail(images[idx - 1].id);
  } else if (direction === 'next') {
    if (idx < images.length - 1) {
      openDetail(images[idx + 1].id);
    } else if (hasMore) {
      await loadMore();
      const newIdx = images.findIndex(img => img.id === currentDetailId);
      if (newIdx !== -1 && newIdx < images.length - 1) {
        openDetail(images[newIdx + 1].id);
      }
    }
  }
}

async function closeDetail() {
  if (!detailModal.classList.contains('is-open')) return;
  currentDetailId = null;
  detailModal.classList.remove('is-open');
  detailModal.setAttribute('aria-hidden', 'true');
  detailFrame.removeAttribute('src');
  document.body.classList.remove('library-modal-open');
  const savedScroll = scrollAreaEl.scrollTop;
  await Promise.all([loadImages(), loadCaptionPrompts()]);
  while (hasMore && !isLoading &&
         scrollAreaEl.scrollHeight - scrollAreaEl.clientHeight < savedScroll) {
    await loadMore();
  }
  scrollAreaEl.scrollTop = savedScroll;
}

// ---------------------------------------------------------------------------
// イベントハンドラ
// ---------------------------------------------------------------------------

document.getElementById('library-add-btn').addEventListener('click', () => fileInput.click());
document.getElementById('library-refresh-btn').addEventListener('click', loadImages);
detailCloseBtn.addEventListener('click', closeDetail);
detailPrevBtn?.addEventListener('click', () => navigateDetail('prev'));
detailNextBtn?.addEventListener('click', () => navigateDetail('next'));

detailModal.addEventListener('click', event => {
  if (event.target === detailModal) void closeDetail();
});

document.addEventListener('keydown', event => {
  if (detailModal.classList.contains('is-open')) {
    if (event.key === 'Escape') { void closeDetail(); return; }
    if (event.key === 'ArrowLeft')  { void navigateDetail('prev'); return; }
    if (event.key === 'ArrowRight') { void navigateDetail('next'); return; }
  } else if (event.key === 'Escape') {
    if (folderMenuEl.classList.contains('is-open')) { closeFolderMenu(); return; }
    if (selectedIds.size > 0) clearSelection();
  }
});

document.addEventListener('dragstart', event => {
  if (!isFolderRenaming) return;
  event.preventDefault();
}, true);

fileInput.addEventListener('change', async () => {
  await registerFiles(Array.from(fileInput.files || []));
  fileInput.value = '';
});

document.addEventListener('dragenter', event => {
  if (isFolderRenaming) return;
  if (!isFileDrag(event)) return;
  dragDepth += 1;
  setDropActive(true);
});

document.addEventListener('dragover', event => {
  if (isFolderRenaming) return;
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  setDropActive(true);
});

document.addEventListener('dragleave', event => {
  if (isFolderRenaming) return;
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDropActive(false);
});

document.addEventListener('drop', async event => {
  if (isFolderRenaming) return;
  if (!isFileDrag(event) || !event.dataTransfer?.files?.length) return;
  event.preventDefault();
  dragDepth = 0;
  setDropActive(false);
  await registerFiles(Array.from(event.dataTransfer.files));
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  if (!searchInput.value.trim()) {
    committedSearchQuery = '';
    sortSelect.disabled = false;
  }
});

searchInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  clearTimeout(searchTimer);
  committedSearchQuery = searchInput.value.trim();
  loadImages();
});

if (searchModeSelect) {
  const savedSearchMode = localStorage.getItem(SEARCH_MODE_KEY);
  if (savedSearchMode && [...searchModeSelect.options].some(opt => opt.value === savedSearchMode)) {
    searchModeSelect.value = savedSearchMode;
  }
  searchModeSelect.addEventListener('change', () => {
    localStorage.setItem(SEARCH_MODE_KEY, searchModeSelect.value);
  });
}

sortSelect.addEventListener('change', loadImages);

gridEl.addEventListener('click', event => {
  const card = event.target.closest('.library-card');
  if (!card) return;
  const button = event.target.closest('[data-action]');
  const action = button?.dataset.action;
  const id = Number(card.dataset.id);

  if (action === 'select') {
    if (event.shiftKey && lastClickedId !== null) {
      rangeSelect(lastClickedId, id);
    } else {
      toggleSelection(id);
    }
    return;
  }
  if (action === 'delete') { deleteImage(id); return; }

  if (event.ctrlKey || event.metaKey) { toggleSelection(id); return; }
  openDetail(id);
});

gridEl.addEventListener('dragstart', event => {
  if (isFolderRenaming) { event.preventDefault(); return; }
  const card = event.target.closest('.library-card');
  if (!card) { event.preventDefault(); return; }
  const isCustom = sortSelect.value === 'custom' && !committedSearchQuery;
  draggedId = Number(card.dataset.id);
  isReorderDrag = isCustom;
  dragDepth = 0;
  setDropActive(false);
  card.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(draggedId));

  // 複数選択ドラッグ時はカスタムドラッグ画像でカウントを表示
  const dragCount = selectedIds.has(draggedId) ? selectedIds.size : 1;
  if (dragCount > 1) {
    const ghost = document.createElement('div');
    ghost.style.cssText = `
      position:fixed; top:-100px; left:-100px;
      background:#38bdf8; color:#000; font-weight:700;
      padding:4px 10px; border-radius:20px; font-size:13px;
      pointer-events:none;
    `;
    ghost.textContent = `${dragCount}枚`;
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, 20, 16);
    requestAnimationFrame(() => ghost.remove());
  }
});

gridEl.addEventListener('dragover', event => {
  if (!draggedId || !isReorderDrag) return;
  const card = event.target.closest('.library-card');
  if (!card || Number(card.dataset.id) === draggedId) return;
  event.preventDefault();
  card.classList.add('is-drop-target');
  event.dataTransfer.dropEffect = 'move';
});

gridEl.addEventListener('dragleave', event => {
  if (!isReorderDrag) return;
  const card = event.target.closest('.library-card');
  if (card) card.classList.remove('is-drop-target');
});

gridEl.addEventListener('drop', async event => {
  if (!draggedId || !isReorderDrag) return;
  const card = event.target.closest('.library-card');
  if (!card) return;
  event.preventDefault();
  const targetId = Number(card.dataset.id);
  document.querySelectorAll('.library-card.is-drop-target').forEach(el => {
    el.classList.remove('is-drop-target');
  });
  if (reorderLocal(draggedId, targetId)) {
    await saveOrder();
  }
  draggedId = null;
});

function resetDragState() {
  draggedId = null;
  isReorderDrag = false;
  dragDepth = 0;
  setDropActive(false);
  document.querySelectorAll('.library-card.is-dragging, .library-card.is-drop-target').forEach(el => {
    el.classList.remove('is-dragging', 'is-drop-target');
  });
  document.querySelectorAll('.library-folder-item.is-drop-target, .library-folder-item.is-drop-inside, .library-folder-item.is-drop-before, .library-folder-item.is-drop-after').forEach(el => {
    el.classList.remove('is-drop-target', 'is-drop-inside', 'is-drop-before', 'is-drop-after');
  });
}

gridEl.addEventListener('dragend', resetDragState);
document.addEventListener('dragend', resetDragState);

// ---------------------------------------------------------------------------
// キャプションプロンプト読み込み
// ---------------------------------------------------------------------------

async function loadCaptionPrompts() {
  const data = await fetchJson('/api/library/caption_prompts');
  const prompts = Array.isArray(data.prompts) ? data.prompts : [];
  const sel = document.getElementById('batch-caption-prompt');
  if (!sel) return;
  sel.innerHTML = prompts.map(p =>
    `<option value="${p.id}">${p.name || p.id}</option>`
  ).join('');
}

// ---------------------------------------------------------------------------
// 一括Caption生成
// ---------------------------------------------------------------------------

async function startBatchCaption() {
  const sel = document.getElementById('batch-caption-prompt');
  const skipEl = document.getElementById('batch-skip-existing');
  const reindexAfterEl = document.getElementById('batch-reindex-after');
  const startBtn = document.getElementById('batch-caption-btn');
  const reindexBtn = document.getElementById('batch-reindex-btn');
  const stopBtn = document.getElementById('batch-caption-stop-btn');
  const progressEl = document.getElementById('batch-caption-progress');
  const startedAt = Date.now();

  function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function elapsedLabel() {
    return `経過 ${formatElapsed(Date.now() - startedAt)}`;
  }

  startBtn.disabled = true;
  if (reindexBtn) reindexBtn.disabled = true;
  stopBtn.disabled = false;
  setBatchPanelOpen(true);
  setBatchProgress(progressEl, `準備中... / ${elapsedLabel()}`);

  batchAbortCtrl = new AbortController();

  try {
    const resp = await fetch('/api/library/batch_caption/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caption_prompt_id: sel?.value || 'visual',
        skip_existing: skipEl?.checked ?? true,
        reindex_after: reindexAfterEl?.checked ?? false,
      }),
      signal: batchAbortCtrl.signal,
    });

    if (!resp.ok) {
      const err = await resp.text();
      setStatus(`エラー: ${err}`, true);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'progress') {
            const total = Number(event.total) || 0;
            const current = Number(event.current) || 0;
            const percent = total > 0 ? Math.round((current / total) * 100) : 0;
            setBatchProgress(progressEl, `Caption ${current} / ${total} (${percent}%) / ${elapsedLabel()}  ${event.filename}`);
          } else if (event.type === 'reindex_progress') {
            const total = Number(event.total) || 0;
            const current = Number(event.current) || 0;
            const percent = total > 0 ? Math.round((current / total) * 100) : 0;
            setBatchProgress(progressEl, `再インデックス ${current} / ${total} (${percent}%) / ${elapsedLabel()}  ${event.filename}`);
          } else if (event.type === 'item_error') {
            setStatus(`${event.filename}: ${event.content}`, true);
          } else if (event.type === 'done') {
            setBatchProgress(progressEl, `完了: ${event.count} 件 / ${elapsedLabel()}`);
            await loadImages();
          } else if (event.type === 'error') {
            setStatus(`エラー: ${event.content}`, true);
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') setStatus(`エラー: ${e}`, true);
    else setBatchProgress(progressEl, `停止しました / ${elapsedLabel()}`);
  } finally {
    batchAbortCtrl = null;
    startBtn.disabled = false;
    if (reindexBtn) reindexBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

async function startBatchReindex() {
  const startBtn = document.getElementById('batch-caption-btn');
  const reindexBtn = document.getElementById('batch-reindex-btn');
  const stopBtn = document.getElementById('batch-caption-stop-btn');
  const progressEl = document.getElementById('batch-caption-progress');
  const startedAt = Date.now();

  function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function elapsedLabel() {
    return `経過 ${formatElapsed(Date.now() - startedAt)}`;
  }

  if (startBtn) startBtn.disabled = true;
  if (reindexBtn) reindexBtn.disabled = true;
  stopBtn.disabled = false;
  setBatchPanelOpen(true);
  setBatchProgress(progressEl, `再インデックス準備中... / ${elapsedLabel()}`);

  batchAbortCtrl = new AbortController();

  try {
    const resp = await fetch('/api/library/batch_reindex/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ only_missing: false }),
      signal: batchAbortCtrl.signal,
    });

    if (!resp.ok) {
      const err = await resp.text();
      setStatus(`エラー: ${err}`, true);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'progress') {
            const total = Number(event.total) || 0;
            const current = Number(event.current) || 0;
            const percent = total > 0 ? Math.round((current / total) * 100) : 0;
            setBatchProgress(progressEl, `再インデックス ${current} / ${total} (${percent}%) / ${elapsedLabel()}  ${event.filename}`);
          } else if (event.type === 'item_error') {
            setStatus(`${event.filename}: ${event.content}`, true);
          } else if (event.type === 'done') {
            setBatchProgress(progressEl, `再インデックス完了: ${event.count} 件 / ${elapsedLabel()}`);
            await loadImages();
          } else if (event.type === 'error') {
            setStatus(`エラー: ${event.content}`, true);
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') setStatus(`エラー: ${e}`, true);
    else setBatchProgress(progressEl, `停止しました / ${elapsedLabel()}`);
  } finally {
    batchAbortCtrl = null;
    if (startBtn) startBtn.disabled = false;
    if (reindexBtn) reindexBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

document.getElementById('batch-caption-btn').addEventListener('click', startBatchCaption);
document.getElementById('batch-reindex-btn').addEventListener('click', startBatchReindex);
document.getElementById('batch-caption-stop-btn').addEventListener('click', () => {
  batchAbortCtrl?.abort();
});

// ---------------------------------------------------------------------------
// ルートフォルダ
// ---------------------------------------------------------------------------

const rootInput = document.getElementById('library-root-input');
const rootBrowseBtn = document.getElementById('library-root-browse-btn');
const rootApplyBtn = document.getElementById('library-root-apply-btn');
const rootResetBtn = document.getElementById('library-root-reset-btn');
const rootCurrentEl = document.getElementById('library-root-current');

let currentRootInfo = null;

function renderRootInfo(info) {
  if (!info) return;
  currentRootInfo = info;
  if (rootInput && document.activeElement !== rootInput) {
    rootInput.value = info.configured || '';
  }
  if (rootCurrentEl) {
    const suffix = info.is_default ? '（既定）' : '';
    const missing = info.exists ? '' : ' — フォルダが存在しないため作成されます';
    rootCurrentEl.textContent = `現在のルート: ${info.root}${suffix}${missing}`;
  }
}

async function loadRootInfo() {
  try {
    renderRootInfo(await fetchJson('/api/library/root'));
  } catch (_) {}
}

async function applyRoot(path) {
  const prevLabel = rootApplyBtn.textContent;
  rootApplyBtn.disabled = true;
  rootResetBtn.disabled = true;
  rootApplyBtn.textContent = '適用中...';
  try {
    const info = await fetchJson('/api/library/root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    renderRootInfo(info);
    setStatus(`ルートフォルダを変更しました: ${info.root}`);
    currentFolderId = 0;
    folderAllBtn.classList.add('is-active');
    await loadFolders().catch(() => {});
    await loadImages();
  } catch (err) {
    setStatus(String(err), true);
  } finally {
    rootApplyBtn.disabled = false;
    rootResetBtn.disabled = false;
    rootApplyBtn.textContent = prevLabel;
  }
}

// iframe 内では preload の electronAPI が入らないため、親フレームからも探す
function getElectronAPI() {
  try {
    return window.electronAPI
      || (window.parent && window.parent.electronAPI)
      || (window.top && window.top.electronAPI)
      || null;
  } catch (_) {
    return null;
  }
}

async function browseRoot() {
  const api = getElectronAPI();
  if (!api?.selectFolder) {
    setStatus('フォルダ選択はデスクトップアプリでのみ利用できます。パスを直接入力してください。', true);
    rootInput?.focus();
    return;
  }
  const picked = await api.selectFolder(currentRootInfo?.root || '');
  if (!picked) return;
  rootInput.value = picked;
  applyRoot(picked);
}

if (rootBrowseBtn) {
  if (getElectronAPI()?.selectFolder) {
    rootBrowseBtn.addEventListener('click', browseRoot);
  } else {
    rootBrowseBtn.hidden = true;
  }
}
rootApplyBtn?.addEventListener('click', () => applyRoot(rootInput.value.trim()));
rootResetBtn?.addEventListener('click', () => {
  rootInput.value = '';
  applyRoot('');
});
rootInput?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyRoot(rootInput.value.trim());
  }
});

initBatchPanel();
initSidebarResize();
loadRootInfo();
loadImages().catch(err => setStatus(String(err), true));
loadFolders().catch(() => {});
loadCaptionPrompts().catch(() => {});
