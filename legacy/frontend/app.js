'use strict';

import { initDropdowns, loadSettings, registerSettingsListeners, updateBackendVisibility } from './modules/settings.js';
import { initSnippetAutocomplete } from './modules/snippets.js';
import { autoResizePositive, registerImagePanelListeners } from './modules/image-panel.js';
import { registerVideoPanelListeners } from './modules/video-panel.js';
import { renderGenerationQueue, registerGenerationListeners } from './modules/generation.js';
import { registerChatListeners, setRefreshLlmStatus } from './modules/chat.js';
import { initLlmModal } from './modules/llm-modal.js';
import { initSystemStats, refreshLlmStatus } from './modules/status-bar.js';

// ---------------------------------------------------------------------------
// Page navigation
// ---------------------------------------------------------------------------
const ACTIVE_PAGE_KEY    = 'active-page-v1';
const ACCORDION_STATE_KEY = 'accordion-state-v1';

function initPageNavigation() {
  const tabs  = Array.from(document.querySelectorAll('.topbar-tab[data-page-target]'));
  const pages = Array.from(document.querySelectorAll('.block'));
  if (tabs.length === 0 || pages.length === 0) return;

  const validPageIds = new Set(pages.map(p => p.id));

  function showPage(pageId, shouldSave = true) {
    const nextId = validPageIds.has(pageId) ? pageId : 'tab-image';
    pages.forEach(p => {
      const active = p.id === nextId;
      p.classList.toggle('is-active', active);
      p.setAttribute('aria-hidden', String(!active));
    });
    tabs.forEach(t => {
      const active = t.dataset.pageTarget === nextId;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-pressed', String(active));
    });
    if (shouldSave) {
      try { localStorage.setItem(ACTIVE_PAGE_KEY, nextId); } catch (_) {}
    }
  }

  tabs.forEach(tab => tab.addEventListener('click', () => showPage(tab.dataset.pageTarget)));

  let savedPageId = 'tab-image';
  try { savedPageId = localStorage.getItem(ACTIVE_PAGE_KEY) || savedPageId; } catch (_) {}
  showPage(savedPageId, false);
}

function initAccordionState() {
  const accordions = Array.from(document.querySelectorAll('details.accordion[data-accordion-id]'));
  if (accordions.length === 0) return;

  let savedState = {};
  try {
    const raw = localStorage.getItem(ACCORDION_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') savedState = parsed;
    }
  } catch (_) {}

  accordions.forEach(accordion => {
    const id = accordion.dataset.accordionId;
    if (!id) return;
    if (Object.prototype.hasOwnProperty.call(savedState, id)) accordion.open = Boolean(savedState[id]);
    accordion.addEventListener('toggle', () => {
      try {
        const raw = localStorage.getItem(ACCORDION_STATE_KEY);
        const next = raw ? JSON.parse(raw) : {};
        next[id] = accordion.open;
        localStorage.setItem(ACCORDION_STATE_KEY, JSON.stringify(next));
      } catch (_) {}
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function init() {
  // Wire up refreshLlmStatus callback before chat listeners register
  setRefreshLlmStatus(refreshLlmStatus);

  // Register all event listeners
  registerSettingsListeners();
  registerImagePanelListeners();
  registerVideoPanelListeners();
  registerGenerationListeners();
  registerChatListeners();
  initLlmModal();
  initSystemStats();

  // Load data
  try {
    await initDropdowns();
    await loadSettings();
    await initSnippetAutocomplete(
      document.getElementById('positive-prompt'),
      document.getElementById('positive-prompt')?.closest('.textarea-wrap'),
      document.getElementById('negative-prompt'),
      document.getElementById('negative-prompt')?.closest('.textarea-wrap'),
    );
  } catch (e) {
    console.error('初期化エラー:', e);
  }

  autoResizePositive();
  updateBackendVisibility();
  initAccordionState();
  initPageNavigation();
  renderGenerationQueue();

  document.getElementById('stop-btn').disabled       = true;
  document.getElementById('stop-video-btn').disabled = true;
}

init();
