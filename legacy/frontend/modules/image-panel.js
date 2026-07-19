'use strict';

import { scheduleSave } from './settings.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
export const imageDropArea      = document.getElementById('image-drop-area');
export const imageDisplay       = document.getElementById('image-display');
export const imageStatus        = document.getElementById('image-status');
const imageFileInput            = document.getElementById('image-file-input');
const imagePlaceholder          = document.getElementById('image-placeholder');
const imageZoomBtn              = document.getElementById('image-zoom-btn');
const imageLightbox             = document.getElementById('image-lightbox');
const imageLightboxDisplay      = document.getElementById('image-lightbox-display');
const imageLightboxClose        = document.getElementById('image-lightbox-close');

// ---------------------------------------------------------------------------
// Image display
// ---------------------------------------------------------------------------
export function showImage(src) {
  imageDisplay.src = src;
  imageDisplay.style.display = 'block';
  imageZoomBtn.style.display = 'inline-flex';
  imagePlaceholder.style.display = 'none';
  imageDropArea.classList.add('has-image');
  const saveBtn = document.getElementById('save-to-library-btn');
  if (saveBtn) saveBtn.disabled = false;
}

export function clearImage() {
  imageDisplay.removeAttribute('src');
  imageDisplay.style.display = 'none';
  imageZoomBtn.style.display = 'none';
  imagePlaceholder.style.display = '';
  imageDropArea.classList.remove('has-image');
  closeImageLightbox();

  const saveBtn = document.getElementById('save-to-library-btn');
  if (saveBtn) saveBtn.disabled = true;

  const filePath = document.getElementById('image-file-path');
  if (filePath) filePath.textContent = '';

  const saveStatus = document.getElementById('save-to-library-status');
  if (saveStatus) saveStatus.textContent = '';

  imageStatus.textContent = '';
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------
function openImageLightbox() {
  if (!imageDisplay.src) return;
  imageLightboxDisplay.src = imageDisplay.src;
  imageLightbox.classList.add('is-open');
  imageLightbox.setAttribute('aria-hidden', 'false');
  document.body.classList.add('lightbox-open');
}

export function closeImageLightbox() {
  imageLightbox.classList.remove('is-open');
  imageLightbox.setAttribute('aria-hidden', 'true');
  imageLightboxDisplay.removeAttribute('src');
  document.body.classList.remove('lightbox-open');
}

// ---------------------------------------------------------------------------
// Metadata application
// ---------------------------------------------------------------------------
export function autoResizePositive() {
  const el = document.getElementById('positive-prompt');
  if (!el) return;
  if (el.offsetParent === null) {
    requestAnimationFrame(autoResizePositive);
    return;
  }
  const style = window.getComputedStyle(el);
  const lineHeight = parseFloat(style.lineHeight) || 18;
  const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const minHeight = (Number(el.getAttribute('rows')) || 16) * lineHeight + paddingY;
  el.style.height = 'auto';
  el.style.height = Math.max(el.scrollHeight, minHeight) + 'px';
}

export function applyMetadata(meta) {
  if (meta.positive != null) {
    document.getElementById('positive-prompt').value = meta.positive;
    autoResizePositive();
  }
  if (meta.negative  != null) document.getElementById('negative-prompt').value = meta.negative;
  if (meta.steps     != null) {
    document.getElementById('steps-slider').value = meta.steps;
    document.getElementById('steps-val').textContent = meta.steps;
  }
  if (meta.cfg_scale != null) {
    document.getElementById('cfg-slider').value = meta.cfg_scale;
    document.getElementById('cfg-val').textContent = parseFloat(meta.cfg_scale).toFixed(1);
  }
  if (meta.sampler   != null) {
    const dd = document.getElementById('sampler-dropdown');
    if (dd.querySelector(`option[value="${meta.sampler}"]`)) dd.value = meta.sampler;
  }
  if (meta.width     != null) {
    document.getElementById('width-slider').value = meta.width;
    document.getElementById('width-val').textContent = meta.width;
  }
  if (meta.height    != null) {
    document.getElementById('height-slider').value = meta.height;
    document.getElementById('height-val').textContent = meta.height;
  }
  if (meta.seed      != null) {
    document.getElementById('seed-input').value = meta.seed;
    document.getElementById('comfyui-seed').value = meta.seed;
  }
  scheduleSave();
}

export function applySavedJson(data) {
  if (data.prompt != null)
    document.getElementById('video-prompt').value = data.prompt;
  if (data.additional_instruction != null)
    document.getElementById('video-extra-instruction').value = data.additional_instruction;
  if (data.comfyui_workflow != null) {
    const dd = document.getElementById('comfyui-workflow');
    if (dd.querySelector(`option[value="${data.comfyui_workflow}"]`)) dd.value = data.comfyui_workflow;
  }
  if (data.video_workflow != null) {
    const dd = document.getElementById('video-workflow');
    if (dd.querySelector(`option[value="${data.video_workflow}"]`)) dd.value = data.video_workflow;
  }
  scheduleSave();
}

export async function useLibraryImage(imageId) {
  const resp = await fetch(`/api/library/images/${encodeURIComponent(imageId)}/use`, {
    method: 'POST',
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(data.detail || 'Failed to use library image');
  }

  const item = data.image || {};
  showImage(`/api/library/images/${encodeURIComponent(imageId)}/file?cache=${Date.now()}`);
  if (item.original_path || item.file_path) {
    document.getElementById('image-file-path').textContent = item.original_path || item.file_path;
  }
  applyMetadata({
    positive: item.positive_prompt,
    negative: item.negative_prompt,
    width: item.width,
    height: item.height,
    seed: data.meta?.seed,
  });
  imageStatus.textContent = `Library image loaded: ${item.filename || `#${imageId}`}`;
}

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------
function setSavePathsFromFilePath(filePath) {
  if (!filePath) return;
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) return;
  const dir = filePath.slice(0, idx);
  document.getElementById('image-save-path').value = dir;
  document.getElementById('video-save-path').value = dir;
  scheduleSave();
}

async function uploadImage(file) {
  imageStatus.textContent = 'アップロード中...';
  const formData = new FormData();
  formData.append('file', file);
  const filePath = window.electronAPI?.getPathForFile?.(file) || '';
  if (filePath) formData.append('image_path', filePath);
  try {
    const resp = await fetch('/api/image/upload', { method: 'POST', body: formData });
    const data = await resp.json();
    showImage(data.image);
    imageStatus.textContent = data.status;
    if (filePath) document.getElementById('image-file-path').textContent = filePath;
    if (data.meta) applyMetadata(data.meta);
    if (data.saved_json) applySavedJson(data.saved_json);
  } catch (e) {
    imageStatus.textContent = `エラー: ${e}`;
  }
}

async function uploadJson(file) {
  imageStatus.textContent = 'JSON 読み込み中...';
  const formData = new FormData();
  formData.append('file', file);
  try {
    const resp = await fetch('/api/json/upload', { method: 'POST', body: formData });
    const data = await resp.json();
    if (!data.ok) { imageStatus.textContent = data.message || 'JSON の読み込みに失敗しました'; return; }
    showImage(data.image);
    imageStatus.textContent = data.status;
    if (data.image_path) document.getElementById('image-file-path').textContent = data.image_path;
    if (data.meta) applyMetadata(data.meta);
    if (data.saved_json) applySavedJson(data.saved_json);
  } catch (e) {
    imageStatus.textContent = `エラー: ${e}`;
  }
}

// ---------------------------------------------------------------------------
// Seed from image
// ---------------------------------------------------------------------------
async function seedFromImage(targetId) {
  const resp = await fetch('/api/seed_from_image', { method: 'POST' }).then(r => r.json());
  if (resp.ok) {
    document.getElementById(targetId).value = resp.seed;
    imageStatus.textContent = resp.message;
    scheduleSave();
  } else {
    imageStatus.textContent = resp.message;
  }
}

// ---------------------------------------------------------------------------
// Library save button
// ---------------------------------------------------------------------------
function initLibrarySaveBtn() {
  document.getElementById('save-to-library-btn').addEventListener('click', async () => {
    const btn      = document.getElementById('save-to-library-btn');
    const statusEl = document.getElementById('save-to-library-status');
    btn.disabled = true;
    if (statusEl) statusEl.textContent = '保存中...';
    try {
      const resp = await fetch('/api/save_current_to_library', { method: 'POST' }).then(r => r.json());
      if (statusEl) statusEl.textContent = resp.ok ? 'ライブラリに保存しました' : `エラー: ${resp.detail || ''}`;
    } catch (e) {
      if (statusEl) statusEl.textContent = `エラー: ${e}`;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Path open button
// ---------------------------------------------------------------------------
function openPath(path) {
  if (path) fetch('/api/open_path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

// ---------------------------------------------------------------------------
// Register all event listeners
// ---------------------------------------------------------------------------
export function registerImagePanelListeners() {
  const positivePromptInput = document.getElementById('positive-prompt');
  positivePromptInput?.addEventListener('input', autoResizePositive);

  // Drop area
  imageDropArea.addEventListener('click', () => {
    if (imageDisplay.src) { openImageLightbox(); return; }
    imageFileInput.click();
  });
  imageZoomBtn.addEventListener('click', e => { e.stopPropagation(); imageFileInput.click(); });

  // Drag & drop
  imageDropArea.addEventListener('dragover',  e => { e.preventDefault(); imageDropArea.classList.add('dragover'); });
  imageDropArea.addEventListener('dragleave', () => imageDropArea.classList.remove('dragover'));
  imageDropArea.addEventListener('drop', async e => {
    e.preventDefault();
    imageDropArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    setSavePathsFromFilePath(window.electronAPI?.getPathForFile?.(file) || '');
    if (file.type.startsWith('image/')) { await uploadImage(file); return; }
    if (file.name.toLowerCase().endsWith('.json')) await uploadJson(file);
  });

  imageFileInput.addEventListener('change', async () => {
    const file = imageFileInput.files[0];
    if (file) await uploadImage(file);
    imageFileInput.value = '';
  });

  // Lightbox
  imageLightboxClose.addEventListener('click', closeImageLightbox);
  imageLightbox.addEventListener('click', e => { if (e.target === imageLightbox) closeImageLightbox(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && imageLightbox.classList.contains('is-open')) closeImageLightbox();
  });

  // Seed buttons
  document.getElementById('seed-random-btn').addEventListener('click', () => {
    document.getElementById('seed-input').value = -1;
    scheduleSave();
  });
  document.getElementById('comfyui-seed-random-btn').addEventListener('click', () => {
    document.getElementById('comfyui-seed').value = -1;
    scheduleSave();
  });
  document.getElementById('seed-from-image-btn').addEventListener('click',
    () => seedFromImage('seed-input'));
  document.getElementById('comfyui-seed-from-image-btn').addEventListener('click',
    () => seedFromImage('comfyui-seed'));

  // Copy buttons
  document.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      navigator.clipboard.writeText(target.value).then(() => {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
      });
    });
  });

  // Path buttons
  document.getElementById('open-image-path-btn').addEventListener('click', () => {
    openPath(document.getElementById('image-file-path').textContent
      || document.getElementById('image-save-path').value);
  });

  // Library save
  initLibrarySaveBtn();

  // JSON save
  document.getElementById('save-json-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('save-json-status');
    statusEl.textContent = '保存中...';
    const resp = await fetch('/api/save_json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_prompt:           document.getElementById('video-prompt').value,
        additional_instruction: document.getElementById('video-extra-instruction').value,
        comfyui_workflow:       document.getElementById('comfyui-workflow').value,
        video_workflow:         document.getElementById('video-workflow').value,
      }),
    }).then(r => r.json());
    statusEl.textContent = resp.message;
  });

  window.addEventListener('message', async event => {
    if (event.origin !== window.location.origin) return;
    const data = event.data || {};
    if (data.type !== 'use-library-image' || !data.imageId) return;
    try {
      document.querySelector('[data-page-target="tab-image"]')?.click();
      await useLibraryImage(data.imageId);
      requestAnimationFrame(autoResizePositive);
    } catch (e) {
      imageStatus.textContent = `Error: ${e.message || e}`;
    }
  });
}
