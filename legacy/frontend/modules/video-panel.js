'use strict';

import { scheduleSave } from './settings.js';

// ---------------------------------------------------------------------------
// DOM refs (exported for generation.js)
// ---------------------------------------------------------------------------
export const videoDisplay     = document.getElementById('video-display');
export const videoPlaceholder = document.getElementById('video-placeholder');
export const videoStatus      = document.getElementById('video-status');
const videoImageDropArea      = document.getElementById('video-image-drop-area');
const videoImageDisplay       = document.getElementById('video-image-display');
const videoImagePlaceholder   = document.getElementById('video-image-placeholder');
const videoImageFileInput     = document.getElementById('video-image-file-input');
const videoImageStatus        = document.getElementById('video-image-status');

function showVideoImage(src) {
  videoImageDisplay.src = src;
  videoImageDisplay.style.display = 'block';
  videoImagePlaceholder.style.display = 'none';
  videoImageDropArea.classList.add('has-image');
}

async function uploadVideoImage(file) {
  if (!file?.type.startsWith('image/')) {
    videoImageStatus.textContent = '画像ファイルを選択してください。';
    return;
  }
  videoImageStatus.textContent = '画像を読み込み中...';
  const formData = new FormData();
  formData.append('file', file);
  const filePath = window.electronAPI?.getPathForFile?.(file) || '';
  formData.append('image_path', filePath);
  try {
    const resp = await fetch('/api/video/image/upload', { method: 'POST', body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '画像の読み込みに失敗しました');
    showVideoImage(data.image);
    document.getElementById('video-source-prompt').value = data.positive || '';
    if (data.saved_json) {
      document.getElementById('video-prompt').value = data.saved_json.prompt || '';
      document.getElementById('video-extra-instruction').value =
        data.saved_json.additional_instruction || '';
    }
    videoImageStatus.textContent = data.status;
  } catch (e) {
    videoImageStatus.textContent = `エラー: ${e.message || e}`;
  }
}

async function copyCurrentImage() {
  videoImageStatus.textContent = '画像生成から取得中...';
  try {
    const data = await fetch('/api/video/image/from-current', { method: 'POST' }).then(r => r.json());
    if (!data.ok) {
      videoImageStatus.textContent = data.message;
      return;
    }
    showVideoImage(data.image);
    document.getElementById('video-source-prompt').value =
      document.getElementById('positive-prompt').value;
    videoImageStatus.textContent = data.status;
  } catch (e) {
    videoImageStatus.textContent = `エラー: ${e.message || e}`;
  }
}

// ---------------------------------------------------------------------------
// Seed from video
// ---------------------------------------------------------------------------
async function seedFromVideo() {
  const resp = await fetch('/api/seed_from_video', { method: 'POST' }).then(r => r.json());
  if (resp.ok) {
    document.getElementById('video-seed').value = resp.seed;
    if (videoStatus) videoStatus.textContent = resp.message;
    scheduleSave();
  } else {
    if (videoStatus) videoStatus.textContent = resp.message;
  }
}

// ---------------------------------------------------------------------------
// Register all event listeners
// ---------------------------------------------------------------------------
export function registerVideoPanelListeners() {
  videoImageDropArea.addEventListener('click', () => videoImageFileInput.click());
  videoImageDropArea.addEventListener('dragover', e => {
    e.preventDefault();
    videoImageDropArea.classList.add('dragover');
  });
  videoImageDropArea.addEventListener('dragleave', () => videoImageDropArea.classList.remove('dragover'));
  videoImageDropArea.addEventListener('drop', async e => {
    e.preventDefault();
    videoImageDropArea.classList.remove('dragover');
    await uploadVideoImage(e.dataTransfer.files[0]);
  });
  videoImageFileInput.addEventListener('change', async () => {
    await uploadVideoImage(videoImageFileInput.files[0]);
    videoImageFileInput.value = '';
  });
  document.getElementById('video-image-from-current-btn').addEventListener('click', copyCurrentImage);
  // Seed buttons
  document.getElementById('video-seed-random-btn').addEventListener('click', () => {
    document.getElementById('video-seed').value = -1;
    scheduleSave();
  });
  document.getElementById('video-seed-from-video-btn').addEventListener('click', seedFromVideo);

  // Resolution presets
  document.getElementById('video-res-640').addEventListener('click', () => {
    document.getElementById('video-width').value          = 640;
    document.getElementById('video-width-val').textContent = 640;
    document.getElementById('video-height').value          = 480;
    document.getElementById('video-height-val').textContent = 480;
    scheduleSave();
  });
  document.getElementById('video-res-1280').addEventListener('click', () => {
    document.getElementById('video-width').value          = 1280;
    document.getElementById('video-width-val').textContent = 1280;
    document.getElementById('video-height').value          = 720;
    document.getElementById('video-height-val').textContent = 720;
    scheduleSave();
  });

  // Path button
  document.getElementById('open-video-path-btn').addEventListener('click', () => {
    const p = document.getElementById('video-file-path').textContent
      || document.getElementById('video-save-path').value;
    if (p) fetch('/api/open_path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
  });

  // Workflow folder buttons
  document.getElementById('open-image-workflow-folder-btn').addEventListener('click', () => {
    fetch('/api/open_workflow_folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'image' }),
    });
  });
  document.getElementById('open-video-workflow-folder-btn').addEventListener('click', () => {
    fetch('/api/open_workflow_folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'video' }),
    });
  });
}
