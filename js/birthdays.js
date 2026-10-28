import { lucideIcon } from './icons.js';
import state from './state.js';
import { esc, showToast, showConfirmAction, fetchAll } from './utils.js';
import { t, getLang } from './i18n.js';
import { toDateStr, parseLocalDate, nextBirthdayOccurrence } from './calendar-pure.js';

// ===================================================================
// BIRTHDAYS — DATA & CRUD (no page: birthdays surface on the Calendar page)
// ===================================================================


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
  if (state.currentView === 'calendar' && window.renderCalendar) {
    window.renderCalendar();
  }
}

// ===================================================================
// MODALS — ADD / EDIT
// ===================================================================

function addBirthdayModalHTML() {
  return `<div class="modal">
    <h2>${lucideIcon('cake', 20)} ${t('birthdays.add_birthday')}</h2>
    <div class="birthday-identity">
      <div class="new-birthday-avatar-preview" id="newBirthdayAvatarPreview" data-action="pick-new-birthday-avatar" title="${t('birthdays.upload_photo')}">${lucideIcon('user', 30)}</div>
      <div class="birthday-identity-fields">
        <div class="birthday-name-field">
          <label>${t('common.name')}</label>
          <input type="text" id="newBirthdayName" class="modal-title-input" placeholder="${t('birthdays.name_placeholder')}" maxlength="200"
            data-action="save-new-birthday-on-enter">
        </div>
        <div class="birthday-date-row">
          <label>${t('birthdays.birthday_label')}</label>
          <input type="date" id="newBirthdayDate" class="modal-title-input" data-action="birthday-field" data-prefix="new">
        </div>
      </div>
    </div>
    <div class="birthday-photo-actions" id="newBirthdayPhotoActions" style="display:none">
      <button type="button" class="btn new-birthday-avatar-clear" id="newBirthdayAvatarClear" data-action="clear-new-birthday-avatar">${lucideIcon('x', 14)} ${t('common.remove')}</button>
    </div>
    <div class="modal-live-summary" id="newBirthdaySummary" style="display:none"></div>
    <label>${t('birthdays.note_label')}</label>
    <textarea id="newBirthdayNote" placeholder="${t('birthdays.note_placeholder')}" maxlength="500" rows="3"></textarea>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-add-birthday">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-new-birthday">${t('common.add')}</button>
    </div>
  </div>`;
}

function editBirthdayModalHTML() {
  return `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} ${t('birthdays.edit_birthday')}</h2>
    <input type="hidden" id="editBirthdayId">
    <div class="birthday-identity">
      <div class="new-birthday-avatar-preview" id="editBirthdayAvatarPreview" data-action="edit-birthday-avatar" data-id="" title="${t('birthdays.upload_photo')}"></div>
      <div class="birthday-identity-fields">
        <div class="birthday-name-field">
          <label>${t('common.name')}</label>
          <input type="text" id="editBirthdayName" class="modal-title-input" maxlength="200">
        </div>
        <div class="birthday-date-row">
          <label>${t('birthdays.birthday_label')}</label>
          <input type="date" id="editBirthdayDate" class="modal-title-input" data-action="birthday-field" data-prefix="edit">
        </div>
      </div>
    </div>
    <div class="modal-live-summary" id="editBirthdaySummary" style="display:none"></div>
    <label>${t('birthdays.note_label')}</label>
    <textarea id="editBirthdayNote" maxlength="500" rows="3"></textarea>
    <div class="modal-actions">
      <button class="modal-delete" data-action="delete-birthday" id="editBirthdayDeleteBtn" data-id="">${lucideIcon('trash-2', 14)} ${t('common.delete')}</button>
      <button class="modal-cancel" data-action="close-edit-birthday">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-edit-birthday">${t('common.save')}</button>
    </div>
  </div>`;
}

/**
 * Live summary under the date field: the next occurrence, the age
 * turned, and how far away it is — the same figures the calendar
 * chip shows, visible before saving.
 */
function updateBirthdaySummary(prefix) {
  const el = document.getElementById(`${prefix}BirthdaySummary`);
  if (!el) return;
  const dob = document.getElementById(`${prefix}BirthdayDate`)?.value;
  let html = '';
  if (dob) {
    const now = new Date();
    const today = toDateStr(now.getFullYear(), now.getMonth(), now.getDate());
    const occ = nextBirthdayOccurrence(dob, today);
    if (occ) {
      const fmt = parseLocalDate(occ.date).toLocaleDateString(getLang(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      const days = Math.round((parseLocalDate(occ.date) - parseLocalDate(today)) / 86400000);
      const when = days === 0 ? t('calendar.today') : days === 1 ? t('birthdays.tomorrow') : t('birthdays.in_days', days);
      html = `${esc(fmt)} · ${t('calendar.turns', occ.turningAge)} <span class="modal-summary-local">· ${esc(when)}</span>`;
    }
  }
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
}

function initBirthdayModals() {
  const app = document.getElementById('app');

  // Add Birthday Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay';
  m1.id = 'addBirthdayModal';
  m1.innerHTML = addBirthdayModalHTML();
  app.appendChild(m1);

  // Edit Birthday Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay';
  m2.id = 'editBirthdayModal';
  m2.dataset.action = 'close-edit-birthday';
  m2.dataset.overlayClose = 'true';
  m2.innerHTML = editBirthdayModalHTML();
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
      document.getElementById('newBirthdayPhotoActions').style.display = '';
      overlay.remove();
    } catch (err) {
      showToast('Crop failed: ' + err.message, 'error');
    }
  });
}

function clearNewBirthdayAvatar() {
  newBirthdayAvatarDataUrl = null;
  const preview = document.getElementById('newBirthdayAvatarPreview');
  preview.innerHTML = lucideIcon('user', 30);
  const actions = document.getElementById('newBirthdayPhotoActions');
  if (actions) actions.style.display = 'none';
}

function openAddBirthdayModal(presetDate) {
  const modal = document.getElementById('addBirthdayModal');
  modal.innerHTML = addBirthdayModalHTML();
  modal.style.setProperty('--cat-color', 'var(--pink)');
  document.getElementById('newBirthdayName').value = '';
  document.getElementById('newBirthdayDate').value = presetDate || '';
  document.getElementById('newBirthdayNote').value = '';
  clearNewBirthdayAvatar();
  updateBirthdaySummary('new');
  modal.classList.add('visible');
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

function openEditBirthdayModal(id) {
  const b = state.allBirthdays.find(x => x.id === id);
  if (!b) return;
  const modal = document.getElementById('editBirthdayModal');
  modal.innerHTML = editBirthdayModalHTML();
  modal.style.setProperty('--cat-color', 'var(--pink)');
  document.getElementById('editBirthdayId').value = id;
  document.getElementById('editBirthdayName').value = b.name;
  document.getElementById('editBirthdayDate').value = b.birthday;
  document.getElementById('editBirthdayNote').value = b.note || '';
  updateBirthdaySummary('edit');
  setEditBirthdayAvatarPreview(b.avatar_url);
  document.getElementById('editBirthdayAvatarPreview').dataset.id = id;
  document.getElementById('editBirthdayDeleteBtn').dataset.id = id;
  modal.classList.add('visible');
  setTimeout(() => document.getElementById('editBirthdayName').focus(), 100);
}

function setEditBirthdayAvatarPreview(avatarUrl) {
  const preview = document.getElementById('editBirthdayAvatarPreview');
  if (!preview) return;
  preview.replaceChildren();
  if (avatarUrl) {
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = 'avatar';
    preview.appendChild(img);
  } else {
    preview.innerHTML = lucideIcon('user', 30);
  }
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
    t('birthdays.delete_title'),
    t('birthdays.delete_confirm', b.name),
    async () => {
      const { error } = await state.db.from('birthdays').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      closeEditBirthdayModal();
      closeCalendarDayPanel();
      showToast(t('birthdays.birthday_removed'), 'info');
      await refreshBirthdays();
    }
  );
}

function closeCalendarDayPanel() {
  if (window.closeCalendarDay) window.closeCalendarDay();
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
  document.getElementById('avatarCropSave').addEventListener('click', async function() {
    const btn = this;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-pending');
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
      setEditBirthdayAvatarPreview(dataUrl);
      // Update the preview overlay if still open
      const previewOverlay = document.getElementById('avatarPreviewOverlay');
      if (previewOverlay) {
        const frame = previewOverlay.querySelector('.avatar-preview-frame');
        if (frame) frame.innerHTML = `<img src="${esc(dataUrl)}" alt="" class="avatar-preview-img">`;
        // Show remove button if it wasn't there (was placeholder before)
        const actions = previewOverlay.querySelector('.avatar-preview-actions');
        if (actions && !actions.querySelector('.avatar-remove-btn')) {
          actions.insertAdjacentHTML('beforeend',
            `<button class="avatar-action-btn avatar-remove-btn" data-action="remove-avatar" data-id="${esc(id)}" title="${t('birthdays.remove_photo')}">${lucideIcon('trash-2', 18)}</button>`);
        }
      }
      if (window.renderCalendar) window.renderCalendar();
      showToast(t('birthdays.photo_updated'), 'success');
    } catch (e) {
      showToast(t('toast.failed_to_save'), 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-pending');
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
  setEditBirthdayAvatarPreview(null);
  if (window.renderCalendar) window.renderCalendar();
  showToast(t('birthdays.photo_removed'), 'success');
}

export { refreshBirthdays, initBirthdayModals };

// Window bindings for inline onclick handlers
window.openAddBirthdayModal = openAddBirthdayModal;
window.updateBirthdaySummary = updateBirthdaySummary;
window.closeAddBirthdayModal = closeAddBirthdayModal;
window.saveNewBirthday = saveNewBirthday;
window.openEditBirthdayModal = openEditBirthdayModal;
window.closeEditBirthdayModal = closeEditBirthdayModal;
window.saveEditBirthday = saveEditBirthday;
window.deleteBirthday = deleteBirthday;
window.handleAvatarClick = handleAvatarClick;
window.pickAvatarFile = pickAvatarFile;
window.closeAvatarPreviewModal = function() {
  const overlay = document.getElementById('avatarPreviewOverlay');
  if (overlay) overlay.remove();
};
window.removeAvatar = removeAvatar;
window.pickNewBirthdayAvatar = pickNewBirthdayAvatar;
window.clearNewBirthdayAvatar = clearNewBirthdayAvatar;
