'use strict';

import { setLlmVal } from './status-bar.js';

export function initLlmModal() {
  const modal   = document.getElementById('llm-model-modal');
  if (!modal) return;
  const list     = document.getElementById('llm-model-list');
  const statusEl = document.getElementById('llm-modal-status');
  const modelDd  = document.getElementById('model-dropdown');

  function open()  { renderList(); modal.classList.add('is-open');    modal.setAttribute('aria-hidden', 'false'); }
  function close() {               modal.classList.remove('is-open'); modal.setAttribute('aria-hidden', 'true');  }

  function renderList() {
    list.innerHTML = '';
    const current = modelDd?.value || '';
    const presets = modelDd ? Array.from(modelDd.options).map(o => o.value) : [];
    if (presets.length === 0) {
      const li = document.createElement('li');
      li.innerHTML = '<button type="button" disabled>モデルが見つかりません</button>';
      list.appendChild(li);
      return;
    }
    for (const preset of presets) {
      const li  = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = preset;
      if (preset === current) btn.classList.add('is-current');
      btn.addEventListener('click', () => selectModel(preset));
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  async function selectModel(preset) {
    if (!modelDd) return;
    close();
    setLlmVal({ process_running: true, model: preset });
    if (modelDd.value !== preset) {
      modelDd.value = preset;
      modelDd.dispatchEvent(new Event('change'));
    }
    try {
      const resp = await fetch('/api/load_model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_label: preset }),
      }).then(r => r.json());
      const statusFallback = document.getElementById('model-status');
      if (statusFallback) statusFallback.textContent = resp.message || '';
    } catch (_) {}
  }

  modal.addEventListener('click', e => { if (e.target.matches('[data-llm-close]')) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) close();
  });

  document.addEventListener('click', e => {
    if (e.target.closest('#topbar-llm-btn')) { e.preventDefault(); open(); return; }
    const eject = e.target.closest('#topbar-llm-eject');
    if (eject && !eject.disabled) {
      e.preventDefault();
      eject.disabled = true;
      fetch('/api/unload_qwen', { method: 'POST' })
        .then(r => r.json())
        .then(resp => {
          const fallback = document.getElementById('model-status');
          if (fallback) fallback.textContent = resp.message || '';
        })
        .catch(() => {})
        .finally(() => { eject.disabled = false; });
    }
  });
}
