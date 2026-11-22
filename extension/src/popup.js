// ===================================================================
// popup.js — UI only (spec §6). The popup never runs auth and never
// touches Drive: it talks to the service worker by message and the
// worker does the work. All user data reaches the DOM via textContent;
// the popup builds no markup from user data.
//
// Guards (spec §7, the app's standing rule): every mutating control
// disables itself until its write settles; Done guards per habit ID.
// A failed write keeps the typed text and shows the error.
// ===================================================================

import { VARIANT } from './variant.js';
import { makeT, pickLang } from './i18n.js';
import { buildCaptureText, TODO_PRIORITIES } from './data.js';

const t = makeT(pickLang(chrome.i18n.getUILanguage()));

const $ = (id) => document.getElementById(id);
const els = {
  appName: $('appName'),
  variantTag: $('variantTag'),
  accountLine: $('accountLine'),
  confirmBox: $('confirmBox'),
  confirmText: $('confirmText'),
  confirmHint: $('confirmHint'),
  confirmBtn: $('confirmBtn'),
  signedOutBox: $('signedOutBox'),
  signInHint: $('signInHint'),
  signInBtn: $('signInBtn'),
  mainBox: $('mainBox'),
  quickAddTitle: $('quickAddTitle'),
  todoText: $('todoText'),
  todoCategory: $('todoCategory'),
  todoPriority: $('todoPriority'),
  todoDue: $('todoDue'),
  categoryLabel: $('categoryLabel'),
  priorityLabel: $('priorityLabel'),
  dueDateLabel: $('dueDateLabel'),
  addBtn: $('addBtn'),
  savePageBtn: $('savePageBtn'),
  pageTitle: $('pageTitle'),
  dueTitle: $('dueTitle'),
  loadingHabits: $('loadingHabits'),
  habitList: $('habitList'),
  noHabits: $('noHabits'),
  statusLine: $('statusLine'),
  openAppBtn: $('openAppBtn'),
  signOutBtn: $('signOutBtn'),
};

const pendingDone = new Set();
let currentTab = null;

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res || !res.ok) return reject(new Error(res?.error || 'The extension failed.'));
      resolve(res);
    });
  });
}

function showStatus(message, isError = false) {
  els.statusLine.textContent = message || '';
  els.statusLine.classList.toggle('error', isError);
}

function setTexts() {
  els.appName.textContent = VARIANT.name;
  if (VARIANT.isDev) {
    els.variantTag.hidden = false;
    els.variantTag.textContent = 'DEV';
  }
  els.confirmText.textContent = t('confirmAccount');
  els.confirmHint.textContent = t('confirmAccountHint');
  els.confirmBtn.textContent = t('confirmButton');
  els.signInHint.textContent = t('signInHint');
  els.signInBtn.textContent = t('signIn');
  els.quickAddTitle.textContent = t('quickAdd');
  els.todoText.placeholder = t('todoPlaceholder');
  els.categoryLabel.textContent = t('categoryLabel');
  els.priorityLabel.textContent = t('priorityLabel');
  els.dueDateLabel.textContent = t('dueDateLabel');
  els.addBtn.textContent = t('addButton');
  els.savePageBtn.textContent = t('savePage');
  els.dueTitle.textContent = t('dueHabits');
  els.loadingHabits.textContent = t('loading');
  els.noHabits.textContent = t('noDueHabits');
  els.openAppBtn.textContent = t('openApp');
  els.signOutBtn.textContent = t('signOut');
  for (const p of TODO_PRIORITIES) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    els.todoPriority.appendChild(opt);
  }
  els.todoPriority.value = 'normal';
}

function fillCategories(categories, defaultCategoryId) {
  els.todoCategory.replaceChildren();
  const general = document.createElement('option');
  general.value = defaultCategoryId || '';
  general.textContent = t('generalCategory');
  els.todoCategory.appendChild(general);
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    els.todoCategory.appendChild(opt);
  }
  els.todoCategory.value = defaultCategoryId || '';
}

function renderHabits(habits, today) {
  els.loadingHabits.hidden = true;
  els.habitList.replaceChildren();
  els.noHabits.hidden = habits.length !== 0;
  for (const h of habits) {
    const li = document.createElement('li');
    li.className = 'habit-row';
    const name = document.createElement('span');
    name.className = 'habit-name';
    name.textContent = h.name || '';
    li.appendChild(name);
    if (h.next_due && h.next_due < today) {
      const badge = document.createElement('span');
      badge.className = 'overdue-badge';
      badge.textContent = t('overdue');
      li.appendChild(badge);
    }
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.dataset.habitId = h.id;
    btn.textContent = t('doneButton');
    btn.disabled = pendingDone.has(h.id);
    btn.addEventListener('click', () => markHabitDone(h.id, btn, li));
    li.appendChild(btn);
    els.habitList.appendChild(li);
  }
}

async function markHabitDone(habitId, btn, li) {
  if (pendingDone.has(habitId)) return;
  pendingDone.add(habitId);
  btn.disabled = true;
  btn.classList.add('is-pending');
  btn.setAttribute('aria-busy', 'true');
  showStatus('');
  try {
    await sendMessage({ type: 'markHabitDone', habitId });
    li.remove();
    if (els.habitList.children.length === 0) els.noHabits.hidden = false;
    showStatus(t('habitDoneOk'));
  } catch (e) {
    showStatus(e.message, true);
  } finally {
    pendingDone.delete(habitId);
    btn.disabled = false;
    btn.classList.remove('is-pending');
    btn.removeAttribute('aria-busy');
  }
}

async function addTodo() {
  const text = els.todoText.value.trim();
  if (!text || els.addBtn.disabled) return;
  els.addBtn.disabled = true;
  els.addBtn.classList.add('is-pending');
  els.addBtn.setAttribute('aria-busy', 'true');
  showStatus(t('adding'));
  try {
    await sendMessage({
      type: 'quickAdd',
      text,
      priority: els.todoPriority.value || 'normal',
      categoryId: els.todoCategory.value || null,
      dueDate: els.todoDue.value || null,
    });
    els.todoText.value = '';
    els.todoDue.value = '';
    showStatus(t('addedOk'));
  } catch (e) {
    // The typed text stays put — nothing is dropped silently.
    showStatus(e.message, true);
  } finally {
    els.addBtn.disabled = false;
    els.addBtn.classList.remove('is-pending');
    els.addBtn.removeAttribute('aria-busy');
    els.todoText.focus();
  }
}

async function loadPopupData() {
  els.loadingHabits.hidden = false;
  try {
    const data = await sendMessage({ type: 'getPopupData' });
    fillCategories(data.categories, data.defaultCategoryId);
    renderHabits(data.dueHabits, data.today);
  } catch (e) {
    els.loadingHabits.hidden = true;
    showStatus(e.message, true);
  }
}

async function refresh() {
  showStatus('');
  els.confirmBox.hidden = true;
  els.signedOutBox.hidden = true;
  els.mainBox.hidden = true;
  els.signOutBtn.hidden = true;
  let status;
  try {
    status = await sendMessage({ type: 'getStatus' });
  } catch (e) {
    showStatus(e.message, true);
    return;
  }
  if (!status.signedIn) {
    els.signedOutBox.hidden = false;
    els.accountLine.textContent = '';
    return;
  }
  els.signOutBtn.hidden = false;
  els.accountLine.textContent = status.email ? `${t('signedInAs')} ${status.email}` : '';
  if (!status.confirmed) {
    els.confirmBox.hidden = false;
    return;
  }
  els.mainBox.hidden = false;
  await loadPopupData();
  await loadCurrentTab();
}

async function loadCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.title) return;
    currentTab = tab;
    els.pageTitle.textContent = tab.title;
  } catch (_) {
    // activeTab may not cover this tab; capture stays unavailable.
  }
}

function wireEvents() {
  els.signInBtn.addEventListener('click', async () => {
    els.signInBtn.disabled = true;
    try {
      await sendMessage({ type: 'signIn' });
      await refresh();
    } catch (e) {
      showStatus(e.message, true);
    } finally {
      els.signInBtn.disabled = false;
    }
  });
  els.confirmBtn.addEventListener('click', async () => {
    els.confirmBtn.disabled = true;
    try {
      const status = await sendMessage({ type: 'getStatus' });
      await sendMessage({ type: 'confirmAccount', email: status.email });
      await refresh();
    } catch (e) {
      showStatus(e.message, true);
    } finally {
      els.confirmBtn.disabled = false;
    }
  });
  els.signOutBtn.addEventListener('click', async () => {
    try {
      await sendMessage({ type: 'signOut' });
    } catch (_) { /* already signed out locally */ }
    await refresh();
  });
  els.openAppBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: VARIANT.appUrl });
  });
  els.addBtn.addEventListener('click', addTodo);
  els.todoText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTodo();
  });
  els.savePageBtn.addEventListener('click', () => {
    if (!currentTab) return;
    els.todoText.value = buildCaptureText(currentTab.title, currentTab.url);
    els.todoText.focus();
  });
}

// Theme follows the OS preference; the app's own variables come from
// style.css, injected by the packaging script.
if (window.matchMedia('(prefers-color-scheme: light)').matches) {
  document.documentElement.setAttribute('data-theme', 'light');
}
setTexts();
wireEvents();
refresh();
