// ===================================================================
// batch-import.js — Shared building blocks for batch JSON imports.
//
// Used by the TODO import (js/todos.js) and the Habit import (js/habits.js).
// Pure helpers live in js/import-pure.js (dependency-free, unit-tested).
// This module holds the creation helpers (ensureImportCategories,
// chunkedBatchInsert) and the generic modal shell openBatchImportModal(cfg):
// the two-path (Convert via LLM prompt / Upload JSON) → paste → review →
// create flow. Callers supply translated strings, item validation, review
// fields and the creation logic; the shell owns all the modal mechanics.
// ===================================================================

import state, { SHARED_CATEGORY } from './state.js';
import { esc, nextPaletteColor, showToast, isMobileUA } from './utils.js';
import { lucideIcon } from './icons.js';
import { parseImportArray } from './import-pure.js';
import { isDateOnly } from './calendar-pure.js';

// -------------------------------------------------------------------
// Creation helpers
// -------------------------------------------------------------------

/**
 * Create the missing categories (case-insensitive dedupe) and return a
 * Map of lower-cased name → { id, name } covering all existing categories
 * (shared pseudo-category excluded).
 * { table, getMap: () => Map(id → row), reload: async () => void }
 */
export async function ensureImportCategories(names, { table, getMap, reload, getPathMap, ensurePath }) {
  const result = new Map();
  const indexMap = () => {
    result.clear();
    if (getPathMap) {
      // Nested sections: categories are identified by full path; only
      // buckets can receive items. The entry name stays the bucket's own
      // (last-segment) name for the item's legacy category string.
      for (const [path, row] of getPathMap().entries()) {
        if (row.name === SHARED_CATEGORY || row.kind === 'section') continue;
        result.set(path, { id: row.id, name: row.name });
      }
      return;
    }
    for (const row of getMap().values()) {
      if (row.name === SHARED_CATEGORY) continue;
      result.set(row.name.toLowerCase(), { id: row.id, name: row.name });
    }
  };
  indexMap();
  let created = 0;
  for (const name of names) {
    const l = name.toLowerCase();
    if (result.has(l)) continue;
    if (ensurePath && name.includes('>')) {
      // A new category given as a path: create/convert the section
      // chain, then the bucket, via the view's own helper.
      await ensurePath(name);
      await reload();
      indexMap();
      created++;
      continue;
    }
    const catMap = getMap();
    const color = nextPaletteColor(catMap);
    const sortOrder = Math.max(0, ...Array.from(catMap.values()).map(c => c.sort_order || 0)) + 1;
    const insert = { name, shortname: null, color, sort_order: sortOrder };
    if (getPathMap) { insert.kind = 'bucket'; insert.parent_id = null; }
    const { error } = await state.db.from(table).insert(insert);
    if (error) throw new Error(error.message);
    created++;
  }
  if (created > 0) {
    await reload();
    indexMap();
  }
  return result;
}

/** Insert rows in chunks (same pattern as backup restore). Throws on error. */
export async function chunkedBatchInsert(table, rows, chunkSize = 100) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await state.db.from(table).insert(rows.slice(i, i + chunkSize));
    if (error) throw new Error(error.message);
  }
}

/** ISO string → local 'YYYY-MM-DDTHH:mm' for datetime-local inputs. */
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// -------------------------------------------------------------------
// Generic modal shell
// -------------------------------------------------------------------
//
// cfg = {
//   modalId, title, subtitle,
//   convertTitle, convertDesc, uploadTitle, uploadDesc,
//   categoriesLabel, selectAll, deselectAll,
//   step1, copy, copied, step2, step3,
//   pastePlaceholder, uploadFile,
//   review, back, backToPaste,
//   ready: n => string, andMore: n => string,
//   reviewHeader: n => string, selectedCount: (a, b) => string,
//   confirm: n => string, importing, success: n => string, failedPrefix,
//   newCategory,
//   categories: [{ name, display }],   // default bucket first as { name: '', display }
//   promptDefaultCategory,             // prompt name for the default bucket ('General')
//   groups: [{ id, name }], sharingReady,
//   buildPrompt,                       // (catNames: string[], groups) => string
//   parse,                             // default parseImportArray
//   validate,                          // (raw, i, ctx) => { item, errors }
//   getTitle,                          // item => string (preview bold line)
//   fields,                            // [{ key, label, type, options? }]
//                                      // types: text | select | datetime | datalist | grouplist
//   previewMeta,                       // (item) => html shown after the title in preview
//   reviewBadges,                      // (item, errors) => html shown under the fields
//   ensureCategories,                  // async (names: string[]) => Map(lower → { id, name })
//   createItems,                       // async (validItems, catMap) => void
//   afterCreate,                       // async () => void (refresh the view)
// }
//
export async function openBatchImportModal(cfg) {
  const parse = cfg.parse || parseImportArray;
  const { LLM_SERVICES } = await import('./demo-chooser.js');

  const isMobile = isMobileUA();
  const serviceButtons = LLM_SERVICES.map(s => {
    const href = isMobile && s.appUrl ? s.appUrl : s.url;
    return `<a href="${href}" target="_blank" rel="noopener" class="dc-llm-btn">${s.svg}<span>${s.name}</span></a>`;
  }).join('');

  const catChecks = cfg.categories
    .map(c => `<label class="import-cat-check"><input type="checkbox" data-cat-name="${esc(c.name === '' ? cfg.promptDefaultCategory : c.name)}" checked> ${esc(c.display)}</label>`)
    .join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = cfg.modalId;

  overlay.innerHTML = `
    <div class="dc-container">
      <div class="dc-header">
        <h2>${lucideIcon('upload', 20, 'var(--accent)')} ${cfg.title}</h2>
        <p class="dc-subtitle">${cfg.subtitle}</p>
      </div>

      <div id="${cfg.modalId}Options" class="dc-options">
        <button class="dc-card" id="${cfg.modalId}ConvertCard">
          <div class="dc-card-icon">${lucideIcon('file-text', 28)}</div>
          <div class="dc-card-title">${cfg.convertTitle}</div>
          <div class="dc-card-desc">${cfg.convertDesc}</div>
        </button>
        <button class="dc-card" id="${cfg.modalId}UploadCard">
          <div class="dc-card-icon">${lucideIcon('upload', 28)}</div>
          <div class="dc-card-title">${cfg.uploadTitle}</div>
          <div class="dc-card-desc">${cfg.uploadDesc}</div>
        </button>
      </div>

      <div class="dc-custom-flow" id="${cfg.modalId}ConvertFlow" style="display:none">
        <div>
          <div class="import-config-label">${cfg.categoriesLabel}
            <button class="import-review-toggle" id="${cfg.modalId}CatToggle">${cfg.deselectAll}</button>
          </div>
          <div class="import-cat-list" id="${cfg.modalId}CatList">${catChecks}</div>
        </div>

        <div class="dc-step">
          <div class="dc-step-header"><span class="dc-step-num">1</span><span>${cfg.step1}</span></div>
          <div class="dc-prompt-box">
            <textarea class="dc-prompt-text" id="${cfg.modalId}PromptText" rows="6" spellcheck="false"></textarea>
            <button class="dc-copy-btn" id="${cfg.modalId}CopyBtn">
              <span class="import-copy-icon">${lucideIcon('copy', 15)}</span>
              <span id="${cfg.modalId}CopyLabel">${cfg.copy}</span>
            </button>
          </div>
        </div>

        <div class="dc-step">
          <div class="dc-step-header"><span class="dc-step-num">2</span><span>${cfg.step2}</span></div>
          <div class="dc-llm-links">${serviceButtons}</div>
        </div>

        <div class="dc-step">
          <div class="dc-step-header"><span class="dc-step-num">3</span><span>${cfg.step3}</span></div>
          <textarea class="dc-paste-area" id="${cfg.modalId}ConvertPaste" rows="8" placeholder="${cfg.pastePlaceholder}"></textarea>
          <div id="${cfg.modalId}ConvertPreview" class="import-preview" style="display:none"></div>
          <div class="dc-error" id="${cfg.modalId}ConvertError" style="display:none"></div>
          <div class="dc-flow-actions">
            <button class="dc-btn-secondary" id="${cfg.modalId}ConvertBack">${cfg.back}</button>
            <button class="dc-btn-primary" id="${cfg.modalId}ConvertReview" disabled>${lucideIcon('eye', 15)} ${cfg.review}</button>
          </div>
        </div>
      </div>

      <div class="dc-custom-flow" id="${cfg.modalId}UploadFlow" style="display:none">
        <div class="dc-step">
          <div class="dc-step-header"><span class="dc-step-num">1</span><span>${cfg.step3}</span></div>
          <textarea class="dc-paste-area" id="${cfg.modalId}UploadPaste" rows="8" placeholder="${cfg.pastePlaceholder}"></textarea>
          <label class="import-file-row">${cfg.uploadFile}: <input type="file" id="${cfg.modalId}File" accept=".json,application/json"></label>
          <div id="${cfg.modalId}UploadPreview" class="import-preview" style="display:none"></div>
          <div class="dc-error" id="${cfg.modalId}UploadError" style="display:none"></div>
          <div class="dc-flow-actions">
            <button class="dc-btn-secondary" id="${cfg.modalId}UploadBack">${cfg.back}</button>
            <button class="dc-btn-primary" id="${cfg.modalId}UploadReview" disabled>${lucideIcon('eye', 15)} ${cfg.review}</button>
          </div>
        </div>
      </div>

      <div id="${cfg.modalId}ReviewStep" style="display:none">
        <div id="${cfg.modalId}ReviewContainer" class="import-review"></div>
        <div class="dc-error" id="${cfg.modalId}ReviewError" style="display:none"></div>
        <div class="dc-flow-actions">
          <button class="dc-btn-secondary" id="${cfg.modalId}ReviewBack">${cfg.backToPaste}</button>
          <button class="dc-btn-primary" id="${cfg.modalId}Confirm" disabled>${lucideIcon('check', 15)} ${cfg.review}</button>
        </div>
      </div>
      ${cfg.fields.filter(f => f.type === 'datalist').map(f =>
        `<datalist id="${cfg.modalId}Data-${f.key}">${(f.options || []).map(o => `<option value="${esc(o)}">`).join('')}</datalist>`
      ).join('')}
    </div>
  `;

  document.body.appendChild(overlay);
  const $ = (id) => overlay.querySelector('#' + cfg.modalId + id);

  const optionsDiv = $('Options');
  const convertFlow = $('ConvertFlow');
  const uploadFlow = $('UploadFlow');
  const reviewStep = $('ReviewStep');
  const reviewContainer = $('ReviewContainer');
  const reviewError = $('ReviewError');
  const reviewBackBtn = $('ReviewBack');
  const confirmBtn = $('Confirm');

  let importMode = null; // 'convert' | 'upload'
  let parsedRaw = [];
  let parsedItems = [];
  let itemErrors = [];
  let itemStates = [];

  function importCtx() {
    return {
      categoryNames: cfg.categories.map(c => c.name),
      groupById: new Map(cfg.groups.map(g => [g.id, g.name])),
      sharingReady: cfg.sharingReady,
    };
  }

  function revalidateAll() {
    const ctx = importCtx();
    parsedItems = [];
    itemErrors = [];
    parsedRaw.forEach((raw, i) => {
      const { item, errors } = cfg.validate(raw, i, ctx);
      parsedItems.push(item);
      itemErrors.push(errors);
    });
  }

  function selectedCatNames() {
    return Array.from(overlay.querySelectorAll(`#${cfg.modalId}CatList input[type="checkbox"]:checked`))
      .map(cb => cb.dataset.catName);
  }
  function updatePrompt() {
    $( 'PromptText').value = cfg.buildPrompt(selectedCatNames(), cfg.groups);
  }

  function showFlow(mode) {
    importMode = mode;
    optionsDiv.style.display = 'none';
    overlay.querySelector('.dc-subtitle').style.display = 'none';
    (mode === 'convert' ? convertFlow : uploadFlow).style.display = '';
    if (mode === 'convert') updatePrompt();
  }
  function backToOptions() {
    convertFlow.style.display = 'none';
    uploadFlow.style.display = 'none';
    optionsDiv.style.display = '';
    overlay.querySelector('.dc-subtitle').style.display = '';
    importMode = null;
  }

  $('ConvertCard').addEventListener('click', () => showFlow('convert'));
  $('UploadCard').addEventListener('click', () => showFlow('upload'));

  // Category checkboxes → regenerate prompt
  const catToggle = $('CatToggle');
  const catBoxes = () => Array.from(overlay.querySelectorAll(`#${cfg.modalId}CatList input[type="checkbox"]`));
  catBoxes().forEach(cb => {
    cb.addEventListener('change', () => {
      const all = catBoxes();
      const checked = all.filter(b => b.checked);
      catToggle.textContent = checked.length === all.length ? cfg.deselectAll : cfg.selectAll;
      updatePrompt();
    });
  });
  catToggle.addEventListener('click', () => {
    const all = catBoxes();
    const turnOn = all.some(cb => !cb.checked);
    all.forEach(cb => { cb.checked = turnOn; });
    catToggle.textContent = turnOn ? cfg.deselectAll : cfg.selectAll;
    updatePrompt();
  });

  // Copy prompt
  $('CopyBtn').addEventListener('click', async () => {
    const label = $('CopyLabel');
    const icon = overlay.querySelector(`#${cfg.modalId}CopyBtn .import-copy-icon`);
    try {
      await navigator.clipboard.writeText($('PromptText').value);
      label.textContent = cfg.copied;
      icon.innerHTML = lucideIcon('clipboard-check', 15);
      setTimeout(() => {
        label.textContent = cfg.copy;
        icon.innerHTML = lucideIcon('copy', 15);
      }, 2000);
    } catch {
      $('PromptText').select();
    }
  });

  // Paste → parse/validate → preview (shared by both flows)
  function bindPaste(pasteKey, previewKey, errorKey, reviewKey) {
    const pasteArea = $(pasteKey);
    const previewDiv = $(previewKey);
    const errorDiv = $(errorKey);
    const reviewBtn = $(reviewKey);
    pasteArea.addEventListener('input', () => {
      const raw = pasteArea.value.trim();
      errorDiv.style.display = 'none';
      previewDiv.style.display = 'none';
      if (!raw) { reviewBtn.disabled = true; return; }
      try {
        parsedRaw = parse(raw);
        revalidateAll();
        itemStates = parsedItems.map((_, i) => ({ included: itemErrors[i].length === 0 }));
        reviewBtn.disabled = false;
        const sample = parsedItems.slice(0, 3).map((it, i) => {
          const firstErr = itemErrors[i][0];
          const errHtml = firstErr ? `<div class="import-item-errors"><span>${esc(firstErr.message)}</span></div>` : '';
          return `<div class="import-preview-item">${lucideIcon('check-square', 14, 'var(--muted)')} <strong>${esc(cfg.getTitle(it) || '—')}</strong>${cfg.previewMeta(it)}</div>${errHtml}`;
        }).join('');
        previewDiv.innerHTML = `<div class="import-preview-header">${cfg.ready(parsedItems.length)}</div>${sample}${parsedItems.length > 3 ? `<div class="import-preview-more">${cfg.andMore(parsedItems.length - 3)}</div>` : ''}`;
        previewDiv.style.display = '';
      } catch (e) {
        reviewBtn.disabled = true;
        errorDiv.textContent = e.message;
        errorDiv.style.display = '';
      }
    });
    return { pasteArea, reviewBtn };
  }

  const convertPaste = bindPaste('ConvertPaste', 'ConvertPreview', 'ConvertError', 'ConvertReview');
  const uploadPaste = bindPaste('UploadPaste', 'UploadPreview', 'UploadError', 'UploadReview');

  // File upload → fills the paste area
  $('File').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      uploadPaste.pasteArea.value = String(reader.result || '');
      uploadPaste.pasteArea.dispatchEvent(new Event('input', { bubbles: true }));
    };
    reader.readAsText(f);
  });

  $('ConvertBack').addEventListener('click', backToOptions);
  $('UploadBack').addEventListener('click', backToOptions);

  // --- Review step ---
  const validSelectedCount = () =>
    parsedItems.filter((_, i) => itemStates[i].included && itemErrors[i].length === 0).length;

  function updateConfirmBtn() {
    const n = validSelectedCount();
    confirmBtn.innerHTML = `${lucideIcon('check', 15)} ${cfg.confirm(n)}`;
    confirmBtn.disabled = n === 0;
  }
  function updateReviewCount() {
    const el = reviewContainer.querySelector('.import-review-count');
    if (el) el.textContent = cfg.selectedCount(validSelectedCount(), parsedItems.length);
  }

  function groupOptionsHtml(item) {
    let opts = '<option value="">—</option>' + cfg.groups.map(g =>
      `<option value="${esc(g.id)}"${g.id === item.group_id ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
    if (item.group_id && !item.groupName) {
      opts += `<option value="${esc(item.group_id)}" selected>${esc(item.group_id)}</option>`;
    }
    return opts;
  }

  function renderFieldInput(field, item, i) {
    const val = item[field.key] ?? '';
    const attrs = `class="import-review-field-input" data-idx="${i}" data-field="${field.key}"`;
    switch (field.type) {
      case 'select':
        return `<select ${attrs}>${(field.options || []).map(o =>
          `<option value="${esc(o)}"${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      case 'datetime':
        // A date-only value gets a date input: rendering it as datetime-local
        // would show a phantom time (UTC midnight parsed to local, e.g. 01:00
        // in summer), and touching the field would silently convert it to timed.
        if (isDateOnly(val)) return `<input type="date" ${attrs} value="${esc(val)}">`;
        return `<input type="datetime-local" ${attrs} value="${isoToLocalInput(val)}">`;
      case 'datalist':
        return `<input ${attrs} list="${cfg.modalId}Data-${field.key}" value="${esc(val)}">`;
      case 'grouplist':
        return `<select ${attrs}>${groupOptionsHtml(item)}</select>`;
      default:
        return `<input type="text" ${attrs} value="${esc(val)}">`;
    }
  }

  function renderItemBadges(i) {
    const badgeBox = reviewContainer.querySelector(`[data-badges="${i}"]`);
    if (!badgeBox) return;
    badgeBox.innerHTML = cfg.reviewBadges(parsedItems[i], itemErrors[i]);
  }

  function renderReview() {
    const total = parsedItems.length;
    let html = `<div class="import-review-toolbar">
      <div class="import-review-toolbar-left">
        <strong>${cfg.reviewHeader(total)}</strong>
        <button class="import-review-toggle" id="${cfg.modalId}ToggleAll">${cfg.deselectAll}</button>
      </div>
      <span class="import-review-count">${cfg.selectedCount(total, total)}</span>
    </div><div class="import-review-list">`;

    parsedItems.forEach((it, i) => {
      const checked = itemStates[i].included ? 'checked' : '';
      const excluded = itemStates[i].included ? '' : ' excluded';
      html += `<div class="import-review-card${excluded}" data-idx="${i}">
        <span class="import-review-num">${i + 1}</span>
        <input type="checkbox" class="import-review-check" data-idx="${i}" ${checked}>
        <div class="import-review-fields">
          ${cfg.fields.map(f => `
          <div class="import-review-field">
            <span class="import-review-field-label wide">${f.label}</span>
            ${renderFieldInput(f, it, i)}
          </div>`).join('')}
          <div class="import-review-badges" data-badges="${i}"></div>
        </div>
      </div>`;
    });
    html += '</div>';
    reviewContainer.innerHTML = html;
    parsedItems.forEach((_, i) => renderItemBadges(i));
    updateConfirmBtn();

    const toggleBtn = reviewContainer.querySelector(`#${cfg.modalId}ToggleAll`);
    toggleBtn.addEventListener('click', () => {
      const allIncluded = itemStates.every(s => s.included);
      const newState = !allIncluded;
      itemStates.forEach(s => { s.included = newState; });
      reviewContainer.querySelectorAll('.import-review-check').forEach(cb => { cb.checked = newState; });
      reviewContainer.querySelectorAll('.import-review-card').forEach(card => card.classList.toggle('excluded', !newState));
      toggleBtn.textContent = newState ? cfg.deselectAll : cfg.selectAll;
      updateConfirmBtn();
      updateReviewCount();
    });

    reviewContainer.querySelectorAll('.import-review-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const idx = parseInt(cb.dataset.idx, 10);
        itemStates[idx].included = cb.checked;
        reviewContainer.querySelector(`.import-review-card[data-idx="${idx}"]`).classList.toggle('excluded', !cb.checked);
        toggleBtn.textContent = itemStates.every(s => s.included) ? cfg.deselectAll : cfg.selectAll;
        updateConfirmBtn();
        updateReviewCount();
      });
    });

    reviewContainer.querySelectorAll('.import-review-field-input').forEach(input => {
      input.addEventListener('input', () => {
        const idx = parseInt(input.dataset.idx, 10);
        const field = input.dataset.field;
        parsedRaw[idx][field] = input.value;
        const { item, errors } = cfg.validate(parsedRaw[idx], idx, importCtx());
        parsedItems[idx] = item;
        itemErrors[idx] = errors;
        if (errors.length === 0 && !itemStates[idx].included) {
          itemStates[idx].included = true;
          reviewContainer.querySelector(`.import-review-check[data-idx="${idx}"]`).checked = true;
          reviewContainer.querySelector(`.import-review-card[data-idx="${idx}"]`).classList.remove('excluded');
        }
        renderItemBadges(idx);
        updateConfirmBtn();
        updateReviewCount();
      });
    });
  }

  function openReview() {
    try {
      parsedRaw = parse((importMode === 'convert' ? convertPaste : uploadPaste).pasteArea.value);
    } catch (e) {
      return;
    }
    revalidateAll();
    itemStates = parsedItems.map((_, i) => ({ included: itemErrors[i].length === 0 }));
    convertFlow.style.display = 'none';
    uploadFlow.style.display = 'none';
    reviewStep.style.display = '';
    reviewError.style.display = 'none';
    renderReview();
  }
  convertPaste.reviewBtn.addEventListener('click', openReview);
  uploadPaste.reviewBtn.addEventListener('click', openReview);

  reviewBackBtn.addEventListener('click', () => {
    reviewStep.style.display = 'none';
    reviewError.style.display = 'none';
    (importMode === 'convert' ? convertFlow : uploadFlow).style.display = '';
  });

  // --- Confirm ---
  confirmBtn.addEventListener('click', async () => {
    if (!state.db.connected) { showToast('Not connected', 'error'); return; }
    const idxs = parsedItems
      .map((_, i) => i)
      .filter(i => itemStates[i].included && itemErrors[i].length === 0);
    if (idxs.length === 0) return;
    confirmBtn.disabled = true;
    confirmBtn.classList.add('is-pending');
    confirmBtn.textContent = cfg.importing;

    try {
      const needed = new Map(); // lower-name → display name
      for (const i of idxs) {
        const it = parsedItems[i];
        if (it.categoryIsNew && it.category) {
          const l = it.category.toLowerCase();
          if (!needed.has(l)) needed.set(l, it.category);
        }
      }
      const catMap = await cfg.ensureCategories([...needed.values()]);
      await cfg.createItems(idxs.map(i => parsedItems[i]), catMap);
      overlay.remove();
      await cfg.afterCreate();
      showToast(cfg.success(idxs.length), 'success');
    } catch (e) {
      reviewError.textContent = cfg.failedPrefix + e.message;
      reviewError.style.display = '';
      confirmBtn.disabled = false;
      confirmBtn.classList.remove('is-pending');
      updateConfirmBtn();
    }
  });

  // Dismiss by clicking overlay
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}
