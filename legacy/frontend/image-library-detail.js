'use strict';

const params = new URLSearchParams(location.search);
const imageId = Number(params.get('id') || 0);

const imageEl = document.getElementById('detail-image');
const titleEl = document.getElementById('detail-title');
const metaEl = document.getElementById('detail-meta');
const statusEl = document.getElementById('detail-status');
const captionInput = document.getElementById('detail-caption');
const tagsInput = document.getElementById('detail-tags');
const positiveInput = document.getElementById('detail-positive');
const negativeInput = document.getElementById('detail-negative');
const notesInput = document.getElementById('detail-notes');
const captionPromptSelect = document.getElementById('detail-caption-prompt');
const captionPromptNameInput = document.getElementById('caption-prompt-name');
const captionPromptSystemInput = document.getElementById('caption-prompt-system');
const captionPromptUserInput = document.getElementById('caption-prompt-user');
const rawEl = document.getElementById('detail-raw');
const useBtn = document.getElementById('detail-use-btn');

let item = null;
let captionPrompts = [];

const LAST_PROMPT_KEY = 'library_last_caption_prompt';

function setStatus(text, isError = false) {
  statusEl.textContent = text || '';
  statusEl.style.color = isError ? 'var(--danger)' : '';
}

function fill(data) {
  item = data;
  imageEl.src = `/api/library/images/${item.id}/file`;
  titleEl.textContent = item.filename || `Image #${item.id}`;
  metaEl.textContent = `${item.width || '-'} x ${item.height || '-'} / ${item.file_path || ''}`;
  captionInput.value = item.caption || '';
  tagsInput.value = Array.isArray(item.tags) ? item.tags.join(', ') : (item.tags || '');
  positiveInput.value = item.positive_prompt || '';
  negativeInput.value = item.negative_prompt || '';
  notesInput.value = item.notes || '';
  rawEl.textContent = JSON.stringify(item.raw_metadata || {}, null, 2);
}

function payload() {
  return {
    caption: captionInput.value,
    tags: tagsInput.value.split(/[,\n、]/).map(tag => tag.trim()).filter(Boolean),
    positive_prompt: positiveInput.value,
    negative_prompt: negativeInput.value,
    notes: notesInput.value,
  };
}

function activeCaptionPrompt() {
  return captionPrompts.find(prompt => prompt.id === captionPromptSelect.value) || null;
}

function renderCaptionPromptSelect(preferredId = '') {
  captionPromptSelect.innerHTML = captionPrompts.map(prompt => (
    `<option value="${prompt.id}">${prompt.name || prompt.id}</option>`
  )).join('');
  if (preferredId && captionPrompts.some(prompt => prompt.id === preferredId)) {
    captionPromptSelect.value = preferredId;
  } else if (!captionPromptSelect.value && captionPrompts[0]) {
    captionPromptSelect.value = captionPrompts[0].id;
  }
  fillCaptionPromptEditor();
}

function fillCaptionPromptEditor() {
  const prompt = activeCaptionPrompt();
  captionPromptNameInput.value = prompt?.name || '';
  captionPromptSystemInput.value = prompt?.system_prompt || '';
  captionPromptUserInput.value = prompt?.user_prompt || '';
}

async function loadCaptionPrompts(preferredId = '') {
  const data = await fetch('/api/library/caption_prompts').then(r => r.json());
  captionPrompts = Array.isArray(data.prompts) ? data.prompts : [];
  renderCaptionPromptSelect(preferredId || localStorage.getItem(LAST_PROMPT_KEY) || '');
}

async function load() {
  if (!imageId) {
    setStatus('画像 ID がありません', true);
    return;
  }
  const resp = await fetch(`/api/library/images/${imageId}`);
  if (!resp.ok) {
    setStatus(await resp.text(), true);
    return;
  }
  fill(await resp.json());
}

async function save() {
  setStatus('保存中...');
  const resp = await fetch(`/api/library/images/${imageId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload()),
  });
  if (!resp.ok) {
    setStatus(await resp.text(), true);
    return null;
  }
  const data = await resp.json();
  fill(data.image);
  setStatus('保存しました');
  return data.image;
}

async function reindexOnly() {
  setStatus('再インデックス化中...');
  const resp = await fetch(`/api/library/images/${imageId}/reindex`, { method: 'POST' });
  if (!resp.ok) {
    setStatus(await resp.text(), true);
    return null;
  }
  const data = await resp.json();
  fill(data.image);
  setStatus(data.message || '再インデックス化しました');
  return data.image;
}

async function saveAndReindex() {
  const saved = await save();
  if (!saved) return;
  await reindexOnly();
}

function useImage() {
  if (!imageId) return;
  window.parent?.parent?.postMessage({ type: 'use-library-image', imageId }, window.location.origin);
  setStatus(`Image #${imageId} sent to image panel`);
}

async function updateCaption() {
  await save();
  setStatus('Caption 生成中...');
  const previousCaption = captionInput.value;
  captionInput.value = '';

  const resp = await fetch(`/api/library/images/${imageId}/caption/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caption_prompt_id: captionPromptSelect.value }),
  });
  if (!resp.ok) {
    setStatus(await resp.text(), true);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let generatedText = '';

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
        if (event.type === 'token') {
          generatedText += event.content;
        } else if (event.type === 'done') {
          if (event.image) {
            fill(event.image);
          } else {
            captionInput.value = generatedText;
          }
          setStatus('Caption を更新しました');
        } else if (event.type === 'error') {
          captionInput.value = previousCaption;
          setStatus(event.content, true);
          return;
        }
      } catch (_) {}
    }
  }
}

async function saveCaptionPrompt() {
  const current = activeCaptionPrompt();
  const payload = {
    id: current?.id || '',
    name: captionPromptNameInput.value,
    system_prompt: captionPromptSystemInput.value,
    user_prompt: captionPromptUserInput.value,
  };
  const resp = await fetch('/api/library/caption_prompts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    setStatus(await resp.text(), true);
    return;
  }
  const data = await resp.json();
  captionPrompts = data.prompts || [];
  renderCaptionPromptSelect(data.prompt?.id || '');
  setStatus('Caption プロンプトを保存しました');
}

function newCaptionPrompt() {
  captionPromptSelect.value = '';
  captionPromptNameInput.value = '新しい Caption プロンプト';
  captionPromptSystemInput.value = '';
  captionPromptUserInput.value = 'この画像をライブラリ登録用に説明してください。';
  captionPromptNameInput.focus();
}

async function deleteCaptionPrompt() {
  const current = activeCaptionPrompt();
  if (!current) return;
  if (!window.confirm(`Caption プロンプト「${current.name || current.id}」を削除しますか？`)) return;
  const resp = await fetch(`/api/library/caption_prompts/${encodeURIComponent(current.id)}`, {
    method: 'DELETE',
  });
  if (!resp.ok) {
    setStatus(await resp.text(), true);
    return;
  }
  const data = await resp.json();
  captionPrompts = data.prompts || [];
  renderCaptionPromptSelect();
  setStatus('Caption プロンプトを削除しました');
}

document.getElementById('detail-save-btn').addEventListener('click', saveAndReindex);
document.getElementById('detail-caption-btn').addEventListener('click', updateCaption);
useBtn?.addEventListener('click', useImage);
document.getElementById('caption-prompt-save-btn').addEventListener('click', saveCaptionPrompt);
document.getElementById('caption-prompt-new-btn').addEventListener('click', newCaptionPrompt);
document.getElementById('caption-prompt-delete-btn').addEventListener('click', deleteCaptionPrompt);
captionPromptSelect.addEventListener('change', () => {
  fillCaptionPromptEditor();
  localStorage.setItem(LAST_PROMPT_KEY, captionPromptSelect.value);
});
Promise.all([loadCaptionPrompts(), load()]).catch(err => setStatus(String(err), true));
