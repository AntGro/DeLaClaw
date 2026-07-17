// Delegation for CSP-safe event handling — Phase 1 + Phase 2 unified
// 4 document-level listeners (click, change, input, keydown)
(function () {
  function getActionEl(target) {
    if (!target) return null;
    if (target.dataset && target.dataset.action) return target;
    return target.closest ? target.closest('[data-action]') : null;
  }
  function getId(el) {
    return el.dataset.id || el.dataset.todoId || el.dataset.habitId || el.dataset.projectId || el.dataset.taskId || el.dataset.listId || el.dataset.vestId || el.dataset.deck || el.dataset.groupId || el.dataset.itemId || el.dataset.folderId || '';
  }
  function getCat(el) {
    return el.dataset.category || el.dataset.cat || '';
  }
  function callWindow(fnName, args) {
    var fn = window[fnName];
    if (typeof fn === 'function') {
      try { fn.apply(null, args); } catch (err) { console.error('delegation call failed', fnName, err); }
      return true;
    }
    return false;
  }

  function handleClick(e) {
    var el = getActionEl(e.target);
    if (!el) return;
    var action = el.dataset.action;
    if (!action) return;
    if (el.dataset.overlayClose !== undefined && e.target !== el) {
      if (action && action.indexOf('close-') === 0) return;
    }
    if ((action === 'overlay-close-settings' || action === 'overlay-close-auth') && e.target !== el) return;
    if (action === 'close-modal' && el.dataset.modalId) {
      var m = document.getElementById(el.dataset.modalId);
      if (m) m.remove();
      return;
    }
    if (action === 'select-all-on-click') {
      if (el.select) el.select();
      return;
    }
    switch (action) {
      case 'switch-view': if (el.dataset.view) callWindow('switchView', [el.dataset.view]); break;
      case 'set-project-filter': callWindow('setProjectFilter', [el.dataset.filter]); break;
      case 'set-todo-filter': callWindow('setTodoFilter', [el.dataset.filter]); break;
      case 'set-habit-filter': callWindow('setHabitFilter', [el.dataset.filter]); break;
      case 'set-birthday-filter': callWindow('setBirthdayFilter', [el.dataset.filter]); break;
      case 'set-vestiaire-filter': callWindow('setVestiaireFilter', [el.dataset.filter]); break;
      case 'set-flashcard-filter': callWindow('setFlashcardFilter', [el.dataset.filter]); break;
      case 'set-habit-view-mode': callWindow('setHabitViewMode', [el.dataset.view]); break;
      case 'sort-projects': callWindow('renderProjectGrid', []); break;
      case 'sort-todos': callWindow('renderTodos', []); break;
      case 'sort-habits': callWindow('renderHabits', []); break;
      case 'sort-birthdays': callWindow('renderBirthdays', []); break;
      case 'sort-vestiaire': callWindow('renderVestiaire', []); break;
      case 'sort-flashcards': callWindow('renderFlashcards', []); break;
      case 'sort-lists': callWindow('renderLists', []); break;
      case 'handle-model-change': callWindow('handleModelChange', []); break;
      case 'open-prompt-editor': callWindow('openPromptEditor', []); break;
      case 'toggle-archived': callWindow('toggleShowArchived', []); break;
      case 'open-add-project': callWindow('openAddProjectModal', []); break;
      case 'open-add-category': callWindow('openAddCategoryModal', []); break;
      case 'open-add-habit': callWindow('openAddHabitModal', []); break;
      case 'open-add-habit-category': callWindow('openAddHabitCategoryModal', []); break;
      case 'open-add-birthday': callWindow('openAddBirthdayModal', []); break;
      case 'open-add-vestiaire': callWindow('openAddVestiaireModal', []); break;
      case 'open-add-vestiaire-category': callWindow('openAddVestiaireCategoryModal', []); break;
      case 'open-add-flash-deck': callWindow('openAddFlashDeckModal', []); break;
      case 'open-add-list': callWindow('openAddListModal', []); break;
      case 'open-import': callWindow('openImportModal', []); break;
      case 'start-practice': callWindow('startPractice', [el.dataset.scope || '__all']); break;
      case 'start-text-practice': callWindow('startTextPractice', [el.dataset.scope || '__all']); break;
      case 'toggle-search': callWindow('toggleSearch', [el]); break;
      case 'clear-search': callWindow('clearPageSearch', [el]); break;
      case 'close-add-project': callWindow('closeAddProjectModal', []); break;
      case 'save-new-project': callWindow('saveNewProject', []); break;
      case 'close-revision': callWindow('closeRevisionModal', []); break;
      case 'submit-revision': callWindow('submitRevision', []); break;
      case 'close-prompt-editor': callWindow('closePromptEditor', []); break;
      case 'save-global-prompt': callWindow('saveGlobalPrompt', []); break;
      case 'close-project-prompt': callWindow('closeProjectPrompt', []); break;
      case 'save-project-prompt': callWindow('saveProjectPrompt', []); break;
      case 'close-edit-project': callWindow('closeEditProjectModal', []); break;
      case 'save-edit-project': callWindow('saveEditProject', []); break;
      case 'close-edit-category': callWindow('closeEditCategoryModal', []); break;
      case 'save-edit-category': callWindow('saveEditCategory', []); break;
      case 'close-delete-confirm': callWindow('closeDeleteConfirm', []); break;
      case 'execute-delete-confirm': callWindow('executeDeleteConfirm', []); break;
      case 'close-settings': callWindow('closeSettings', []); break;
      case 'overlay-close-settings': callWindow('closeSettings', []); break;
      case 'overlay-close-auth': { var ov = document.getElementById('authPromptOverlay'); if (ov) ov.classList.remove('visible'); } break;
      case 'switch-settings-pane': if (el.dataset.pane) callWindow('switchSettingsPane', [el.dataset.pane]); break;
      case 'toggle-theme': callWindow('toggleTheme', []); break;
      case 'toggle-nvidia-key-visibility': callWindow('toggleNvidiaKeyVisibility', []); break;
      case 'save-nvidia-key': callWindow('saveNvidiaKey', []); break;
      case 'apply-custom-model': callWindow('applyCustomModel', []); break;
      case 'test-nvidia-api': callWindow('testNvidiaApi', []); break;
      case 'toggle-nvidia-usage': callWindow('toggleNvidiaUsageDetail', []); break;
      case 'export-backup': callWindow('exportBackup', []); break;
      case 'export-to-drive': callWindow('exportToGoogleDrive', []); break;
      case 'import-backup': callWindow('importBackup', []); break;
      case 'show-todo-general-card': callWindow('showTodoGeneralCard', []); break;
      case 'navigate-to-category': callWindow('navigateToCategory', [getCat(el)]); break;
      case 'delete-category': callWindow('deleteCategory', [getCat(el)]); break;
      case 'delete-all-done': e.stopPropagation(); callWindow('deleteAllDoneTodos', [getCat(el)]); break;
      case 'toggle-done-todos': callWindow('toggleDoneTodos', [el.dataset.catId || getCat(el)]); break;
      case 'open-edit-category-modal': callWindow('openEditCategoryModal', [getCat(el)]); break;
      case 'open-quick-add-priority-picker': callWindow('openQuickAddPriorityPicker', [el, e]); break;
      case 'add-todo-from-add-row': { var inp = el.closest('.todo-cat-add')?.querySelector('.todo-cat-input'); if (inp) callWindow('addTodoToCategory', [inp]); } break;
      case 'share-todo-from-add': callWindow('shareTodoFromAdd', [el]); break;
      case 'open-priority-picker': callWindow('openPriorityPicker', [getId(el), e, el]); break;
      case 'toggle-todo': { var done = el.dataset.done === 'true'; callWindow('toggleTodo', [getId(el) || el.dataset.todoId, done, el]); } break;
      case 'open-snooze-modal': callWindow('openSnoozeModal', [getId(el)]); break;
      case 'edit-todo-inline': callWindow('editTodoInline', [getId(el)]); break;
      case 'delete-todo': callWindow('deleteTodo', [getId(el)]); break;
      case 'set-todo-priority': callWindow('setTodoPriority', [getId(el), el.dataset.priority]); break;
      case 'set-quick-add-priority': callWindow('setQuickAddPriority', [el, el.dataset.priority]); break;
      case 'snooze-for': callWindow('snoozeFor', [parseInt(el.dataset.amount||'0',10), el.dataset.unit]); break;
      case 'close-snooze-modal': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeSnoozeModal', []); break;
      case 'submit-snooze': callWindow('submitSnooze', []); break;
      case 'save-new-category': callWindow('saveNewCategory', []); break;
      case 'close-add-category-modal': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddCategoryModal', []); break;
      case 'open-add-habit-modal': callWindow('openAddHabitModal', []); break;
      case 'navigate-to-habit-category': callWindow('navigateToHabitCategory', [getCat(el)]); break;
      case 'delete-habit-category': callWindow('deleteHabitCategory', [getCat(el)]); break;
      case 'open-edit-habit-category-modal': callWindow('openEditHabitCategoryModal', [getCat(el)]); break;
      case 'add-habit-from-input': callWindow('addHabitFromInput', [el]); break;
      case 'promote-habit': callWindow('promoteHabit', [getId(el)||el.dataset.habitId]); break;
      case 'mark-habit-done': callWindow('markHabitDone', [el.dataset.habitId||getId(el), el]); break;
      case 'open-habit-history': callWindow('openHabitHistory', [el.dataset.habitId||getId(el)]); break;
      case 'open-edit-habit-modal': callWindow('openEditHabitModal', [el.dataset.habitId||getId(el)]); break;
      case 'delete-habit': callWindow('deleteHabit', [el.dataset.habitId||getId(el)]); break;
      case 'edit-habit-last-done': callWindow('editHabitLastDone', [el.dataset.habitId||getId(el), e, el]); break;
      case 'edit-habit-inline': callWindow('editHabitInline', [el.dataset.habitId||getId(el)]); break;
      case 'close-add-habit-modal': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddHabitModal', []); break;
      case 'save-new-habit': callWindow('saveNewHabit', []); break;
      case 'close-edit-habit-modal': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeEditHabitModal', []); break;
      case 'save-edit-habit': callWindow('saveEditHabit', []); break;
      case 'close-habit-history-modal': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeHabitHistoryModal', []); break;
      case 'close-add-habit-category-modal': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddHabitCategoryModal', []); break;
      case 'save-new-habit-category': callWindow('saveNewHabitCategory', []); break;
      case 'close-edit-habit-category-modal': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeEditHabitCategoryModal', []); break;
      case 'save-edit-habit-category': callWindow('saveEditHabitCategory', []); break;
      case 'edit-habit-completion': callWindow('editHabitCompletion', [el.dataset.id||getId(el), el]); break;
      case 'delete-habit-completion': callWindow('deleteHabitCompletion', [el.dataset.id||getId(el)]); break;
      case 'save-habit-completion': callWindow('saveHabitCompletion', [el.dataset.id||getId(el)]); break;
      case 'cancel-edit-completion': callWindow('cancelEditCompletion', [el.dataset.id||getId(el)]); break;
      case 'navigate-habit-calendar': callWindow('navigateHabitCalendar', [parseInt(el.dataset.delta||'0',10)]); break;
      case 'navigate-habit-calendar-today': callWindow('navigateHabitCalendarToday', []); break;
      case 'toggle-habit-cal-scale': callWindow('toggleHabitCalScale', []); break;
      case 'navigate-to-flash-deck': callWindow('navigateToFlashDeck', [el.dataset.deck||getId(el)]); break;
      case 'quick-add-draft': callWindow('quickAddDraft', []); break;
      case 'update-proposed-deck': callWindow('updateProposedDeck', [getId(el), el.value||el.dataset.deck]); break;
      case 'accept-proposal': callWindow('acceptProposal', [getId(el)]); break;
      case 'edit-proposal': callWindow('editProposal', [getId(el)]); break;
      case 'toggle-feedback-input': callWindow('toggleFeedbackInput', [getId(el)]); break;
      case 'reject-proposal': callWindow('rejectProposal', [getId(el)]); break;
      case 'submit-feedback': callWindow('submitFeedback', [getId(el)]); break;
      case 'request-proposal': callWindow('requestProposal', [getId(el)]); break;
      case 'start-inline-edit-draft': callWindow('startInlineEditDraft', [getId(el), el]); break;
      case 'delete-draft': callWindow('deleteDraft', [getId(el)]); break;
      case 'prompt-flash-shortname': callWindow('promptFlashShortname', [el.dataset.deck||getId(el)]); break;
      case 'open-add-flashcard': callWindow('openAddFlashcardModal', [el.dataset.deck||getId(el)]); break;
      case 'delete-deck': callWindow('deleteDeck', [el.dataset.deck||getId(el)]); break;
      case 'start-text-practice': callWindow('startTextPractice', [el.dataset.scope||el.dataset.deck||'__all']); break;
      case 'open-add-text': callWindow('openAddTextModal', [el.dataset.deck||getId(el)]); break;
      case 'open-edit-flashcard': callWindow('openEditFlashcardModal', [getId(el)]); break;
      case 'delete-flashcard': callWindow('deleteFlashcard', [getId(el)]); break;
      case 'close-add-draft': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddDraftModal', []); break;
      case 'save-new-draft': callWindow('saveNewDraft', []); break;
      case 'close-edit-proposal': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeEditProposalModal', []); break;
      case 'save-edited-proposal': callWindow('saveEditedProposal', [getId(el)]); break;
      case 'close-add-flashcard': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddFlashcardModal', []); break;
      case 'save-new-flashcard': callWindow('saveNewFlashcard', []); break;
      case 'close-edit-flashcard': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeEditFlashcardModal', []); break;
      case 'save-edit-flashcard': callWindow('saveEditFlashcard', []); break;
      case 'close-add-flash-deck': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddFlashDeckModal', []); break;
      case 'select-deck-type': callWindow('selectDeckType', [el.dataset.type]); break;
      case 'save-new-flash-deck': callWindow('saveNewFlashDeck', []); break;
      case 'end-practice': callWindow('endPractice', []); break;
      case 'reveal-card': callWindow('revealCard', []); break;
      case 'rate-card': callWindow('rateCard', [el.dataset.rating]); break;
      case 'start-text-practice-for-text': callWindow('startTextPracticeForText', [getId(el)]); break;
      case 'open-edit-text': callWindow('openEditTextModal', [getId(el)]); break;
      case 'delete-text': callWindow('deleteText', [getId(el)]); break;
      case 'close-add-text': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddTextModal', []); break;
      case 'save-new-text': callWindow('saveNewText', []); break;
      case 'close-edit-text': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeEditTextModal', []); break;
      case 'save-edit-text': callWindow('saveEditText', []); break;
      case 'end-text-practice': callWindow('endTextPractice', []); break;
      case 'handle-line-click': { var idx = el.dataset.lineIdx || el.dataset.line || el.dataset.index; if (window.handleLineClick) window.handleLineClick({ target: el }, idx); else callWindow('handleLineClick', [parseInt(idx||'0',10)]); } break;
      case 'submit-text-review': callWindow('submitTextReview', []); break;
      case 'continue-text-same-text': callWindow('continueTextSameText', []); break;
      case 'toggle-draft-slider': callWindow('toggleDraftSlider', []); break;
      case 'archive-project': callWindow('archiveProject', [getId(el)]); break;
      case 'unarchive-project': callWindow('unarchiveProject', [getId(el)]); break;
      case 'delete-project': callWindow('deleteProject', [getId(el)]); break;
      case 'copy-project-title': callWindow('copyProjectTitle', [getId(el)]); break;
      case 'navigate-to-project': callWindow('navigateToProject', [getId(el)]); break;
      case 'toggle-expand-project': callWindow('toggleExpandProject', [getId(el)]); break;
      case 'open-edit-project': callWindow('openEditProjectModal', [getId(el)]); break;
      case 'close-task-expand': callWindow('closeTaskExpandModal', []); break;
      case 'open-project-prompt': callWindow('openProjectPrompt', [getId(el)]); break;
      case 'add-task': callWindow('addTask', [getId(el)]); break;
      case 'update-task-status': callWindow('updateTaskStatus', [getId(el)||el.dataset.taskId, el.dataset.status, el]); break;
      case 'open-revision-modal': callWindow('openRevisionModal', [el.dataset.taskId||getId(el)]); break;
      case 'prompt-edit-task': { var tid = getId(el)||el.dataset.taskId; var st = el.dataset.status; callWindow('promptEditTask', [tid, st, el]); } break;
      case 'delete-task': callWindow('deleteTask', [getId(el)||el.dataset.taskId]); break;
      case 'toggle-archived-tasks': callWindow('toggleArchivedTasks', []); break;
      case 'delete-all-archived-tasks': callWindow('deleteAllArchivedTasks', []); break;
      case 'approve-task-and-close': { var atId = el.dataset.taskId||getId(el); var atSt = el.dataset.status; if (window.updateTaskStatus) window.updateTaskStatus(atId, atSt, el); callWindow('closeRevisionModal', []); } break;
      case 'close-and-open-revision': { var coId = el.dataset.taskId||getId(el); var coSt = el.dataset.status; if (window.updateTaskStatus) window.updateTaskStatus(coId, coSt, el); callWindow('closeRevisionModal', []); if (window.openRevisionModal) setTimeout(function(){ window.openRevisionModal(coId); }, 120); } break;
      case 'open-add-birthday': callWindow('openAddBirthdayModal', []); break;
      case 'navigate-to-birthday-section': callWindow('navigateToBirthdaySection', [el.dataset.key||el.dataset.category||getCat(el)]); break;
      case 'handle-avatar-click': callWindow('handleAvatarClick', [getId(el)]); break;
      case 'open-edit-birthday': callWindow('openEditBirthdayModal', [getId(el)]); break;
      case 'delete-birthday': callWindow('deleteBirthday', [getId(el)]); break;
      case 'pick-new-birthday-avatar': callWindow('pickNewBirthdayAvatar', []); break;
      case 'clear-new-birthday-avatar': callWindow('clearNewBirthdayAvatar', []); break;
      case 'close-add-birthday': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddBirthdayModal', []); break;
      case 'save-new-birthday': callWindow('saveNewBirthday', []); break;
      case 'close-edit-birthday': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeEditBirthdayModal', []); break;
      case 'save-edit-birthday': callWindow('saveEditBirthday', []); break;
      case 'remove-avatar': callWindow('removeAvatar', [getId(el)]); break;
      case 'pick-avatar-file': callWindow('pickAvatarFile', [getId(el)]); break;
      case 'close-avatar-preview': callWindow('closeAvatarPreviewModal', []); break;
      case 'open-add-list': callWindow('openAddListModal', []); break;
      case 'navigate-to-list': callWindow('navigateToList', [el.dataset.listId||el.dataset.id||getId(el)]); break;
      case 'open-edit-list': callWindow('openEditListModal', [getId(el)]); break;
      case 'delete-list': callWindow('deleteList', [getId(el)]); break;
      case 'quick-add-list-item': callWindow('quickAddListItem', [el.dataset.listId||getId(el)]); break;
      case 'toggle-list-item-check': callWindow('toggleListItemCheck', [getId(el)]); break;
      case 'edit-list-item-inline': callWindow('editListItemInline', [getId(el)]); break;
      case 'delete-list-item': callWindow('deleteListItem', [getId(el)]); break;
      case 'close-add-list': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddListModal', []); break;
      case 'save-new-list': callWindow('saveNewList', []); break;
      case 'close-edit-list': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeEditListModal', []); break;
      case 'save-edit-list': callWindow('saveEditList', []); break;
      case 'share-list-item-from-add': callWindow('shareListItemFromAdd', [el.dataset.listId||el]); break;
      case 'open-add-vestiaire': callWindow('openAddVestiaireModal', []); break;
      case 'navigate-to-vestiaire-cat': callWindow('navigateToVestiaireCat', [getCat(el)]); break;
      case 'open-add-vestiaire-category': callWindow('openAddVestiaireCategoryModal', []); break;
      case 'open-edit-vestiaire': callWindow('openEditVestiaireModal', [getId(el)]); break;
      case 'delete-vestiaire': callWindow('deleteVestiaire', [getId(el)]); break;
      case 'edit-vestiaire-inline': callWindow('editVestiaireInline', [getId(el)]); break;
      case 'edit-vestiaire-brand-inline': callWindow('editVestiaireBrandInline', [getId(el)]); break;
      case 'cycle-vestiaire-status': callWindow('cycleVestiaireStatus', [getId(el)]); break;
      case 'open-edit-vestiaire-category': callWindow('openEditVestiaireCategoryModal', [getCat(el)]); break;
      case 'delete-vestiaire-category': callWindow('deleteVestiaireCategory', [getCat(el)]); break;
      case 'close-add-vestiaire': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddVestiaireModal', []); break;
      case 'save-new-vestiaire': callWindow('saveNewVestiaire', []); break;
      case 'close-add-vestiaire-category': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeAddVestiaireCategoryModal', []); break;
      case 'save-new-vestiaire-category': callWindow('saveNewVestiaireCategory', []); break;
      case 'close-edit-vestiaire': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeEditVestiaireModal', []); break;
      case 'save-edit-vestiaire': callWindow('saveEditVestiaire', []); break;
      case 'close-edit-vestiaire-category': if (el.dataset.overlayClose!==undefined && e.target!==el) break; callWindow('closeEditVestiaireCategoryModal', []); break;
      case 'save-edit-vestiaire-category': callWindow('saveEditVestiaireCategory', []); break;
      case 'send-auth-from-sharing': callWindow('sendAuthFromSharing', []); break;
      case 'sign-out-from-sharing': callWindow('signOutFromSharing', []); break;
      case 'sharing-copy-link': callWindow('sharingCopyLink', [getId(el)||el.dataset.groupId]); break;
      case 'sharing-leave-group': callWindow('sharingLeaveGroup', [el.dataset.groupId||getId(el)]); break;
      case 'sharing-unjoin-group': callWindow('sharingUnjoinGroup', [el.dataset.groupId||getId(el)]); break;
      case 'sharing-copy-member-link': callWindow('sharingCopyMemberLink', [el.dataset.groupId, el.dataset.token]); break;
      case 'sharing-remove-member': callWindow('sharingRemoveMember', [el.dataset.groupId, el.dataset.email||el.dataset.memberEmail]); break;
      case 'sharing-invite': callWindow('sharingInvite', [el.dataset.groupId||getId(el)]); break;
      case 'sharing-delete-group': callWindow('sharingDeleteGroup', [el.dataset.groupId||getId(el)]); break;
      case 'sharing-create-group': callWindow('sharingCreateGroup', []); break;
      case 'sharing-create-group-submit': callWindow('sharingCreateGroupSubmit', []); break;
      case 'sharing-copy-link-value': callWindow('sharingCopyLinkValue', []); break;
      case 'sharing-open-join-picker': callWindow('sharingOpenJoinPicker', [el.dataset.folderId||getId(el)]); break;
      case 'submit-share-popover': callWindow('submitSharePopover', []); break;
      case 'sharing-complete-submit': callWindow('sharingCompleteSubmit', [el.dataset.groupId, el.dataset.itemId]); break;
      case 'welcome-set-priority': e.stopPropagation(); callWindow('welcomeSetPriority', [el.dataset.todoId||getId(el), el.dataset.priority]); break;
      case 'welcome-open-priority-picker': callWindow('welcomeOpenPriorityPicker', [el.dataset.todoId||getId(el), e, el]); break;
      case 'welcome-toggle-todo': { var wDone = el.dataset.done === 'true'; callWindow('welcomeToggleTodo', [el.dataset.todoId||getId(el), wDone]); } break;
      case 'welcome-snooze': callWindow('welcomeSnooze', [el.dataset.todoId||getId(el)]); break;
      case 'welcome-delete-todo': callWindow('welcomeDeleteTodo', [el.dataset.todoId||getId(el)]); break;
      case 'welcome-mark-habit-done': callWindow('welcomeMarkHabitDone', [el.dataset.habitId||getId(el), el]); break;
      case 'welcome-open-habit-history': callWindow('welcomeOpenHabitHistory', [el.dataset.habitId||getId(el)]); break;
      case 'welcome-delete-habit': callWindow('welcomeDeleteHabit', [el.dataset.habitId||getId(el)]); break;
      case 'scroll-to-welcome-bucket': callWindow('scrollToWelcomeBucket', [el.dataset.bucketId||el.dataset.id]); break;
      case 'welcome-add-todo-from-quick': { var wInp = el.closest('.welcome-quick-add')?.querySelector('.todo-cat-input'); if (wInp) callWindow('addTodoToCategory', [wInp]); } break;
      case 'welcome-add-habit-from-quick': { var whInp = el.closest('.welcome-quick-add')?.querySelector('.todo-cat-input'); if (whInp) callWindow('addHabitFromInput', [whInp]); } break;
      case 'go-to-practice': callWindow('goToPractice', []); break;
      case 'go-to-revise': callWindow('goToRevise', []); break;
      case 'expand-meta': callWindow('expandMeta', [el.dataset.metaId||el.dataset.id, el.dataset.metaField||el.dataset.field]); break;
      case 'collapse-meta': callWindow('collapseMeta', [el.dataset.metaId||el.dataset.id, el.dataset.metaField||el.dataset.field]); break;
      case 'show-migration-modal': callWindow('showMigrationModal', []); break;
      case 'dismiss-schema-banner': callWindow('dismissSchemaBanner', []); break;
      case 'check-migration-status': callWindow('checkMigrationStatus', []); break;
      case 'close-migration-modal': callWindow('closeMigrationModal', []); break;
      case 'close-compare-modal': callWindow('closeCompareModal', []); break;
      default: {
        var camel = action.replace(/-([a-z])/g, function(_,c){ return c.toUpperCase(); });
        if (window[camel] && typeof window[camel] === 'function') {
          var id = getId(el);
          try { if (id) window[camel](id, el); else window[camel](el, e); } catch(_) { try { window[camel](); } catch(__){} }
        }
      } break;
    }
  }
  function handleChange(e) {
    var el = getActionEl(e.target);
    if (!el) return;
    var action = el.dataset.action;
    if (!action) return;
    switch (action) {
      case 'sort-projects': callWindow('renderProjectGrid', []); break;
      case 'sort-todos': callWindow('renderTodos', []); break;
      case 'sort-habits': callWindow('renderHabits', []); break;
      case 'sort-birthdays': callWindow('renderBirthdays', []); break;
      case 'sort-vestiaire': callWindow('renderVestiaire', []); break;
      case 'sort-flashcards': callWindow('renderFlashcards', []); break;
      case 'sort-lists': callWindow('renderLists', []); break;
      case 'handle-model-change': callWindow('handleModelChange', []); break;
      case 'update-next-sibling-category': { var nxt = el.nextElementSibling; if (nxt && nxt.dataset) nxt.dataset.category = el.value; } break;
      case 'update-proposed-deck': callWindow('updateProposedDeck', [el.dataset.id||el.dataset.todoId, el.value]); break;
      default: break;
    }
  }
  function handleInput(e) {
    var el = getActionEl(e.target);
    if (!el) return;
    var action = el.dataset.action;
    if (!action) return;
    switch (action) {
      case 'filter-projects': callWindow('filterProjects', [e]); break;
      case 'filter-todos': callWindow('filterTodos', [e]); break;
      case 'filter-habits': callWindow('filterHabits', [e]); break;
      case 'filter-birthdays': callWindow('filterBirthdays', [e]); break;
      case 'filter-vestiaire': callWindow('filterVestiaire', [e]); break;
      case 'filter-flashcards': callWindow('filterFlashcards', [e]); break;
      case 'filter-lists': callWindow('filterLists', [e]); break;
      default: break;
    }
  }
  function handleKeydown(e) {
    var el = getActionEl(e.target);
    if (!el) return;
    var action = el.dataset.action;
    if (!action) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      switch (action) {
        case 'save-edit-category-on-enter': e.preventDefault(); callWindow('saveEditCategory', []); break;
        case 'save-new-category-on-enter': e.preventDefault(); callWindow('saveNewCategory', []); break;
        case 'save-new-habit-on-enter': e.preventDefault(); callWindow('saveNewHabit', []); break;
        case 'save-new-habit-category-on-enter': e.preventDefault(); callWindow('saveNewHabitCategory', []); break;
        case 'save-edit-habit-category-on-enter': e.preventDefault(); callWindow('saveEditHabitCategory', []); break;
        case 'save-new-list-on-enter': e.preventDefault(); callWindow('saveNewList', []); break;
        case 'save-edit-list-on-enter': e.preventDefault(); callWindow('saveEditList', []); break;
        case 'save-new-vestiaire-on-enter': e.preventDefault(); callWindow('saveNewVestiaire', []); break;
        case 'save-new-vestiaire-category-on-enter': e.preventDefault(); callWindow('saveNewVestiaireCategory', []); break;
        case 'save-edit-vestiaire-category-on-enter': e.preventDefault(); callWindow('saveEditVestiaireCategory', []); break;
        case 'save-new-birthday-on-enter': e.preventDefault(); callWindow('saveNewBirthday', []); break;
        case 'sharing-invite-on-enter': e.preventDefault(); if (window.sharingInvite) { var gid = el.dataset.groupId||el.dataset.id; window.sharingInvite(gid); } break;
        case 'sharing-create-group-on-enter': e.preventDefault(); callWindow('sharingCreateGroupSubmit', []); break;
        case 'add-todo-to-category': e.preventDefault(); if (window.addTodoToCategory) window.addTodoToCategory(el); break;
        case 'add-habit-from-input': e.preventDefault(); if (window.addHabitFromInput) window.addHabitFromInput(el); break;
        case 'handle-draft-input': e.preventDefault(); if (window.quickAddDraft) window.quickAddDraft(); break;
        case 'task-input': e.preventDefault(); { var pid = el.dataset.id; if (pid && window.addTask) window.addTask(pid); else if (window.handleTaskInput) window.handleTaskInput(e); } break;
        case 'quick-add-input': e.preventDefault(); { var lid = el.dataset.listId||el.dataset.id; if (lid && window.quickAddListItem) window.quickAddListItem(lid); } break;
        case 'welcome-quick-add-todo-on-enter': e.preventDefault(); if (window.addTodoToCategory) window.addTodoToCategory(el); break;
        case 'welcome-quick-add-habit-on-enter': e.preventDefault(); if (window.addHabitFromInput) window.addHabitFromInput(el); break;
        case 'quick-add-list-item': e.preventDefault(); { var qlid = el.dataset.listId||el.dataset.id; if (qlid && window.quickAddListItem) window.quickAddListItem(qlid); } break;
        default: break;
      }
    }
    if (action === 'task-input' && e.key === 'Enter') {
      if (window.handleTaskInput) window.handleTaskInput(e);
    }
  }
  document.addEventListener('click', handleClick, false);
  document.addEventListener('change', handleChange, false);
  document.addEventListener('input', handleInput, false);
  document.addEventListener('keydown', handleKeydown, false);
  window.__delegationStats = { listeners: 4, phase2: true };
})();
