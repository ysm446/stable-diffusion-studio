'use strict';

import { fetchSSE, truncateText, formatElapsedMs } from './utils.js';
import { getSelectedBackend, getSettings, scheduleSave } from './settings.js';
import { showImage, clearImage, imageDropArea, imageStatus } from './image-panel.js';
import { videoDisplay, videoPlaceholder, videoStatus } from './video-panel.js';

// ---------------------------------------------------------------------------
// Queue state
// ---------------------------------------------------------------------------
let genQueue       = [];
let genProcessing  = false;
let genAbortCtrl   = null;
let genCurrentJobId = null;
let genJobSeq      = 0;
let genQueueRenderTimer = null;
let videoPromptAbortCtrl = null;

const GEN_TERMINAL_RETENTION_MS = 5000;

// Image timer state
let imageElapsedTimer = null;
let imageStartTime    = null;
export let imageBaseStatus = '';

// ---------------------------------------------------------------------------
// Image status (needs getQueueLabel which is local here)
// ---------------------------------------------------------------------------
export function getQueueLabel() {
  const n = genQueue.filter(job => job.status === 'queued').length;
  return n > 0 ? `（キュー: ${n}件）` : '';
}

export function setImageStatus(text) {
  imageBaseStatus = text + getQueueLabel();
  if (imageStartTime) {
    const elapsed = Math.floor((Date.now() - imageStartTime) / 1000);
    imageStatus.textContent = imageBaseStatus + ` (${elapsed}秒)`;
  } else {
    imageStatus.textContent = imageBaseStatus;
  }
}

export function startImageTimer() {
  imageStartTime = Date.now();
  imageElapsedTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - imageStartTime) / 1000);
    imageStatus.textContent = imageBaseStatus + ` (${elapsed}秒)`;
  }, 1000);
}

export function stopImageTimer() {
  if (imageElapsedTimer) { clearInterval(imageElapsedTimer); imageElapsedTimer = null; }
  imageStartTime = null;
}

// ---------------------------------------------------------------------------
// Job model helpers
// ---------------------------------------------------------------------------
function getJobTypeTitle(type) {
  if (type === 'image') return '画像生成';
  if (type === 'video') return '動画生成';
  return '動画プロンプト';
}

function getJobSubtitle(type, params) {
  if (type === 'image') {
    const seed = params.backend === 'ComfyUI' ? params.comfyui_seed : params.seed;
    return `Seed ${seed == null || seed === -1 ? 'random' : seed}`;
  }
  if (type === 'video') return truncateText(params.workflow || 'Workflow 未設定', 24);
  return `Sections ${(params.sections || []).join(', ') || '-'}`;
}

function createGenerationJob(type, params) {
  genJobSeq += 1;
  return {
    id: `gen-job-${Date.now()}-${genJobSeq}`,
    type,
    title: getJobTypeTitle(type),
    subtitle: getJobSubtitle(type, params),
    status: 'queued',
    statusText: '',
    params,
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
    cleanupTimer: null,
    lastError: '',
  };
}

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------
function getQueueCount() {
  return genQueue.filter(job => job.status === 'queued' || job.status === 'running').length;
}

export function getCurrentGenerationJob() {
  return genQueue.find(job => job.id === genCurrentJobId) || null;
}

function clearJobCleanup(job) {
  if (!job?.cleanupTimer) return;
  clearTimeout(job.cleanupTimer);
  job.cleanupTimer = null;
}

function scheduleJobCleanup(job) {
  clearJobCleanup(job);
  if (!job || !['done', 'error', 'cancelled'].includes(job.status)) return;
  job.cleanupTimer = setTimeout(() => removeGenerationJob(job.id), GEN_TERMINAL_RETENTION_MS);
}

function removeGenerationJob(jobId) {
  const index = genQueue.findIndex(job => job.id === jobId);
  if (index === -1) return;
  clearJobCleanup(genQueue[index]);
  genQueue.splice(index, 1);
  renderGenerationQueue();
}

function finalizeGenerationJob(job, status) {
  job.status = status;
  job.endedAt = Date.now();
  if (job.clearAfterFinish) { removeGenerationJob(job.id); return; }
  scheduleJobCleanup(job);
}

function stopAllGeneration() {
  const runningJob = getCurrentGenerationJob();
  genQueue.filter(job => job.status !== 'running').forEach(job => removeGenerationJob(job.id));
  if (runningJob) {
    runningJob.clearAfterFinish = true;
    cancelGenerationJob(runningJob.id);
  } else {
    renderGenerationQueue();
  }
}

export function cancelGenerationJob(jobId) {
  const job = genQueue.find(item => item.id === jobId);
  if (!job) return;
  if (job.status === 'queued') { removeGenerationJob(jobId); return; }
  if (job.status !== 'running' || genCurrentJobId !== jobId) return;

  job.cancelRequested = true;
  renderGenerationQueue();
  if (genAbortCtrl) genAbortCtrl.abort();
  if (job.type === 'image') {
    fetch('/api/interrupt_image', { method: 'POST' });
  } else if (job.type === 'video') {
    fetch('/api/stop_video', { method: 'POST' });
  } else if (videoPromptAbortCtrl) {
    videoPromptAbortCtrl.abort();
  }
}

// ---------------------------------------------------------------------------
// Queue render
// ---------------------------------------------------------------------------
function setImageBusy(busy) {
  document.getElementById('generate-btn').disabled = false;
  imageDropArea.classList.toggle('generating', busy);
}

function setVideoBusy(busy) {
  document.getElementById('generate-video-btn').disabled = false;
  document.querySelector('.video-area').classList.toggle('generating', busy);
}

function getQueueStateLabel(job) {
  if (job.status === 'running') return job.cancelRequested ? '停止中' : '実行中';
  if (job.status === 'queued') {
    const queueIndex = genQueue.filter(i => i.status === 'queued').findIndex(i => i.id === job.id);
    return `待機 ${queueIndex + 1}`;
  }
  if (job.status === 'done') return '完了';
  if (job.status === 'error') return 'エラー';
  return '停止';
}

function updateQueueRenderTimer() {
  const hasRunning = genQueue.some(job => job.status === 'running');
  if (hasRunning && !genQueueRenderTimer) {
    genQueueRenderTimer = setInterval(renderGenerationQueue, 1000);
  } else if (!hasRunning && genQueueRenderTimer) {
    clearInterval(genQueueRenderTimer);
    genQueueRenderTimer = null;
  }
}

function updateGenerationBusyState() {
  const currentJob = getCurrentGenerationJob();
  const hasRunning = Boolean(currentJob);
  document.getElementById('stop-btn').disabled       = !hasRunning;
  document.getElementById('stop-video-btn').disabled = !hasRunning;
  document.getElementById('generation-queue-clear-btn').disabled = genQueue.length === 0;
  setImageBusy(hasRunning && currentJob.type === 'image');
  setVideoBusy(hasRunning && (currentJob.type === 'video' || currentJob.type === 'videoPrompt'));
  document.getElementById('video-prompt')
    .classList.toggle('generating', hasRunning && currentJob.type === 'videoPrompt');
}

export function renderGenerationQueue() {
  updateQueueRenderTimer();
  updateGenerationBusyState();

  const generationQueueList   = document.getElementById('generation-queue-list');
  const generationQueueEmpty  = document.getElementById('generation-queue-empty');
  const generationQueueCount  = document.getElementById('generation-queue-count');

  generationQueueCount.textContent = String(getQueueCount());
  generationQueueEmpty.classList.toggle('is-visible', genQueue.length === 0);
  generationQueueList.innerHTML = '';

  genQueue.forEach(job => {
    const card = document.createElement('div');
    card.className = `generation-queue-card is-${job.status}`;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'generation-queue-remove';
    removeBtn.dataset.jobId  = job.id;
    removeBtn.dataset.action = job.status === 'running' ? 'cancel' : 'remove';
    removeBtn.textContent = '×';
    removeBtn.title = job.status === 'running' ? 'このジョブを停止' : 'このジョブを削除';
    removeBtn.setAttribute('aria-label', removeBtn.title);

    const head = document.createElement('div');
    head.className = 'generation-queue-card-head';
    const meta = document.createElement('div');
    meta.className = 'generation-queue-meta';

    const kind = document.createElement('span');
    kind.className = 'generation-queue-kind';
    kind.setAttribute('aria-hidden', 'true');

    const state = document.createElement('span');
    state.className = 'generation-queue-state';
    state.textContent = getQueueStateLabel(job);

    const time = document.createElement('span');
    time.className = 'generation-queue-time';
    if (job.startedAt) {
      const endTime = job.status === 'running' ? Date.now() : (job.endedAt || Date.now());
      time.textContent = formatElapsedMs(endTime - job.startedAt);
    }

    meta.append(kind, state, time);
    head.append(meta, removeBtn);

    const title = document.createElement('div');
    title.className = 'generation-queue-card-title';
    title.textContent = job.title;

    const subtitle = document.createElement('div');
    subtitle.className = 'generation-queue-card-subtitle';
    subtitle.textContent = job.subtitle || ' ';

    card.append(head, title, subtitle);
    generationQueueList.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Job runners
// ---------------------------------------------------------------------------
async function runImageJob(job) {
  startImageTimer();
  try {
    await fetchSSE('/api/generate_image/stream', job.params, data => {
      if (data.type === 'status') {
        setImageStatus(data.content);
      } else if (data.type === 'image') {
        showImage(data.image);
        setImageStatus(data.status);
        if (data.saved_path) document.getElementById('image-file-path').textContent = data.saved_path;
        if (document.getElementById('sound-enabled').checked)
          new Audio('/assets/complete_image.mp3').play().catch(() => {});
      } else if (data.type === 'error') {
        job.lastError = data.content;
        setImageStatus(data.content);
      }
    }, genAbortCtrl.signal);
  } finally {
    stopImageTimer();
  }
  if (job.cancelRequested) {
    imageBaseStatus = '停止しました';
    imageStatus.textContent = imageBaseStatus;
    return 'cancelled';
  }
  return job.lastError ? 'error' : 'done';
}

async function runVideoPromptJob(job) {
  videoPromptAbortCtrl = genAbortCtrl;
  videoStatus.textContent = '動画プロンプトを生成中...';
  document.getElementById('video-prompt').value = '';
  let accumulated = '';
  try {
    await fetchSSE('/api/video_prompt/stream', job.params, data => {
      if (data.type === 'token') {
        accumulated += data.content;
        document.getElementById('video-prompt').value = accumulated;
        videoStatus.textContent = '動画プロンプトを生成中...';
      } else if (data.type === 'status') {
        videoStatus.textContent = data.content;
      } else if (data.type === 'error') {
        job.lastError = data.content;
        videoStatus.textContent = `エラー: ${data.content}`;
      }
    }, genAbortCtrl.signal);
  } finally {
    videoPromptAbortCtrl = null;
  }
  if (job.cancelRequested) { videoStatus.textContent = '停止しました'; return 'cancelled'; }
  if (!job.lastError) videoStatus.textContent = '動画プロンプト完了';
  return job.lastError ? 'error' : 'done';
}

async function runVideoJob(job) {
  try {
    await fetchSSE('/api/generate_video/stream', job.params, data => {
      const q = getQueueLabel();
      if (data.type === 'status') {
        videoStatus.textContent = data.content + q;
      } else if (data.type === 'video') {
        videoDisplay.src = data.url;
        videoDisplay.style.display = 'block';
        videoPlaceholder.style.display = 'none';
        videoStatus.textContent = data.status + q;
        if (data.saved_path) document.getElementById('video-file-path').textContent = data.saved_path;
        if (document.getElementById('sound-enabled').checked)
          new Audio('/assets/complete_video.mp3').play().catch(() => {});
      } else if (data.type === 'error') {
        job.lastError = data.content;
        videoStatus.textContent = data.content + q;
      }
    }, genAbortCtrl.signal);
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }
  if (job.cancelRequested) { videoStatus.textContent = '停止しました'; return 'cancelled'; }
  return job.lastError ? 'error' : 'done';
}

// ---------------------------------------------------------------------------
// Queue processor
// ---------------------------------------------------------------------------
async function processNextJob() {
  const job = genQueue.find(item => item.status === 'queued');
  if (!job) {
    genProcessing = false;
    genCurrentJobId = null;
    genAbortCtrl = null;
    renderGenerationQueue();
    return;
  }
  genProcessing = true;
  genAbortCtrl = new AbortController();
  genCurrentJobId = job.id;
  job.status = 'running';
  job.startedAt = Date.now();
  job.endedAt = null;
  job.cancelRequested = false;
  job.lastError = '';
  renderGenerationQueue();

  let finalStatus = 'done';
  try {
    if      (job.type === 'image')       finalStatus = await runImageJob(job);
    else if (job.type === 'video')       finalStatus = await runVideoJob(job);
    else                                 finalStatus = await runVideoPromptJob(job);
  } catch (e) {
    job.lastError = String(e);
    finalStatus = job.cancelRequested ? 'cancelled' : 'error';
  } finally {
    finalizeGenerationJob(job, finalStatus);
    genAbortCtrl = null;
    genCurrentJobId = null;
    videoPromptAbortCtrl = null;
    renderGenerationQueue();
  }
  void processNextJob();
}

export function enqueueGenerationJob(type, params) {
  const job = createGenerationJob(type, params);
  genQueue.push(job);
  renderGenerationQueue();
  if (!genProcessing) void processNextJob();
  return job;
}

// ---------------------------------------------------------------------------
// Register event listeners
// ---------------------------------------------------------------------------
export function registerGenerationListeners() {
  // Image generate / stop
  document.getElementById('generate-btn').addEventListener('click', () => {
    const backend = getSelectedBackend();
    enqueueGenerationJob('image', {
      positive:         document.getElementById('positive-prompt').value,
      negative:         document.getElementById('negative-prompt').value,
      steps:            parseInt(document.getElementById('steps-slider').value),
      cfg:              parseFloat(document.getElementById('cfg-slider').value).toFixed(1),
      sampler:          document.getElementById('sampler-dropdown').value,
      width:            parseInt(document.getElementById('width-slider').value),
      height:           parseInt(document.getElementById('height-slider').value),
      seed:             parseInt(document.getElementById('seed-input').value) || -1,
      backend,
      comfyui_workflow: document.getElementById('comfyui-workflow').value,
      comfyui_width:    parseInt(document.getElementById('comfyui-width').value),
      comfyui_height:   parseInt(document.getElementById('comfyui-height').value),
      comfyui_seed:     parseInt(document.getElementById('comfyui-seed').value) || -1,
      image_save_path:  document.getElementById('image-save-path').value,
    });
    imageStatus.textContent = genProcessing ? `待機中...${getQueueLabel()}` : '生成を開始します...';
  });

  document.getElementById('stop-btn').addEventListener('click', () => {
    const job = getCurrentGenerationJob();
    if (job) cancelGenerationJob(job.id);
  });

  document.getElementById('clear-prompt-btn').addEventListener('click', async () => {
    document.getElementById('positive-prompt').value = '';
    document.getElementById('negative-prompt').value = '';
    clearImage();
    scheduleSave();
    try {
      await fetch('/api/image/clear', { method: 'POST' });
    } catch (e) {
      imageStatus.textContent = `画像クリアエラー: ${e}`;
    }
  });

  // Queue list (remove/cancel buttons)
  document.getElementById('generation-queue-list').addEventListener('click', event => {
    const button = event.target.closest('.generation-queue-remove');
    if (!button?.dataset.jobId) return;
    cancelGenerationJob(button.dataset.jobId);
  });

  document.getElementById('generation-queue-clear-btn').addEventListener('click', stopAllGeneration);

  // Video prompt generate
  document.getElementById('generate-video-prompt-btn').addEventListener('click', () => {
    const sections = Array.from(
      document.querySelectorAll('input[name="video-section"]:checked')
    ).map(el => el.value);
    if (sections.length === 0) {
      videoStatus.textContent = 'セクションを1つ以上選択してください';
      return;
    }
    enqueueGenerationJob('videoPrompt', {
      positive:          document.getElementById('video-source-prompt').value,
      extra_instruction: document.getElementById('video-extra-instruction').value,
      sections,
      model_label:       document.getElementById('model-dropdown').value,
    });
    videoStatus.textContent = genProcessing ? `待機中...${getQueueLabel()}` : '動画プロンプト生成を開始します...';
  });

  // Video generate / stop
  document.getElementById('generate-video-btn').addEventListener('click', () => {
    enqueueGenerationJob('video', {
      video_prompt:            document.getElementById('video-prompt').value,
      workflow:                document.getElementById('video-workflow').value,
      seed:                    parseInt(document.getElementById('video-seed').value) || -1,
      width:                   parseInt(document.getElementById('video-width').value),
      height:                  parseInt(document.getElementById('video-height').value),
      frames:                  parseInt(document.getElementById('video-frames').value) || 81,
      video_save_path:         document.getElementById('video-save-path').value,
      unload_llm_before_video: document.getElementById('unload-llm-before-video').checked,
    });
    videoStatus.textContent = genProcessing ? `待機中...${getQueueLabel()}` : '動画生成を開始します...';
  });

  document.getElementById('stop-video-btn').addEventListener('click', () => {
    const job = getCurrentGenerationJob();
    if (job) cancelGenerationJob(job.id);
  });
}
