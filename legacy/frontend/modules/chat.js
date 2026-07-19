'use strict';

import { fetchSSE, renderMd, CTX_STEPS, CTX_LABELS } from './utils.js';
import { scheduleSave } from './settings.js';
import { autoResizePositive } from './image-panel.js';

// ---------------------------------------------------------------------------
// Chat UI
// ---------------------------------------------------------------------------
const chatbot   = document.getElementById('chatbot');
const userInput = document.getElementById('user-input');

function autoResizeUserInput() {
  userInput.style.height = 'auto';
  userInput.style.height = userInput.scrollHeight + 'px';
}

function appendMessage(role, content) {
  const div = document.createElement('div');
  div.className = `chat-message ${role}`;
  if (role === 'user') {
    const roleLabel = document.createElement('div');
    roleLabel.className = 'chat-role';
    roleLabel.textContent = 'あなた';
    div.appendChild(roleLabel);
  }
  const contentDiv = document.createElement('div');
  contentDiv.className = 'chat-content';
  contentDiv.textContent = content;
  div.appendChild(contentDiv);
  chatbot.appendChild(div);
  chatbot.scrollTop = chatbot.scrollHeight;
  return contentDiv;
}

let chatAbortCtrl = null;

async function sendChat() {
  const text = userInput.value.trim();
  if (!text) return;

  if (chatAbortCtrl) chatAbortCtrl.abort();
  chatAbortCtrl = new AbortController();

  userInput.value = '';
  autoResizeUserInput();
  document.getElementById('send-btn').disabled = true;

  appendMessage('user', text);
  const assistantContent = appendMessage('assistant', '');
  let partial = '';

  try {
    await fetchSSE('/api/chat/stream', {
      user_input:            text,
      model_label:           document.getElementById('model-dropdown').value,
      positive:              document.getElementById('positive-prompt').value,
      negative:              document.getElementById('negative-prompt').value,
      chat_prompt_id:        document.getElementById('chat-prompt-select')?.value || 'review',
      library_context_limit: parseInt(document.getElementById('library-limit')?.value || '5'),
      library_search_mode:   document.getElementById('library-search-mode')?.value || 'vector',
      max_tokens:            CTX_STEPS[parseInt(document.getElementById('chat-context-slider')?.value || '0')] || 4096,
    }, data => {
      if (data.type === 'token') {
        partial += data.content;
        assistantContent.textContent = partial;
        chatbot.scrollTop = chatbot.scrollHeight;
      } else if (data.type === 'model_loaded') {
        document.getElementById('model-status').textContent = data.message;
        refreshLlmStatus();
      } else if (data.type === 'done') {
        const finalText = data.display_text ?? partial;
        assistantContent.innerHTML = renderMd(finalText);
        chatbot.scrollTop = chatbot.scrollHeight;
        if (data.positive != null) {
          document.getElementById('positive-prompt').value = data.positive;
          autoResizePositive();
          scheduleSave();
        }
        if (data.negative != null) {
          document.getElementById('negative-prompt').value = data.negative;
          scheduleSave();
        }
      } else if (data.type === 'context_usage') {
        updateCtxGauge(data.total_tokens, data.n_ctx);
      } else if (data.type === 'error') {
        assistantContent.textContent = `エラー: ${data.content}`;
      }
    }, chatAbortCtrl.signal);
  } finally {
    document.getElementById('send-btn').disabled = false;
    chatAbortCtrl = null;
  }
}

function updateCtxGauge(totalTokens, nCtx) {
  const fill   = document.getElementById('ctx-gauge-fill');
  const pctEl  = document.getElementById('ctx-gauge-pct');
  const tipTok = document.getElementById('ctx-tip-tokens');
  const tipLim = document.getElementById('ctx-tip-limit');
  const tipPct = document.getElementById('ctx-tip-pct');
  if (!fill) return;

  const pct = Math.min(100, (totalTokens / nCtx) * 100);
  fill.setAttribute('stroke-dasharray', `${pct.toFixed(2)} 100`);
  if (pctEl)  pctEl.textContent  = `${Math.round(pct)}%`;
  if (tipTok) tipTok.textContent = `会話トークン: ${totalTokens.toLocaleString()}`;
  if (tipLim) tipLim.textContent = `コンテキスト上限: ${nCtx.toLocaleString()}`;
  if (tipPct) tipPct.textContent = `${pct.toFixed(1)}% 使用中（${(100 - pct).toFixed(1)}% 残り）`;
}

function resetCtxGauge() {
  const fill = document.getElementById('ctx-gauge-fill');
  if (fill) fill.setAttribute('stroke-dasharray', '0 100');
  const pctEl = document.getElementById('ctx-gauge-pct');
  if (pctEl) pctEl.textContent = '–';
  ['ctx-tip-tokens', 'ctx-tip-limit', 'ctx-tip-pct'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.textContent = ['会話トークン: –', 'コンテキスト上限: –', '– 使用中（– 残り）'][i];
  });
}

async function clearChat() {
  await fetch('/api/chat/clear', { method: 'POST' });
  chatbot.innerHTML = '';
  resetCtxGauge();
}

// Stub — overridden by status-bar.js after init
let refreshLlmStatus = async () => {};
export function setRefreshLlmStatus(fn) { refreshLlmStatus = fn; }

// ---------------------------------------------------------------------------
// Chat prompt management
// ---------------------------------------------------------------------------
function initChatPrompts() {
  const LAST_KEY  = 'chat_last_system_prompt';
  const selectEl  = document.getElementById('chat-prompt-select');
  const nameEl    = document.getElementById('chat-prompt-name');
  const systemEl  = document.getElementById('chat-prompt-system');
  if (!selectEl) return;

  let prompts = [];

  function renderSelect(preferredId) {
    selectEl.innerHTML = prompts.map(p =>
      `<option value="${p.id}">${p.name || p.id}</option>`
    ).join('');
    const saved = preferredId || localStorage.getItem(LAST_KEY) || '';
    if (saved && prompts.some(p => p.id === saved)) selectEl.value = saved;
    fillEditor();
  }

  function fillEditor() {
    const p = prompts.find(p => p.id === selectEl.value);
    if (nameEl)   nameEl.value   = p?.name          || '';
    if (systemEl) systemEl.value = p?.system_prompt || '';
  }

  async function load(preferredId) {
    const data = await fetch('/api/chat_prompts').then(r => r.json());
    prompts = Array.isArray(data.prompts) ? data.prompts : [];
    renderSelect(preferredId);
  }

  selectEl.addEventListener('change', () => {
    fillEditor();
    localStorage.setItem(LAST_KEY, selectEl.value);
  });

  document.getElementById('chat-prompt-save-btn')?.addEventListener('click', async () => {
    const current = prompts.find(p => p.id === selectEl.value);
    const payload = {
      id:            current?.id || '',
      name:          nameEl?.value || '',
      system_prompt: systemEl?.value || '',
    };
    const resp = await fetch('/api/chat_prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (resp.ok) {
      prompts = resp.prompts || [];
      renderSelect(resp.prompt?.id || '');
    }
  });

  document.getElementById('chat-prompt-new-btn')?.addEventListener('click', () => {
    selectEl.value = '';
    if (nameEl)   nameEl.value   = '新しいプロンプト';
    if (systemEl) systemEl.value = '';
    nameEl?.focus();
  });

  document.getElementById('chat-prompt-delete-btn')?.addEventListener('click', async () => {
    const current = prompts.find(p => p.id === selectEl.value);
    if (!current) return;
    if (!confirm(`「${current.name || current.id}」を削除しますか？`)) return;
    const deletedId = current.id;
    const resp = await fetch(`/api/chat_prompts/${encodeURIComponent(deletedId)}`, {
      method: 'DELETE',
    }).then(r => r.json());
    if (resp.ok) {
      if (localStorage.getItem(LAST_KEY) === deletedId) localStorage.removeItem(LAST_KEY);
      prompts = resp.prompts || [];
      renderSelect(prompts[0]?.id || '');
    }
  });

  load();
}

// Library limit slider (local to chat UI)
function initLibraryLimitSlider() {
  const LIMIT_KEY = 'chat_library_limit';
  const input = document.getElementById('library-limit');
  const valEl = document.getElementById('library-limit-val');
  if (!input || !valEl) return;
  const saved = localStorage.getItem(LIMIT_KEY);
  if (saved) { input.value = saved; valEl.textContent = saved; }
  input.addEventListener('input', () => {
    valEl.textContent = input.value;
    localStorage.setItem(LIMIT_KEY, input.value);
  });
}

function initLibrarySearchMode() {
  const MODE_KEY = 'chat_library_search_mode';
  const select = document.getElementById('library-search-mode');
  if (!select) return;
  const saved = localStorage.getItem(MODE_KEY);
  if (saved) select.value = saved;
  select.addEventListener('change', () => {
    localStorage.setItem(MODE_KEY, select.value);
  });
}

// ---------------------------------------------------------------------------
// Prompt debug modal
// ---------------------------------------------------------------------------
function initPromptDebug() {
  const btn     = document.getElementById('prompt-debug-btn');
  const modal   = document.getElementById('prompt-debug-modal');
  const closeBtn = document.getElementById('prompt-debug-close');
  const body    = document.getElementById('prompt-debug-body');
  if (!btn || !modal) return;

  const ROLE_LABELS = { system: 'System', user: 'User', assistant: 'Assistant' };

  btn.addEventListener('click', async () => {
    const resp = await fetch('/api/debug/last_prompt').then(r => r.json());
    body.innerHTML = '';
    if (!resp.messages?.length) {
      body.innerHTML = '<div style="color:#666;font-size:12px">まだプロンプトは送信されていません。</div>';
    } else {
      for (const msg of resp.messages) {
        const wrap = document.createElement('div');
        wrap.className = `prompt-debug-msg role-${msg.role}`;
        wrap.innerHTML =
          `<div class="prompt-debug-msg-role">${ROLE_LABELS[msg.role] ?? msg.role}</div>` +
          `<div class="prompt-debug-msg-content"></div>`;
        wrap.querySelector('.prompt-debug-msg-content').textContent = msg.content;
        body.appendChild(wrap);
      }
    }
    modal.hidden = false;
  });

  closeBtn.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') modal.hidden = true; });
}

// ---------------------------------------------------------------------------
// Register all event listeners
// ---------------------------------------------------------------------------
export function registerChatListeners() {
  userInput.addEventListener('input', autoResizeUserInput);
  userInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  document.getElementById('send-btn').addEventListener('click', sendChat);
  document.getElementById('clear-btn').addEventListener('click', clearChat);

  // Model load button
  document.getElementById('load-model-btn').addEventListener('click', async () => {
    const btn = document.getElementById('load-model-btn');
    btn.disabled = true;
    document.getElementById('model-status').textContent = 'ロード中...';
    try {
      const resp = await fetch('/api/load_model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_label: document.getElementById('model-dropdown').value }),
      }).then(r => r.json());
      document.getElementById('model-status').textContent = resp.message;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('model-dropdown').addEventListener('change', scheduleSave);

  initChatPrompts();
  initLibraryLimitSlider();
  initLibrarySearchMode();
  initPromptDebug();
}
