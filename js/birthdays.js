import { lucideIcon } from './icons.js';
import state from './state.js';
import { esc, showToast, showConfirmAction, balanceGrid, fetchAll } from './utils.js';
import { scrollToAndHighlight, initItemHoverDelay, inlineEditText } from './item-utils.js';
import { t, getLang } from './i18n.js';

// ===================================================================
// BIRTHDAYS — DATA, CRUD & RENDERING
// ===================================================================

let birthdaySearchQuery = '';
let birthdayFilter = 'all';

async function refreshBirthdays() {
  if (!state.db.connected) return;
  let data;
  try {
    data = await fetchAll(() => state.db
      .from('birthdays')
      .select('*')
      .order('birthday', { ascending: true }));
  } catch (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  state.allBirthdays = data || [];
  if (state.currentView === 'birthdays') {
    renderBirthdays();
  }
}

// ===================================================================
// DATE HELPERS
// ===================================================================

function getNextBirthday(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  const today = new Date();
  const thisYear = today.getFullYear();
  const todayStart = new Date(thisYear, today.getMonth(), today.getDate());

  let next = new Date(thisYear, bd.getMonth(), bd.getDate());
  if (next < todayStart) {
    next = new Date(thisYear + 1, bd.getMonth(), bd.getDate());
  }
  return next;
}

function daysUntilBirthday(birthdayStr) {
  const next = getNextBirthday(birthdayStr);
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((next - todayStart) / (1000 * 60 * 60 * 24));
}

function getAge(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  const today = new Date();
  let age = today.getFullYear() - bd.getFullYear();
  const m = today.getMonth() - bd.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < bd.getDate())) age--;
  return age;
}

function getTurningAge(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  const next = getNextBirthday(birthdayStr);
  return next.getFullYear() - bd.getFullYear();
}

function formatBirthdayDate(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  return bd.toLocaleDateString(getLang(), { month: 'long', day: 'numeric' });
}

function formatBirthdayFull(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  return bd.toLocaleDateString(getLang(), { month: 'long', day: 'numeric', year: 'numeric' });
}

// ===================================================================
// RENDERING
// ===================================================================

function setBirthdayFilter(filter) {
  birthdayFilter = filter;
  document.querySelectorAll('#birthdayFilters .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderBirthdays();
}
window.setBirthdayFilter = setBirthdayFilter;

function renderBirthdays() {
  const grid = document.getElementById('birthdayGrid');
  if (!grid) return;

  let birthdays = [...state.allBirthdays];

  // Apply search filter
  if (birthdaySearchQuery) {
    const q = birthdaySearchQuery.toLowerCase();
    birthdays = birthdays.filter(b => b.name && b.name.toLowerCase().includes(q));
  }

  // Apply birthday filter
  if (birthdayFilter === 'upcoming') {
    birthdays = birthdays.filter(b => daysUntilBirthday(b.birthday) <= 30);
  } else if (birthdayFilter === 'this-month') {
    const thisMonth = new Date().getMonth();
    birthdays = birthdays.filter(b => {
      const next = getNextBirthday(b.birthday);
      return next.getMonth() === thisMonth;
    });
  }

  // Apply sort
  const sortBy = document.getElementById('birthdaySortBy')?.value || 'upcoming';
  if (sortBy === 'name') {
    birthdays.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (sortBy === 'age') {
    birthdays.sort((a, b) => getAge(b.birthday) - getAge(a.birthday));
  } else {
    // Default: sort by next occurrence
    birthdays.sort((a, b) => daysUntilBirthday(a.birthday) - daysUntilBirthday(b.birthday));
  }


  if (birthdays.length === 0) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('cake', 48, 'var(--muted)')}</div>
      <h3>${t('birthdays.empty_title')}</h3>
      <p>${t('birthdays.empty_hint')}</p>
      <button class="empty-cta" data-action="open-add-birthday">${lucideIcon('plus', 16)} ${t('birthdays.add_first')}</button>
    </div>`;
    document.getElementById('birthdayNavButtons').innerHTML = '';
    return;
  }

  // Separate into upcoming (next 30 days) and later
  const upcoming = birthdays.filter(b => daysUntilBirthday(b.birthday) <= 30);
  const thisMonth = new Date().getMonth();
  const thisYear = new Date().getFullYear();
  const later = birthdays.filter(b => {
    if (daysUntilBirthday(b.birthday) > 30) return true;
    // Upcoming birthdays in a different month also appear in their month section
    const next = getNextBirthday(b.birthday);
    return !(next.getMonth() === thisMonth && next.getFullYear() === thisYear);
  });

  // Build ordered sections: "Coming Up" + month groups
  const sections = [];
  if (upcoming.length > 0) {
    sections.push({ key: 'upcoming', label: 'Coming Up', icon: 'party-popper', items: upcoming, isUpcoming: true });
  }

  if (later.length > 0) {
    const monthGroups = {};
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    for (const b of later) {
      const next = getNextBirthday(b.birthday);
      const key = `${next.getFullYear()}-${String(next.getMonth()).padStart(2,'0')}`;
      const label = `${monthNames[next.getMonth()]} ${next.getFullYear()}`;
      const shortLabel = `${monthNames[next.getMonth()].slice(0,3)} ${String(next.getFullYear()).slice(2)}`;
      if (!monthGroups[key]) monthGroups[key] = { label, shortLabel, items: [] };
      monthGroups[key].items.push(b);
    }
    const sortedKeys = Object.keys(monthGroups).sort();
    for (const key of sortedKeys) {
      const grp = monthGroups[key];
      sections.push({ key, label: grp.label, shortLabel: grp.shortLabel, icon: 'calendar', items: grp.items, isUpcoming: false });
    }
  }

  // Generate gradient colors — rotate hue across sections for continuity
  // Start at warm orange (25°), end at cool blue-purple (260°)
  const totalSections = sections.length;
  const hueStart = 25;
  const hueEnd = 260;
  for (let i = 0; i < totalSections; i++) {
    const hue = totalSections === 1 ? hueStart : Math.round(hueStart + (hueEnd - hueStart) * (i / (totalSections - 1)));
    sections[i].color = `hsl(${hue}, 70%, 55%)`;
  }

  // Render nav buttons
  const navContainer = document.getElementById('birthdayNavButtons');
  navContainer.innerHTML = sections.map(s => {
    const display = s.isUpcoming ? t('birthdays.soon') : (s.shortLabel || s.label);
    return `<button class="category-nav-btn" style="--cat-color:${s.color}" data-action="navigate-to-birthday-section" data-key="${esc(s.key)}" title="${s.label}">${display}</button>`;
  }).join('');

  // Render grid
  let html = '';
  for (const s of sections) {
    html += `<div class="project-card" style="--cat-color:${s.color}" data-birthday-section="${s.key}">
      <div class="todo-cat-header">
        <div class="todo-cat-header-left">
          <div class="todo-cat-info">
            <h3 class="todo-cat-name">${lucideIcon(s.icon, 18)} ${s.label}</h3>
            <span class="todo-cat-stats">${s.items.length} ${s.items.length === 1 ? 'birthday' : 'birthdays'}</span>
          </div>
        </div>
      </div>
      <div class="task-list birthday-bucket-list">
        ${s.items.map(b => renderBirthdayCard(b, s.isUpcoming)).join('')}
      </div>
    </div>`;
  }

  const scrollY = window.scrollY;
  grid.innerHTML = html;
  window.scrollTo(0, scrollY);
  initBirthdayHoverDelay(grid);
  balanceGrid(grid);
}

function initBirthdayHoverDelay(container) {
  initItemHoverDelay(container, {
    itemSelector: '.birthday-card',
    actionsSelector: '.birthday-actions',
    rowSelector: '.birthday-info',
    textSelector: '.birthday-name',
    onDblClick: (item) => {
      const id = item.dataset.id;
      if (id) editBirthdayInline(id);
    },
  });
}

function navigateToBirthdaySection(key) {
  const card = document.querySelector(`[data-birthday-section="${key}"]`);
  scrollToAndHighlight(card, null);
}

function renderBirthdayCard(b, isUpcoming) {
  const days = daysUntilBirthday(b.birthday);
  const turning = getTurningAge(b.birthday);
  const dateStr = formatBirthdayDate(b.birthday);
  const noteHtml = b.note ? `<span class="birthday-note">${esc(b.note)}</span>` : '';

  let daysLabel;
  if (days === 0) {
    daysLabel = `<span class="birthday-countdown today">${lucideIcon('party-popper', 14)} ${t('birthdays.today')}</span>`;
  } else if (days === 1) {
    daysLabel = `<span class="birthday-countdown tomorrow">${t('birthdays.tomorrow')}</span>`;
  } else {
    daysLabel = `<span class="birthday-countdown ${isUpcoming ? 'soon' : ''}">${days}d</span>`;
  }

  const initial = (b.name || '?').charAt(0).toUpperCase();
  const avatarInner = b.avatar_url
    ? `<img src="${esc(b.avatar_url)}" alt="${esc(b.name)}" class="birthday-avatar-img">`
    : initial;

  return `<div class="bucket-item birthday-card ${days === 0 ? 'birthday-today' : ''} ${isUpcoming ? 'birthday-upcoming' : ''}" data-id="${b.id}">
    <div class="birthday-avatar" data-action="handle-avatar-click" data-id="${esc(b.id)}" title="${t('birthdays.change_photo')}">${avatarInner}</div>
    <div class="birthday-info">
      <div class="birthday-name-row">
        <span class="birthday-name">${esc(b.name)}</span>
        ${daysLabel}
      </div>
      <div class="birthday-meta">
        <span class="birthday-date">${lucideIcon('cake', 14)} ${dateStr}</span>
        <span class="birthday-age">${t('birthdays.turning')} ${turning}</span>
        ${noteHtml}
      </div>
    </div>
    <div class="birthday-actions">
      <button data-action="copy-item-link" data-link-type="birthday" data-id="${esc(b.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 16)}</button>
      <button data-action="open-edit-birthday" data-id="${esc(b.id)}" title="${t('common.edit')}">${lucideIcon('pencil', 16)}</button>
      <button data-action="delete-birthday" data-id="${esc(b.id)}" title="${t('common.delete')}">${lucideIcon('trash-2', 16)}</button>
    </div>
  </div>`;
}

// ===================================================================
// MODALS — ADD / EDIT
// ===================================================================

function initBirthdayModals() {
  const app = document.getElementById('app');

  // Add Birthday Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay';
  m1.id = 'addBirthdayModal';
  m1.innerHTML = `<div class="modal">
    <h2>${lucideIcon('cake', 20)} ${t('birthdays.add_birthday')}</h2>
    <label>${t('common.name')}</label>
    <input type="text" id="newBirthdayName" placeholder="${t('birthdays.name_placeholder')}" maxlength="200"
      data-action="save-new-birthday-on-enter">
    <label>${t('birthdays.birthday_label')}</label>
    <input type="date" id="newBirthdayDate">
    <label>${t('birthdays.note_label')}</label>
    <input type="text" id="newBirthdayNote" placeholder="${t('birthdays.note_placeholder')}" maxlength="500">
    <label>${t('birthdays.upload_photo')}</label>
    <div class="new-birthday-avatar-row">
      <div class="new-birthday-avatar-preview" id="newBirthdayAvatarPreview" data-action="pick-new-birthday-avatar">${lucideIcon('user', 24)}</div>
      <button type="button" class="btn new-birthday-avatar-btn" data-action="pick-new-birthday-avatar">${lucideIcon('upload', 14)} ${t('birthdays.upload_photo')}</button>
      <button type="button" class="btn new-birthday-avatar-clear" id="newBirthdayAvatarClear" data-action="clear-new-birthday-avatar" style="display:none">${lucideIcon('x', 14)}</button>
    </div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-add-birthday">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-new-birthday">${t('common.add')}</button>
    </div>
  </div>`;
  app.appendChild(m1);

  // Edit Birthday Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay';
  m2.id = 'editBirthdayModal';
  m2.dataset.action = 'close-edit-birthday';
  m2.dataset.overlayClose = 'true';
  m2.innerHTML = `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} ${t('birthdays.edit_birthday')}</h2>
    <input type="hidden" id="editBirthdayId">
    <label>${t('common.name')}</label>
    <input type="text" id="editBirthdayName" maxlength="200">
    <label>${t('birthdays.birthday_label')}</label>
    <input type="date" id="editBirthdayDate">
    <label>${t('birthdays.note_label')}</label>
    <input type="text" id="editBirthdayNote" maxlength="500">
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-edit-birthday">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-edit-birthday">${t('common.save')}</button>
    </div>
  </div>`;
  app.appendChild(m2);
}

// ===================================================================
// CRUD OPERATIONS
// ===================================================================

let newBirthdayAvatarDataUrl = null;

function pickNewBirthdayAvatar() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    showCropModalForNew(file);
  });
  input.click();
}

function showCropModalForNew(file) {
  // Re-use the existing crop modal but wire save to the add-modal preview
  let overlay = document.getElementById('avatarCropOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'avatarCropOverlay';
  overlay.className = 'modal-overlay visible';
  overlay.innerHTML = `<div class="modal avatar-crop-modal">
    <h2>${t('birthdays.crop_photo')}</h2>
    <div class="avatar-crop-container">
      <img class="avatar-crop-img" id="avatarCropImgNew" alt="Avatar preview">
      <div class="avatar-crop-ring"></div>
    </div>
    <div class="modal-actions">
      <button class="modal-cancel" id="avatarCropCancelNew">${t('common.cancel')}</button>
      <button class="modal-save" id="avatarCropSaveNew">${lucideIcon('check', 14)} ${t('common.save')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(overlay);

  const img = document.getElementById('avatarCropImgNew');
  const container = overlay.querySelector('.avatar-crop-container');
  const reader = new FileReader();
  reader.onload = () => {
    img.src = reader.result;
    img.onload = () => {
      // Center the image
      const cw = container.clientWidth, ch = container.clientHeight;
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const scale = Math.max(cw / iw, ch / ih);
      img.style.width = (iw * scale) + 'px';
      img.style.height = (ih * scale) + 'px';
      img.style.left = ((cw - iw * scale) / 2) + 'px';
      img.style.top = ((ch - ih * scale) / 2) + 'px';

      // Drag
      let dragging = false, startX, startY, origLeft, origTop;
      container.onpointerdown = (e) => {
        dragging = true; startX = e.clientX; startY = e.clientY;
        origLeft = parseFloat(img.style.left); origTop = parseFloat(img.style.top);
        container.setPointerCapture(e.pointerId);
      };
      container.onpointermove = (e) => {
        if (!dragging) return;
        img.style.left = (origLeft + e.clientX - startX) + 'px';
        img.style.top = (origTop + e.clientY - startY) + 'px';
      };
      container.onpointerup = () => { dragging = false; };

      // Zoom
      container.onwheel = (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.08 : 0.92;
        const w = parseFloat(img.style.width), h = parseFloat(img.style.height);
        const l = parseFloat(img.style.left), t_ = parseFloat(img.style.top);
        const cx = cw / 2, cy = ch / 2;
        img.style.width = (w * factor) + 'px';
        img.style.height = (h * factor) + 'px';
        img.style.left = (cx - (cx - l) * factor) + 'px';
        img.style.top = (cy - (cy - t_) * factor) + 'px';
      };
    };
  };
  reader.readAsDataURL(file);

  document.getElementById('avatarCropCancelNew').addEventListener('click', () => overlay.remove());
  document.getElementById("avatarCropSaveNew").addEventListener("click", () => {
    try {
      const size = 384;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const cw = container.clientWidth, ch = container.clientHeight;
      const ringR = cw * 0.42;
      const cx = cw / 2, cy = ch / 2;
      const imgW = parseFloat(img.style.width), imgH = parseFloat(img.style.height);
      const imgL = parseFloat(img.style.left), imgT = parseFloat(img.style.top);
      const srcX = (cx - ringR - imgL) / imgW * img.naturalWidth;
      const srcY = (cy - ringR - imgT) / imgH * img.naturalHeight;
      const srcS = (ringR * 2) / imgW * img.naturalWidth;
      ctx.drawImage(img, srcX, srcY, srcS, srcS, 0, 0, size, size);
      newBirthdayAvatarDataUrl = canvas.toDataURL('image/jpeg', 0.85);
      // Show preview (DOM API — no innerHTML with URL)
      const preview = document.getElementById('newBirthdayAvatarPreview');
      const previewImg = document.createElement('img');
      previewImg.src = newBirthdayAvatarDataUrl;
      previewImg.alt = 'avatar';
      preview.replaceChildren(previewImg);
      document.getElementById('newBirthdayAvatarClear').style.display = '';
      overlay.remove();
    } catch (err) {
      showToast('Crop failed: ' + err.message, 'error');
    }
  });
}

function clearNewBirthdayAvatar() {
  newBirthdayAvatarDataUrl = null;
  const preview = document.getElementById('newBirthdayAvatarPreview');
  preview.innerHTML = lucideIcon('user', 24);
  document.getElementById('newBirthdayAvatarClear').style.display = 'none';
}

function openAddBirthdayModal() {
  document.getElementById('newBirthdayName').value = '';
  document.getElementById('newBirthdayDate').value = '';
  document.getElementById('newBirthdayNote').value = '';
  clearNewBirthdayAvatar();
  document.getElementById('addBirthdayModal').classList.add('visible');
  setTimeout(() => document.getElementById('newBirthdayName').focus(), 100);
}

function closeAddBirthdayModal() {
  document.getElementById('addBirthdayModal').classList.remove('visible');
}

async function saveNewBirthday() {
  const name = document.getElementById('newBirthdayName').value.trim();
  const date = document.getElementById('newBirthdayDate').value;
  const note = document.getElementById('newBirthdayNote').value.trim();

  if (!name) { showToast(t('birthdays.enter_name'), 'error'); return; }
  if (!date) { showToast(t('birthdays.enter_date'), 'error'); return; }

  const row = { name, birthday: date };
  if (note) row.note = note;
  if (newBirthdayAvatarDataUrl) row.avatar_url = newBirthdayAvatarDataUrl;

  const { error } = await state.db.from('birthdays').insert(row);
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

  closeAddBirthdayModal();
  showToast(t('birthdays.birthday_added', name), 'success');
  await refreshBirthdays();
}

function editBirthdayInline(id) {
  const b = state.allBirthdays.find(x => x.id === id);
  if (!b) return;
  const nameEl = document.querySelector(`.birthday-card[data-id="${id}"] .birthday-name`);
  if (!nameEl) return;

  // Hide actions while editing
  const actionsEl = nameEl.closest('.birthday-card')?.querySelector('.birthday-actions');
  if (actionsEl) actionsEl.classList.remove('visible');

  // Build extra fields
  const extras = document.createElement('div');
  extras.className = 'inline-edit-extras';

  // Birthday date row
  const dateRow = document.createElement('div');
  dateRow.className = 'inline-edit-row';
  const dateLabel = document.createElement('label');
  dateLabel.className = 'inline-edit-label';
  dateLabel.textContent = t('birthdays.birthday_label');
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'inline-edit-input';
  dateInput.value = b.birthday || '';
  dateRow.appendChild(dateLabel);
  dateRow.appendChild(dateInput);

  // Note row
  const noteRow = document.createElement('div');
  noteRow.className = 'inline-edit-row';
  const noteLabel = document.createElement('label');
  noteLabel.className = 'inline-edit-label';
  noteLabel.textContent = t('common.note');
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.className = 'inline-edit-input';
  noteInput.value = b.note || '';
  noteInput.placeholder = t('birthdays.note_placeholder');
  noteRow.appendChild(noteLabel);
  noteRow.appendChild(noteInput);

  extras.appendChild(dateRow);
  extras.appendChild(noteRow);

  inlineEditText(nameEl, b.name, {
    maxLength: 200,
    extraEl: extras,
    collectExtra: () => ({
      birthday: dateInput.value,
      note: noteInput.value.trim(),
    }),
    saveFn: async (newName, extra) => {
      const updates = {};
      if (newName !== b.name) updates.name = newName;
      if (extra) {
        if (extra.birthday && extra.birthday !== b.birthday) updates.birthday = extra.birthday;
        const oldNote = b.note || '';
        if (extra.note !== oldNote) updates.note = extra.note || null;
      }
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        const { error } = await state.db.from('birthdays').update(updates).eq('id', id);
        if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
        showToast(t('birthdays.birthday_updated'), 'success');
      }
    },
    refreshFn: renderBirthdays,
  });
}

function openEditBirthdayModal(id) {
  const b = state.allBirthdays.find(x => x.id === id);
  if (!b) return;
  document.getElementById('editBirthdayId').value = id;
  document.getElementById('editBirthdayName').value = b.name;
  document.getElementById('editBirthdayDate').value = b.birthday;
  document.getElementById('editBirthdayNote').value = b.note || '';
  document.getElementById('editBirthdayModal').classList.add('visible');
  setTimeout(() => document.getElementById('editBirthdayName').focus(), 100);
}

function closeEditBirthdayModal() {
  document.getElementById('editBirthdayModal').classList.remove('visible');
}

async function saveEditBirthday() {
  const id = document.getElementById('editBirthdayId').value;
  const name = document.getElementById('editBirthdayName').value.trim();
  const date = document.getElementById('editBirthdayDate').value;
  const note = document.getElementById('editBirthdayNote').value.trim();

  if (!name) { showToast(t('birthdays.enter_name'), 'error'); return; }
  if (!date) { showToast(t('birthdays.enter_date'), 'error'); return; }

  const { error } = await state.db.from('birthdays').update({
    name, birthday: date, note: note || null, updated_at: new Date().toISOString()
  }).eq('id', id);
  if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }

  closeEditBirthdayModal();
  showToast(t('birthdays.birthday_updated'), 'success');
  await refreshBirthdays();
}

async function deleteBirthday(id) {
  const b = state.allBirthdays.find(x => x.id === id);
  if (!b) return;
  showConfirmAction(
    'Delete Birthday',
    `Remove ${b.name}'s birthday?`,
    async () => {
      const { error } = await state.db.from('birthdays').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('birthdays.birthday_removed'), 'info');
      await refreshBirthdays();
    }
  );
}


// ===================================================================
// AVATAR — Upload / View / Delete
// ===================================================================

const AVATAR_MAX_SIZE = 384; // px — 4× display resolution
const AVATAR_QUALITY = 0.7; // JPEG quality

function handleAvatarClick(id) {
  const b = state.allBirthdays.find(x => x.id === id);
  if (!b) return;
  showAvatarPreview(id, b.avatar_url, b.name);
}

function pickAvatarFile(id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    showCropModal(file, id);
  });
  input.click();
}

function showCropModal(file, id) {
  let overlay = document.getElementById('avatarCropOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'avatarCropOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal avatar-crop-modal">
    <h2>${t('birthdays.crop_photo')}</h2>
    <div class="avatar-crop-container">
      <img class="avatar-crop-img" id="avatarCropImg" alt="Avatar preview">
      <div class="avatar-crop-ring"></div>
    </div>
    <div class="modal-actions">
      <button class="modal-cancel" id="avatarCropCancel">${t('common.cancel')}</button>
      <button class="modal-save" id="avatarCropSave">${lucideIcon('check', 14)} ${t('common.save')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(overlay);
  overlay.style.display = 'flex';

  const img = document.getElementById('avatarCropImg');
  const container = overlay.querySelector('.avatar-crop-container');
  let scale = 1, tx = 0, ty = 0, dragging = false, lastX, lastY;
  let pinchDist0 = null, scale0 = 1;

  img.onload = () => {
    const cw = container.clientWidth, ch = container.clientHeight;
    const aspect = img.naturalWidth / img.naturalHeight;
    let iw, ih;
    if (aspect > 1) { ih = ch; iw = ch * aspect; } else { iw = cw; ih = cw / aspect; }
    scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    tx = (cw - img.naturalWidth * scale) / 2;
    ty = (ch - img.naturalHeight * scale) / 2;
    applyTransform();
  };
  img.src = URL.createObjectURL(file);

  function applyTransform() { img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; }

  function clampPosition() {
    const cw = container.clientWidth, ch = container.clientHeight;
    const sw = img.naturalWidth * scale, sh = img.naturalHeight * scale;
    tx = Math.min(0, Math.max(cw - sw, tx));
    ty = Math.min(0, Math.max(ch - sh, ty));
  }

  function clampScale() {
    const cw = container.clientWidth, ch = container.clientHeight;
    const minScale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    if (scale < minScale) scale = minScale;
    if (scale > minScale * 5) scale = minScale * 5;
  }

  // Mouse drag
  container.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; e.preventDefault(); });
  window.addEventListener('mousemove', e => { if (!dragging) return; tx += e.clientX - lastX; ty += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; clampPosition(); applyTransform(); });
  window.addEventListener('mouseup', () => { dragging = false; });
  container.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const oldScale = scale;
    scale *= e.deltaY < 0 ? 1.1 : 0.9;
    clampScale();
    tx = cx - (cx - tx) * (scale / oldScale);
    ty = cy - (cy - ty) * (scale / oldScale);
    clampPosition(); applyTransform();
  }, { passive: false });

  // Touch drag + pinch
  container.addEventListener('touchstart', e => {
    if (e.touches.length === 1) { dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }
    if (e.touches.length === 2) { dragging = false; pinchDist0 = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY); scale0 = scale; }
    e.preventDefault();
  }, { passive: false });
  container.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && dragging) {
      tx += e.touches[0].clientX - lastX; ty += e.touches[0].clientY - lastY;
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      clampPosition(); applyTransform();
    }
    if (e.touches.length === 2 && pinchDist0) {
      const dist = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
      const rect = container.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      const oldScale = scale;
      scale = scale0 * (dist / pinchDist0);
      clampScale();
      tx = cx - (cx - tx) * (scale / oldScale);
      ty = cy - (cy - ty) * (scale / oldScale);
      clampPosition(); applyTransform();
    }
    e.preventDefault();
  }, { passive: false });
  container.addEventListener('touchend', e => { if (e.touches.length < 2) pinchDist0 = null; if (e.touches.length === 0) dragging = false; });

  document.getElementById('avatarCropCancel').addEventListener('click', () => overlay.remove());
  document.getElementById('avatarCropSave').addEventListener('click', async () => {
    try {
      const cw = container.clientWidth;
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_MAX_SIZE; canvas.height = AVATAR_MAX_SIZE;
      const ctx = canvas.getContext('2d');
      // Map the visible square back to source image coordinates
      const sx = -tx / scale;
      const sy = -ty / scale;
      const sSize = cw / scale;
      ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, AVATAR_MAX_SIZE, AVATAR_MAX_SIZE);
      const dataUrl = canvas.toDataURL('image/jpeg', AVATAR_QUALITY);
      const { error } = await state.db.from('birthdays').update({ avatar_url: dataUrl }).eq('id', id);
      if (error) { showToast(t('toast.failed_to_save'), 'error'); return; }
      const b = state.allBirthdays.find(x => x.id === id);
      if (b) b.avatar_url = dataUrl;
      overlay.remove();
      renderBirthdays();
      showToast(t('birthdays.photo_updated'), 'success');
    } catch (e) {
      showToast(t('toast.failed_to_save'), 'error');
    }
  });

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}


function showAvatarPreview(id, url, name) {
  let overlay = document.getElementById('avatarPreviewOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'avatarPreviewOverlay';
  overlay.className = 'modal-overlay';
  const initial = (name || '?').charAt(0).toUpperCase();
  const hasPhoto = !!url;
  const previewContent = hasPhoto
    ? `<div class="avatar-preview-frame"><img src="${esc(url)}" alt="${esc(name)}" class="avatar-preview-img"></div>`
    : `<div class="avatar-preview-frame"><div class="avatar-preview-placeholder">${initial}</div></div>`;
  const removeBtn = hasPhoto
    ? `<button class="avatar-action-btn avatar-remove-btn" data-action="remove-avatar" data-id="${esc(id)}" title="${t('birthdays.remove_photo')}">${lucideIcon('trash-2', 18)}</button>`
    : '';
  overlay.innerHTML = `<div class="modal avatar-preview-modal">
    <h2>${esc(name)}</h2>
    ${previewContent}
    <div class="avatar-preview-actions">
      <button class="avatar-action-btn" data-action="pick-avatar-file" data-id="${esc(id)}" title="${hasPhoto ? t('birthdays.change_photo') : t('birthdays.upload_photo')}">${lucideIcon('upload', 18)}</button>
      ${removeBtn}
    </div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-avatar-preview">${t('common.close')}</button>
    </div>
  </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('app').appendChild(overlay);
  overlay.style.display = 'flex';
}

async function removeAvatar(id) {
  const { error } = await state.db.from('birthdays').update({ avatar_url: null }).eq('id', id);
  if (error) { showToast(t('toast.failed_to_save'), 'error'); return; }
  const b = state.allBirthdays.find(x => x.id === id);
  if (b) b.avatar_url = null;
  const overlay = document.getElementById('avatarPreviewOverlay');
  if (overlay) overlay.remove();
  renderBirthdays();
  showToast(t('birthdays.photo_removed'), 'success');
}

export { refreshBirthdays, renderBirthdays, initBirthdayModals };

// Window bindings for inline onclick handlers
window.openAddBirthdayModal = openAddBirthdayModal;
window.closeAddBirthdayModal = closeAddBirthdayModal;
window.saveNewBirthday = saveNewBirthday;
window.openEditBirthdayModal = openEditBirthdayModal;
window.closeEditBirthdayModal = closeEditBirthdayModal;
window.saveEditBirthday = saveEditBirthday;
window.deleteBirthday = deleteBirthday;
window.renderBirthdays = renderBirthdays;
window.navigateToBirthdaySection = navigateToBirthdaySection;
window.filterBirthdays = function(e) { birthdaySearchQuery = e.target.value; renderBirthdays(); };
window.handleAvatarClick = handleAvatarClick;
window.pickAvatarFile = pickAvatarFile;
window.removeAvatar = removeAvatar;
window.pickNewBirthdayAvatar = pickNewBirthdayAvatar;
window.clearNewBirthdayAvatar = clearNewBirthdayAvatar;
