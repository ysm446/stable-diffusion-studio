'use strict';

// ---------------------------------------------------------------------------
// Backend state helpers (shared with chat.js via setRefreshLlmStatus)
// ---------------------------------------------------------------------------
export function backendState(status) {
  if (!status) return { text: '--', cls: 'is-unknown', title: '' };
  if (status.kind === 'llm') {
    if (status.ready)           return { text: 'Loaded', cls: 'is-ready', title: status.model || status.url || '' };
    if (status.process_running) return { text: 'Start',  cls: 'is-busy',  title: status.url || '' };
    return                             { text: 'Off',    cls: 'is-off',   title: status.url || '' };
  }
  if (!status.enabled)          return { text: '外部',   cls: 'is-external', title: status.url || '' };
  if (status.ready)             return { text: 'Ready',  cls: 'is-ready',    title: status.url || '' };
  if (status.installing)        return { text: 'Setup',  cls: 'is-busy',     title: status.log || '' };
  if (status.process_running)   return { text: 'Start',  cls: 'is-busy',     title: status.url || '' };
  if (status.returncode != null)return { text: 'Err',    cls: 'is-error',    title: status.error || status.log || '' };
  if (status.error)             return { text: 'Err',    cls: 'is-error',    title: status.error || status.log || '' };
  return                               { text: 'Off',    cls: 'is-off',      title: status.url || '' };
}

function shortModelName(label) {
  if (!label) return '';
  const sep   = label.includes('/') ? '/' : '\\';
  const parts = label.split(sep);
  return parts[parts.length - 1].replace(/\.gguf$/i, '');
}

export function setLlmVal(status) {
  const btn    = document.getElementById('topbar-llm-btn');
  const nameEl = document.getElementById('topbar-llm-name');
  const ejectBtn = document.getElementById('topbar-llm-eject');
  if (!btn || !nameEl) return;
  const state  = backendState({ ...status, kind: 'llm' });
  btn.className = `topbar-llm-btn ${state.cls}`;
  btn.title     = status?.model || status?.url || 'LLM モデル選択';
  const loaded  = state.cls === 'is-ready';
  if (loaded && status?.model)   nameEl.textContent = shortModelName(status.model);
  else if (state.cls === 'is-busy') nameEl.textContent = 'ロード中…';
  else                           nameEl.textContent = '未ロード';
  if (ejectBtn) ejectBtn.disabled = !loaded;
}

export async function refreshLlmStatus() {
  try {
    const resp = await fetch('/api/llm_status');
    if (resp.ok) setLlmVal(await resp.json());
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// System stats + backend status polling
// ---------------------------------------------------------------------------
export function initSystemStats() {
  const container        = document.getElementById('system-stats');
  const backendContainer = document.getElementById('topbar-backends');
  const vramToggle       = document.getElementById('vram-debug-toggle');
  const vramPanel        = document.getElementById('vram-debug-panel');
  const vramTitle        = document.getElementById('vram-debug-title');
  const vramBar          = document.getElementById('vram-debug-bar');
  const vramLegend       = document.getElementById('vram-debug-legend');
  if (!container) return;

  function makeItem(id, label) {
    const wrap = document.createElement('div');
    wrap.className = 'sstat';
    wrap.innerHTML = `
      <span class="sstat-label">${label}</span>
      <div class="sstat-bar-wrap"><div id="${id}-bar" class="sstat-bar" style="width:0%"></div></div>
      <span id="${id}-val" class="sstat-val">--</span>`;
    return wrap;
  }

  function makeBackendButton(id, label, ejectApi) {
    const wrap = document.createElement('div');
    wrap.className = 'topbar-backend';
    wrap.innerHTML = `
      <div class="topbar-backend-btn is-off" id="${id}-btn" title="">
        <span class="topbar-backend-dot"></span>
        <span class="topbar-backend-name">${label}</span>
      </div>
      <button type="button" class="topbar-llm-eject" id="${id}-eject"
              title="${label} を解放" aria-label="${label} を解放" disabled>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M5 17h14v2H5zM12 5l7 9H5z"></path>
        </svg>
      </button>`;
    wrap.querySelector(`#${id}-eject`).addEventListener('click', async () => {
      const btn = document.getElementById(`${id}-eject`);
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      try { await fetch(ejectApi, { method: 'POST' }).then(r => r.json()); } catch (_) {}
      finally { btn.disabled = false; }
    });
    return wrap;
  }

  function makeLlmButton() {
    const wrap = document.createElement('div');
    wrap.className = 'topbar-llm';
    wrap.innerHTML = `
      <button type="button" class="topbar-llm-btn is-off" id="topbar-llm-btn" title="LLM モデル選択">
        <span class="topbar-llm-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="6" y="6" width="12" height="12" rx="2"></rect>
            <rect x="9" y="9" width="6" height="6"></rect>
            <path d="M3 10h2M3 14h2M19 10h2M19 14h2M10 3v2M14 3v2M10 19v2M14 19v2"></path>
          </svg>
        </span>
        <span class="topbar-llm-spin" aria-hidden="true"></span>
        <span id="topbar-llm-name" class="topbar-llm-name">未ロード</span>
        <span class="topbar-llm-chev" aria-hidden="true">▾</span>
      </button>
      <button type="button" class="topbar-llm-eject" id="topbar-llm-eject"
              title="モデルを解放" aria-label="モデルを解放">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M5 17h14v2H5zM12 5l7 9H5z"></path>
        </svg>
      </button>`;
    return wrap;
  }

  const items = [
    { id: 'ss-cpu',  label: 'CPU',  unit: '%'  },
    { id: 'ss-ram',  label: 'RAM',  unit: 'GB' },
    { id: 'ss-gpu',  label: 'GPU',  unit: '%'  },
    { id: 'ss-vram', label: 'VRAM', unit: 'GB' },
  ];
  items.forEach(({ id, label }) => container.appendChild(makeItem(id, label)));

  const backendHost = backendContainer || container;
  backendHost.appendChild(makeBackendButton('ss-forge', 'Stable Diffusion', '/api/free_forge'));
  backendHost.appendChild(makeBackendButton('ss-comfy', 'ComfyUI',          '/api/free_comfyui'));
  backendHost.appendChild(makeBackendButton('ss-embedding', 'Embedding',    '/api/free_embedding'));
  backendHost.appendChild(makeLlmButton());

  function setBar(id, pct) {
    const bar = document.getElementById(`${id}-bar`);
    if (!bar) return;
    bar.style.width = `${Math.min(pct, 100)}%`;
    bar.className   = 'sstat-bar' + (pct >= 90 ? ' danger' : pct >= 70 ? ' high' : '');
  }

  function setVal(id, text) {
    const el = document.getElementById(`${id}-val`);
    if (el) el.textContent = text;
  }

  function setBackendButtonVal(id, status) {
    const btnEl    = document.getElementById(`${id}-btn`);
    const ejectBtn = document.getElementById(`${id}-eject`);
    if (!btnEl) return;
    const state = backendState(status);
    btnEl.className = `topbar-backend-btn ${state.cls}`;
    btnEl.title     = state.title;
    if (ejectBtn) ejectBtn.disabled = !(
      state.cls === 'is-ready' || state.cls === 'is-busy' || state.cls === 'is-external'
    );
  }

  const vramColors = {
    llmModel: '#f59e0b',
    llmKv: '#38bdf8',
    llmCompute: '#a78bfa',
    llmPrompt: '#22c55e',
    llmOther: '#f97316',
    comfy: '#ec4899',
    forge: '#ef4444',
    embedding: '#14b8a6',
    other: '#64748b',
    unclassified: '#94a3b8',
    free: '#262626',
  };

  function gib(mib) {
    return `${(Number(mib || 0) / 1024).toFixed(1)} GB`;
  }

  function addVramSegment(segments, label, mib, color, estimated = false) {
    if (!mib || mib <= 0) return;
    segments.push({ label, mib, color, estimated });
  }

  function renderVramDebug(data) {
    if (!vramBar || !vramLegend || !vramTitle) return;
    const groups = data?.groups_mib || {};
    const llm = data?.llm || {};
    const parts = llm.parts_mib || {};
    const llmTotal = Number(llm.total_mib || groups.LLM || 0);
    const segments = [];

    addVramSegment(segments, 'LLM model', parts.model_gpu, vramColors.llmModel, true);
    addVramSegment(segments, 'LLM KV cache', parts.kv_cache, vramColors.llmKv, true);
    addVramSegment(segments, 'LLM compute', parts.compute, vramColors.llmCompute, true);
    addVramSegment(segments, 'LLM prompt cache', parts.prompt_cache, vramColors.llmPrompt, true);
    addVramSegment(segments, 'LLM other', parts.other, vramColors.llmOther, true);
    addVramSegment(segments, 'ComfyUI', groups.ComfyUI, vramColors.comfy);
    addVramSegment(segments, 'Stable Diffusion', groups['Stable Diffusion'], vramColors.forge);
    addVramSegment(segments, 'Embedding', groups.Embedding, vramColors.embedding);
    addVramSegment(segments, 'Other', groups.Other, vramColors.other);

    const gpuTotal = Number(data?.total_mib || 0);
    const gpuUsed = Number(data?.used_mib || 0);
    const visibleUsed = segments.reduce((sum, item) => sum + item.mib, 0);
    if (gpuUsed > visibleUsed) {
      addVramSegment(segments, 'Used / unclassified', gpuUsed - visibleUsed, vramColors.unclassified);
    }
    if (gpuTotal > gpuUsed) {
      addVramSegment(segments, 'Free', gpuTotal - gpuUsed, vramColors.free);
    }
    const total = gpuTotal > 0 ? gpuTotal : (segments.reduce((sum, item) => sum + item.mib, 0) || 1);
    vramTitle.textContent = `VRAM breakdown${gpuTotal ? ` / GPU ${gib(gpuTotal)}` : ''}${llm.model ? ` / ${shortModelName(llm.model)}` : ''}${llmTotal ? ` / LLM ${gib(llmTotal)}` : ''}`;
    vramBar.innerHTML = segments.map(item => (
      `<div class="vram-debug-segment" title="${item.label}: ${gib(item.mib)}${item.estimated ? ' (推定)' : ''}" style="width:${(item.mib / total) * 100}%;background:${item.color}"></div>`
    )).join('');
    vramLegend.innerHTML = segments.map(item => (
      `<span class="vram-debug-legend-item"><span class="vram-debug-swatch" style="background:${item.color}"></span>${item.label}: ${gib(item.mib)}${item.estimated ? ' 推定' : ''}</span>`
    )).join('');
  }

  async function refreshVramDebug() {
    if (!vramPanel || vramPanel.hidden) return;
    try {
      const resp = await fetch('/api/vram_debug');
      if (resp.ok) renderVramDebug(await resp.json());
    } catch (_) {}
  }

  if (vramToggle && vramPanel) {
    vramToggle.addEventListener('click', () => {
      vramPanel.hidden = !vramPanel.hidden;
      vramToggle.classList.toggle('is-active', !vramPanel.hidden);
      if (!vramPanel.hidden) void refreshVramDebug();
    });
    setInterval(refreshVramDebug, 3000);
  }

  async function poll() {
    try {
      const [statsResp, forgeResp, comfyResp, embeddingResp, llmResp] = await Promise.all([
        fetch('/api/system_stats'),
        fetch('/api/forge_status'),
        fetch('/api/comfyui_status'),
        fetch('/api/library/embedding_status'),
        fetch('/api/llm_status'),
      ]);
      if (!statsResp.ok) return;
      const d = await statsResp.json();

      if (d.gpu_util  != null) { setBar('ss-gpu',  d.gpu_util); setVal('ss-gpu',  `${Math.round(d.gpu_util)}%`); }
      if (d.vram_used != null && d.vram_total != null) {
        setBar('ss-vram', (d.vram_used / d.vram_total) * 100);
        setVal('ss-vram', `${d.vram_used}/${d.vram_total} GB`);
      }
      if (d.cpu_util  != null) { setBar('ss-cpu',  d.cpu_util); setVal('ss-cpu',  `${Math.round(d.cpu_util)}%`); }
      if (d.ram_used  != null && d.ram_total  != null) {
        setBar('ss-ram', (d.ram_used / d.ram_total) * 100);
        setVal('ss-ram', `${d.ram_used}/${d.ram_total} GB`);
      }
      if (forgeResp.ok) setBackendButtonVal('ss-forge', await forgeResp.json());
      if (comfyResp.ok) setBackendButtonVal('ss-comfy', await comfyResp.json());
      if (embeddingResp.ok) setBackendButtonVal('ss-embedding', await embeddingResp.json());
      if (llmResp.ok)   setLlmVal(await llmResp.json());
    } catch (_) {}
  }

  poll();
  setInterval(poll, 1000);
}
