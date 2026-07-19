'use strict';

const fileListEl = document.getElementById('snippet-file-list');
const entryListEl = document.getElementById('snippet-entry-list');
const currentFileEl = document.getElementById('snippet-current-file');
const currentMetaEl = document.getElementById('snippet-current-meta');
const statusEl = document.getElementById('snippet-status');

const nameInput = document.getElementById('snippet-entry-name');
const prefixInput = document.getElementById('snippet-entry-prefix');
const descriptionInput = document.getElementById('snippet-entry-description');
const bodyInput = document.getElementById('snippet-entry-body');

const refreshBtn = document.getElementById('snippet-refresh-btn');
const createFileBtn = document.getElementById('snippet-create-file-btn');
const saveFileBtn = document.getElementById('snippet-save-file-btn');
const addEntryBtn = document.getElementById('snippet-add-entry-btn');
const entrySearchInput = document.getElementById('snippet-entry-search');

const newFileNameInput = document.getElementById('snippet-new-file-name');

const rootInput = document.getElementById('snippet-root-input');
const rootBrowseBtn = document.getElementById('snippet-root-browse-btn');
const rootApplyBtn = document.getElementById('snippet-root-apply-btn');
const rootResetBtn = document.getElementById('snippet-root-reset-btn');
const rootCurrentEl = document.getElementById('snippet-root-current');

let currentRootInfo = null;

let files = [];
let currentPath = '';
let currentSnippets = [];
let activeSnippetIndex = -1;
let allSnippets = [];

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function setStatus(message, isError = false) {
  statusEl.textContent = message || '';
  statusEl.style.color = isError ? 'var(--danger)' : '';
}

function updateFormDisabled(disabled) {
  [nameInput, prefixInput, descriptionInput, bodyInput, saveFileBtn, addEntryBtn]
    .forEach(el => { el.disabled = disabled; });
}

function trashIcon() {
  return `
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 6h18"></path>
      <path d="M8 6V4h8v2"></path>
      <path d="M6 6l1 15h10l1-15"></path>
      <path d="M10 11v6"></path>
      <path d="M14 11v6"></path>
    </svg>
  `;
}

function renderFiles() {
  fileListEl.innerHTML = files.map(file => `
    <div class="snippet-file-item${file.path === currentPath ? ' is-active' : ''}">
      <button type="button" class="snippet-item-main" data-path="${file.path}">
        <div class="snippet-file-path">${file.path}</div>
        <div class="snippet-file-meta">${file.count} entries</div>
      </button>
      <button type="button" class="snippet-trash-btn" data-path="${file.path}" aria-label="${file.path} を削除" title="削除">
        ${trashIcon()}
      </button>
    </div>
  `).join('');

  fileListEl.querySelectorAll('.snippet-item-main').forEach(button => {
    button.addEventListener('click', () => loadFile(button.dataset.path));
  });
  fileListEl.querySelectorAll('.snippet-trash-btn').forEach(button => {
    button.addEventListener('click', () => deleteFile(button.dataset.path));
  });
}

function renderEntries() {
  const query = normalizeText(entrySearchInput?.value);
  const isGlobalSearch = Boolean(query);
  const visibleEntries = isGlobalSearch
    ? allSnippets
      .filter(item => [item.name, item.prefix, item.description, item.body, item.source]
        .some(value => normalizeText(value).includes(query)))
      .slice(0, 200)
      .map(item => ({ item, index: -1 }))
    : currentSnippets.map((item, index) => ({ item, index }));

  entryListEl.innerHTML = visibleEntries.map(({ item, index }) => `
    <div class="snippet-entry-item${!isGlobalSearch && index === activeSnippetIndex ? ' is-active' : ''}">
      <button
        type="button"
        class="snippet-item-main"
        data-index="${index}"
        data-source="${item.source || ''}"
        data-name="${item.name || ''}"
        data-prefix="${item.prefix || ''}"
      >
        <div class="snippet-entry-name">${item.name || item.prefix || `entry_${index + 1}`}</div>
        <div class="snippet-entry-meta">${isGlobalSearch ? `${item.source} / ${item.prefix || '(prefixなし)'}` : (item.description || item.prefix || '')}</div>
      </button>
      <button
        type="button"
        class="snippet-trash-btn"
        data-index="${index}"
        data-source="${item.source || ''}"
        data-name="${item.name || ''}"
        data-prefix="${item.prefix || ''}"
        aria-label="項目を削除"
        title="削除"
      >
        ${trashIcon()}
      </button>
    </div>
  `).join('');

  entryListEl.querySelectorAll('.snippet-item-main').forEach(button => {
    button.addEventListener('click', async () => {
      if (isGlobalSearch) {
        await openSearchResult(button.dataset.source, button.dataset.name, button.dataset.prefix);
        return;
      }
      selectEntry(Number(button.dataset.index));
    });
  });
  entryListEl.querySelectorAll('.snippet-trash-btn').forEach(button => {
    button.addEventListener('click', async () => {
      if (isGlobalSearch) {
        await deleteSearchResult(button.dataset.source, button.dataset.name, button.dataset.prefix);
        return;
      }
      deleteEntryAt(Number(button.dataset.index));
    });
  });
}

async function openSearchResult(source, name, prefix) {
  if (!source) return;
  await loadFile(source);
  const targetIndex = currentSnippets.findIndex(item => (
    (item.name || '') === (name || '')
    && (item.prefix || '') === (prefix || '')
  ));
  if (targetIndex >= 0) {
    selectEntry(targetIndex);
  }
}

async function deleteSearchResult(source, name, prefix) {
  if (!source) return;
  if (!window.confirm(`${source} の項目を削除しますか？`)) return;

  const resp = await fetch(`/api/snippet_file?path=${encodeURIComponent(source)}`);
  if (!resp.ok) {
    const error = await resp.text();
    setStatus(error || '項目の読み込みに失敗しました', true);
    return;
  }
  const data = await resp.json();
  const snippets = Array.isArray(data.snippets) ? data.snippets : [];
  const targetIndex = snippets.findIndex(item => (
    (item.name || '') === (name || '')
    && (item.prefix || '') === (prefix || '')
  ));
  if (targetIndex < 0) return;
  snippets.splice(targetIndex, 1);

  const saveResp = await fetch('/api/snippet_file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: source, snippets }),
  });
  if (!saveResp.ok) {
    const error = await saveResp.text();
    setStatus(error || '項目削除に失敗しました', true);
    return;
  }

  if (source === currentPath) {
    await loadFile(currentPath);
  }
  setStatus('項目を削除しました');
  await loadFiles(currentPath);
}

function syncActiveSnippetFromForm() {
  if (activeSnippetIndex < 0 || !currentSnippets[activeSnippetIndex]) return;
  currentSnippets[activeSnippetIndex] = {
    name: nameInput.value,
    prefix: prefixInput.value,
    description: descriptionInput.value,
    body: bodyInput.value,
  };
  renderEntries();
}

function bindForm() {
  [nameInput, prefixInput, descriptionInput, bodyInput].forEach(input => {
    input.addEventListener('input', syncActiveSnippetFromForm);
  });
}

function selectEntry(index) {
  activeSnippetIndex = index;
  const item = currentSnippets[index];
  if (!item) {
    nameInput.value = '';
    prefixInput.value = '';
    descriptionInput.value = '';
    bodyInput.value = '';
    renderEntries();
    return;
  }
  nameInput.value = item.name || '';
  prefixInput.value = item.prefix || '';
  descriptionInput.value = item.description || '';
  bodyInput.value = item.body || '';
  renderEntries();
}

async function loadFiles(preferredPath = '') {
  const resp = await fetch('/api/snippet_files');
  const data = await resp.json();
  files = Array.isArray(data.files) ? data.files : [];
  const snippetsResp = await fetch('/api/snippets');
  const snippetsData = await snippetsResp.json();
  allSnippets = Array.isArray(snippetsData.snippets) ? snippetsData.snippets : [];
  renderFiles();
  renderEntries();
  if (preferredPath && files.some(file => file.path === preferredPath)) {
    await loadFile(preferredPath);
    return;
  }
  if (!currentPath && files[0]) {
    await loadFile(files[0].path);
  } else if (currentPath && files.some(file => file.path === currentPath)) {
    await loadFile(currentPath);
  } else if (!files.length) {
    currentPath = '';
    currentSnippets = [];
    activeSnippetIndex = -1;
    currentFileEl.textContent = 'ファイルを選択';
    currentMetaEl.textContent = '';
    renderEntries();
    updateFormDisabled(true);
  }
}

async function loadFile(path) {
  const resp = await fetch(`/api/snippet_file?path=${encodeURIComponent(path)}`);
  if (!resp.ok) {
    const error = await resp.text();
    setStatus(error || 'ファイルの読み込みに失敗しました', true);
    return;
  }
  const data = await resp.json();
  currentPath = data.path;
  currentSnippets = Array.isArray(data.snippets) ? data.snippets : [];
  currentFileEl.textContent = data.name || data.path;
  currentMetaEl.textContent = data.path;
  renderFiles();
  renderEntries();
  updateFormDisabled(false);
  if (currentSnippets.length > 0) {
    selectEntry(0);
  } else {
    selectEntry(-1);
  }
  setStatus('');
}

async function saveCurrentFile() {
  if (!currentPath) return;
  syncActiveSnippetFromForm();
  const resp = await fetch('/api/snippet_file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: currentPath,
      snippets: currentSnippets,
    }),
  });
  if (!resp.ok) {
    const error = await resp.text();
    setStatus(error || '保存に失敗しました', true);
    return;
  }
  setStatus('保存しました');
  await loadFiles(currentPath);
}

async function createFile() {
  const fileName = newFileNameInput.value.trim();
  if (!fileName) {
    setStatus('ファイル名を入力してください', true);
    return;
  }
  const resp = await fetch('/api/snippet_file/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_name: fileName,
    }),
  });
  if (!resp.ok) {
    const error = await resp.text();
    setStatus(error || 'ファイル作成に失敗しました', true);
    return;
  }
  const data = await resp.json();
  newFileNameInput.value = '';
  setStatus('ファイルを作成しました');
  await loadFiles(data.path);
}

async function deleteFile(path) {
  if (!path) return;
  if (!window.confirm(`${path} を削除しますか？`)) return;
  const resp = await fetch(`/api/snippet_file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
  if (!resp.ok) {
    const error = await resp.text();
    setStatus(error || 'ファイル削除に失敗しました', true);
    return;
  }
  if (path === currentPath) {
    currentPath = '';
  }
  setStatus('ファイルを削除しました');
  await loadFiles();
}

function addEntry() {
  currentSnippets.push({
    name: '',
    prefix: '',
    description: '',
    body: '',
  });
  renderEntries();
  selectEntry(currentSnippets.length - 1);
  nameInput.focus();
}

function deleteEntryAt(index) {
  if (index < 0 || !currentSnippets[index]) return;
  const item = currentSnippets[index];
  const label = item.name || item.prefix || `entry_${index + 1}`;
  if (!window.confirm(`${label} を削除しますか？`)) return;
  currentSnippets.splice(index, 1);
  renderEntries();
  if (currentSnippets.length) {
    selectEntry(Math.max(0, index - 1));
  } else {
    selectEntry(-1);
  }
  setStatus('項目を削除しました。保存すると反映されます。');
}

function renderRootInfo(info) {
  if (!info) return;
  currentRootInfo = info;
  if (rootInput && document.activeElement !== rootInput) {
    rootInput.value = info.configured || '';
  }
  if (rootCurrentEl) {
    const suffix = info.is_default ? '（既定）' : '';
    const missing = info.exists ? '' : ' — フォルダが存在しません';
    rootCurrentEl.textContent = `${info.root}${suffix}${missing}`;
  }
}

async function loadRootInfo() {
  try {
    const resp = await fetch('/api/snippets/root');
    renderRootInfo(await resp.json());
  } catch (_) {}
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

async function applyRoot(path) {
  const prevLabel = rootApplyBtn.textContent;
  rootApplyBtn.disabled = true;
  rootResetBtn.disabled = true;
  rootApplyBtn.textContent = '適用中...';
  try {
    const resp = await fetch('/api/snippets/root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!resp.ok) {
      const error = await resp.text();
      setStatus(error || 'ルートフォルダの変更に失敗しました', true);
      await loadRootInfo();
      return;
    }
    renderRootInfo(await resp.json());
    setStatus('スニペットのルートフォルダを変更しました');
    currentPath = '';
    await loadFiles();
  } catch (err) {
    setStatus(String(err), true);
  } finally {
    rootApplyBtn.disabled = false;
    rootResetBtn.disabled = false;
    rootApplyBtn.textContent = prevLabel;
  }
}

async function init() {
  bindForm();
  updateFormDisabled(true);
  refreshBtn.addEventListener('click', () => loadFiles(currentPath));
  createFileBtn.addEventListener('click', createFile);
  saveFileBtn.addEventListener('click', saveCurrentFile);
  addEntryBtn.addEventListener('click', addEntry);
  entrySearchInput.addEventListener('input', renderEntries);
  if (rootBrowseBtn) {
    if (getElectronAPI()?.selectFolder) {
      rootBrowseBtn.addEventListener('click', browseRoot);
    } else {
      rootBrowseBtn.hidden = true;
    }
  }
  rootApplyBtn?.addEventListener('click', () => applyRoot(rootInput.value.trim()));
  rootResetBtn?.addEventListener('click', () => { rootInput.value = ''; applyRoot(''); });
  rootInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); applyRoot(rootInput.value.trim()); }
  });
  await loadRootInfo();
  await loadFiles();
}

init();
