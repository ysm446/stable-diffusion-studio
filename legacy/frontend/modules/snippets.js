'use strict';

import { escapeHtml } from './utils.js';
import { scheduleSave } from './settings.js';

let snippetCatalog = [];

function getSnippetQueryInfo(textarea) {
  const caret = textarea.selectionStart ?? 0;
  const before = textarea.value.slice(0, caret);
  const segmentStart = Math.max(
    before.lastIndexOf(',') + 1,
    before.lastIndexOf('\n') + 1,
  );
  let queryStart = segmentStart;
  while (queryStart < before.length && /\s/.test(before[queryStart])) queryStart++;
  const query = before.slice(queryStart).trim();
  if (!query || query.includes(':')) return null;
  return { query, start: queryStart, end: caret };
}

function createSnippetState(textarea, wrap) {
  if (!textarea || !wrap) return null;
  const menu = document.createElement('div');
  menu.className = 'snippet-menu';
  wrap.appendChild(menu);
  return { textarea, menu, activeItems: [], activeIndex: -1, queryRange: null, hideTimer: null, matches: [] };
}

function hideSnippetMenu(state) {
  if (!state) return;
  state.menu.classList.remove('is-open');
  state.menu.innerHTML = '';
  state.activeItems = [];
  state.activeIndex = -1;
  state.queryRange = null;
  state.matches = [];
}

function setActiveSnippet(state, index) {
  state.activeIndex = index;
  state.activeItems.forEach((item, idx) => {
    item.classList.toggle('is-active', idx === index);
    if (idx === index) item.scrollIntoView({ block: 'nearest' });
  });
}

function applySnippet(state, item) {
  if (!state?.textarea || !state.queryRange) return;
  const value = state.textarea.value;
  const before = value.slice(0, state.queryRange.start);
  const after  = value.slice(state.queryRange.end);
  const insert = item.body;
  const suffix = after.trimStart().startsWith(',') || !after.trim() ? ', ' : '';
  state.textarea.value = before + insert + suffix + after;
  const caret = (before + insert + suffix).length;
  state.textarea.focus();
  state.textarea.setSelectionRange(caret, caret);
  hideSnippetMenu(state);
  scheduleSave();
}

function rankSnippetMatches(items, query) {
  const q = query.toLowerCase();
  return items
    .map(item => {
      const prefix = item.prefix.toLowerCase();
      const starts    = prefix.startsWith(q);
      const wordStarts = prefix.split(/\s+/).some(part => part.startsWith(q));
      const pos = prefix.indexOf(q);
      return { item, starts, wordStarts, pos };
    })
    .sort((a, b) => (
      Number(b.starts) - Number(a.starts)
      || Number(b.wordStarts) - Number(a.wordStarts)
      || a.pos - b.pos
      || a.item.prefix.localeCompare(b.item.prefix)
    ))
    .map(e => e.item);
}

function renderSnippetMenu(state, items) {
  state.matches = items;
  state.menu.innerHTML = items.map((item, index) => `
    <button type="button" class="snippet-item${index === 0 ? ' is-active' : ''}" data-index="${index}">
      <span class="snippet-prefix">${escapeHtml(item.prefix)}</span>
      <span class="snippet-source">${escapeHtml(item.source.replace('.code-snippets', ''))}</span>
      <span class="snippet-description">${escapeHtml(item.description || item.name)}</span>
    </button>
  `).join('');
  state.activeItems = Array.from(state.menu.querySelectorAll('.snippet-item'));
  state.activeIndex = items.length ? 0 : -1;
  state.activeItems.forEach(button => {
    button.addEventListener('mousedown', e => e.preventDefault());
    button.addEventListener('click', () => applySnippet(state, items[Number(button.dataset.index)]));
  });
  state.menu.classList.toggle('is-open', items.length > 0);
}

function updateSnippetSuggestions(state) {
  if (!state?.textarea || snippetCatalog.length === 0) return;
  const info = getSnippetQueryInfo(state.textarea);
  if (!info || info.query.length < 2) { hideSnippetMenu(state); return; }
  const q = info.query.toLowerCase();
  const items = rankSnippetMatches(
    snippetCatalog.filter(item => item.prefix.toLowerCase().includes(q)),
    info.query,
  ).slice(0, 8);
  if (items.length === 0) { hideSnippetMenu(state); return; }
  state.queryRange = info;
  renderSnippetMenu(state, items);
}

function bindSnippetAutocomplete(state) {
  if (!state?.textarea) return;
  state.textarea.addEventListener('input',  () => updateSnippetSuggestions(state));
  state.textarea.addEventListener('click',  () => updateSnippetSuggestions(state));
  state.textarea.addEventListener('focus',  () => updateSnippetSuggestions(state));
  state.textarea.addEventListener('blur',   () => {
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => hideSnippetMenu(state), 120);
  });
  state.menu.addEventListener('mouseenter', () => clearTimeout(state.hideTimer));
  state.textarea.addEventListener('keydown', event => {
    if (!state.menu.classList.contains('is-open') || state.activeItems.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSnippet(state, (state.activeIndex + 1) % state.activeItems.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSnippet(state, (state.activeIndex - 1 + state.activeItems.length) % state.activeItems.length);
    } else if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      const item = state.matches[state.activeIndex];
      if (item) applySnippet(state, item);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideSnippetMenu(state);
    }
  });
}

export async function initSnippetAutocomplete(positiveInput, positiveWrap, negativeInput, negativeWrap) {
  const states = [
    createSnippetState(positiveInput, positiveWrap),
    createSnippetState(negativeInput, negativeWrap),
  ].filter(Boolean);
  if (states.length === 0) return;
  try {
    const resp = await fetch('/api/snippets');
    const data = await resp.json();
    snippetCatalog = Array.isArray(data.snippets) ? data.snippets : [];
  } catch (_) {
    snippetCatalog = [];
  }
  states.forEach(bindSnippetAutocomplete);
}
