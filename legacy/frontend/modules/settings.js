'use strict';

import { CTX_STEPS, CTX_LABELS } from './utils.js';

// ---------------------------------------------------------------------------
// Slider schema: [sliderId, displayId, formatter, defaultValue]
// ---------------------------------------------------------------------------
const SLIDERS = [
  ['steps-slider',    'steps-val',        null,                          28],
  ['cfg-slider',      'cfg-val',          v => parseFloat(v).toFixed(1), 7],
  ['width-slider',    'width-val',        null,                          512],
  ['height-slider',   'height-val',       null,                          768],
  ['comfyui-width',   'comfyui-width-val',null,                          1024],
  ['comfyui-height',  'comfyui-height-val',null,                         1024],
  ['video-width',     'video-width-val',  null,                          848],
  ['video-height',    'video-height-val', null,                          480],
];

let saveTimer = null;

export function getSelectedBackend() {
  return document.getElementById('backend-select')?.value || 'WebUI Forge';
}

export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getSettings()),
    });
  }, 600);
}

function getCfgValueText() {
  return parseFloat(document.getElementById('cfg-slider').value).toFixed(1);
}

export function getSettings() {
  const backend = getSelectedBackend();
  const sections = Array.from(
    document.querySelectorAll('input[name="video-section"]:checked')
  ).map(el => el.value);

  return {
    model:    document.getElementById('model-dropdown').value,
    steps:    parseInt(document.getElementById('steps-slider').value),
    cfg:      getCfgValueText(),
    sampler:  document.getElementById('sampler-dropdown').value,
    width:    parseInt(document.getElementById('width-slider').value),
    height:   parseInt(document.getElementById('height-slider').value),
    seed:     parseInt(document.getElementById('seed-input').value) || -1,
    backend,
    comfyui_workflow: document.getElementById('comfyui-workflow').value,
    comfyui_width:    parseInt(document.getElementById('comfyui-width').value),
    comfyui_height:   parseInt(document.getElementById('comfyui-height').value),
    comfyui_seed:     parseInt(document.getElementById('comfyui-seed').value) || -1,
    image_save_path:  document.getElementById('image-save-path').value,
    video_save_path:  document.getElementById('video-save-path').value,
    unload_llm_before_video: document.getElementById('unload-llm-before-video').checked,
    video_workflow:   document.getElementById('video-workflow').value,
    video_sections:   sections,
    video_width:      parseInt(document.getElementById('video-width').value),
    video_height:     parseInt(document.getElementById('video-height').value),
    video_seed:       parseInt(document.getElementById('video-seed').value) || -1,
    video_frames:     parseInt(document.getElementById('video-frames').value) || 81,
    sound_enabled:    document.getElementById('sound-enabled').checked,
    chat_max_tokens:  CTX_STEPS[parseInt(document.getElementById('chat-context-slider')?.value || '0')],
  };
}

function setSlider(sliderId, displayId, value, fmt) {
  document.getElementById(sliderId).value = value;
  document.getElementById(displayId).textContent = fmt ? fmt(value) : value;
}

function swapSliderValues(firstId, secondId) {
  const first = document.getElementById(firstId);
  const second = document.getElementById(secondId);
  if (!first || !second) return;

  const firstValue = first.value;
  first.value = second.value;
  second.value = firstValue;
  first.dispatchEvent(new Event('input', { bubbles: true }));
  second.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function loadSettings() {
  const s = await fetch('/api/settings').then(r => r.json());

  // Model
  const modelDd = document.getElementById('model-dropdown');
  if (modelDd.querySelector(`option[value="${s.model}"]`)) modelDd.value = s.model;

  // Forge sliders
  setSlider('steps-slider', 'steps-val', s.steps ?? 28);
  setSlider('cfg-slider',   'cfg-val',   s.cfg ?? 7, v => parseFloat(v).toFixed(1));
  setSlider('width-slider', 'width-val', s.width ?? 512);
  setSlider('height-slider','height-val',s.height ?? 768);
  document.getElementById('seed-input').value = s.seed ?? -1;

  // Sampler
  const samplerDd = document.getElementById('sampler-dropdown');
  if (samplerDd.querySelector(`option[value="${s.sampler}"]`)) samplerDd.value = s.sampler;

  // ComfyUI sliders
  setSlider('comfyui-width',  'comfyui-width-val',  s.comfyui_width  ?? 1024);
  setSlider('comfyui-height', 'comfyui-height-val', s.comfyui_height ?? 1024);
  document.getElementById('comfyui-seed').value = s.comfyui_seed ?? -1;

  // ComfyUI workflow
  const wfDd = document.getElementById('comfyui-workflow');
  if (s.comfyui_workflow && wfDd.querySelector(`option[value="${s.comfyui_workflow}"]`)) {
    wfDd.value = s.comfyui_workflow;
  }

  // Backend
  const backendVal = s.backend === 'Forge 2' ? 'WebUI Forge' : (s.backend || 'WebUI Forge');
  const backendSelect = document.getElementById('backend-select');
  if (backendSelect?.querySelector(`option[value="${backendVal}"]`)) backendSelect.value = backendVal;
  updateBackendVisibility();

  document.getElementById('image-save-path').value = s.image_save_path || './outputs/images';

  // Video workflow
  const vwfDd = document.getElementById('video-workflow');
  if (s.video_workflow && vwfDd.querySelector(`option[value="${s.video_workflow}"]`)) {
    vwfDd.value = s.video_workflow;
  }

  // Video sliders
  setSlider('video-width',  'video-width-val',  s.video_width  ?? 848);
  setSlider('video-height', 'video-height-val', s.video_height ?? 480);
  document.getElementById('video-seed').value   = s.video_seed   ?? -1;
  document.getElementById('video-frames').value = s.video_frames ?? 81;
  document.getElementById('video-save-path').value = s.video_save_path || './outputs/videos';
  document.getElementById('unload-llm-before-video').checked = !!s.unload_llm_before_video;

  // Video sections
  if (Array.isArray(s.video_sections)) {
    document.querySelectorAll('input[name="video-section"]').forEach(cb => {
      cb.checked = s.video_sections.includes(cb.value);
    });
  }

  document.getElementById('sound-enabled').checked = s.sound_enabled !== false;

  const ctxTokens = s.chat_max_tokens || 4096;
  const ctxIdx = Math.max(0, CTX_STEPS.indexOf(ctxTokens));
  const ctxSlider = document.getElementById('chat-context-slider');
  const ctxValEl  = document.getElementById('chat-context-val');
  if (ctxSlider) ctxSlider.value = ctxIdx >= 0 ? ctxIdx : 0;
  if (ctxValEl)  ctxValEl.textContent = CTX_LABELS[ctxIdx >= 0 ? ctxIdx : 0];
}

export function updateBackendVisibility() {
  const isComfy = getSelectedBackend() === 'ComfyUI';
  document.getElementById('comfyui-params').style.display      = isComfy ? '' : 'none';
  document.getElementById('forge-params').style.display        = isComfy ? 'none' : '';
  document.getElementById('comfyui-seed-controls').style.display = isComfy ? '' : 'none';
  document.getElementById('forge-seed-controls').style.display   = isComfy ? 'none' : '';
}

async function openSelectedBackendInBrowser() {
  const backend = getSelectedBackend();
  try {
    const resp = await fetch('/api/open_backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend }),
    });
    const data = await resp.json();
    if (!data.ok) alert(data.message || 'バックエンドを開けませんでした');
  } catch (e) {
    alert(`バックエンドを開けませんでした: ${e}`);
  }
}

export async function initDropdowns() {
  const presetsResp = await fetch('/api/model_presets').then(r => r.json());
  const modelDd = document.getElementById('model-dropdown');
  modelDd.innerHTML = '';
  for (const preset of presetsResp.presets) {
    const opt = document.createElement('option');
    opt.value = preset; opt.textContent = preset;
    modelDd.appendChild(opt);
  }

  const samplersResp = await fetch('/api/samplers').then(r => r.json());
  const samplerDd = document.getElementById('sampler-dropdown');
  samplerDd.innerHTML = '';
  for (const s of samplersResp.samplers) {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    samplerDd.appendChild(opt);
  }

  const wfResp = await fetch('/api/workflows').then(r => r.json());
  const wfDd = document.getElementById('comfyui-workflow');
  wfDd.innerHTML = '';
  for (const w of wfResp.workflows) {
    const opt = document.createElement('option');
    opt.value = w; opt.textContent = w;
    wfDd.appendChild(opt);
  }

  const vwfResp = await fetch('/api/video_workflows').then(r => r.json());
  const vwfDd = document.getElementById('video-workflow');
  vwfDd.innerHTML = '';
  for (const w of vwfResp.workflows) {
    const opt = document.createElement('option');
    opt.value = w; opt.textContent = w;
    vwfDd.appendChild(opt);
  }
}

export function registerSettingsListeners() {
  // Sliders
  for (const [sliderId, displayId, fmt] of SLIDERS) {
    const slider = document.getElementById(sliderId);
    const display = document.getElementById(displayId);
    if (!slider || !display) continue;
    slider.addEventListener('input', () => {
      display.textContent = fmt ? fmt(slider.value) : slider.value;
      scheduleSave();
    });
  }

  document.getElementById('backend-select')?.addEventListener('change', () => {
    updateBackendVisibility();
    scheduleSave();
  });
  document.getElementById('open-backend-browser-btn')?.addEventListener('click', openSelectedBackendInBrowser);

  // Text / select fields
  ['positive-prompt', 'negative-prompt',
    'seed-input', 'comfyui-seed', 'video-seed', 'video-frames',
    'image-save-path', 'video-save-path',
    'model-dropdown', 'sampler-dropdown', 'comfyui-workflow', 'video-workflow',
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', scheduleSave);
  });

  document.querySelectorAll('input[name="video-section"]')
    .forEach(cb => cb.addEventListener('change', scheduleSave));

  document.getElementById('unload-llm-before-video')?.addEventListener('change', scheduleSave);
  document.getElementById('sound-enabled')?.addEventListener('change', scheduleSave);

  document.querySelectorAll('.dimension-swap-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      swapSliderValues(btn.dataset.swapWidth, btn.dataset.swapHeight);
    });
  });

  // Context length slider
  const ctxSlider = document.getElementById('chat-context-slider');
  const ctxVal    = document.getElementById('chat-context-val');
  if (ctxSlider && ctxVal) {
    ctxSlider.addEventListener('input', () => {
      ctxVal.textContent = CTX_LABELS[parseInt(ctxSlider.value)];
      scheduleSave();
    });
  }
}
