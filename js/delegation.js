// Delegation for CSP-safe event handling — Phase 1 (index.html static)
// Replaces all inline onclick/onchange/oninput/onkeydown handlers with data-action attributes
// Performance: 4 document-level listeners (click, change, input, keydown) vs 109+ individual handlers
// - click: closest('[data-action]') is O(depth) ~5-10 levels, negligible (<0.1ms)
// - Early return if no data-action, so unrelated events cost ~0
// - No per-element listeners, reduces memory and improves dynamic content handling

(function () {
  function getActionEl(target) {
    if (!target) return null;
    // check if target itself has data-action or closest ancestor
    if (target.dataset && target.dataset.action) return target;
    return target.closest ? target.closest('[data-action]') : null;
  }

  function handleClick(e) {
    var el = getActionEl(e.target);
    if (!el) return;
    var action = el.dataset.action;
    if (!action) return;

    // Overlay closers should only fire when clicking the overlay itself
    if (action === 'overlay-close-settings' || action === 'overlay-close-auth') {
      if (e.target !== el) return;
    }

    // Prevent default for buttons/links that might submit
    // but don't prevent for inputs etc
    var tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A') {
      // let native behavior still occur unless we need to prevent
      // for our actions we handle manually
    }

    switch (action) {
      // Views
      case 'switch-view':
        if (window.switchView && el.dataset.view) window.switchView(el.dataset.view);
        break;

      // Project filters
      case 'set-project-filter':
        if (window.setProjectFilter) window.setProjectFilter(el.dataset.filter);
        break;
      case 'set-todo-filter':
        if (window.setTodoFilter) window.setTodoFilter(el.dataset.filter);
        break;
      case 'set-habit-filter':
        if (window.setHabitFilter) window.setHabitFilter(el.dataset.filter);
        break;
      case 'set-birthday-filter':
        if (window.setBirthdayFilter) window.setBirthdayFilter(el.dataset.filter);
        break;
      case 'set-vestiaire-filter':
        if (window.setVestiaireFilter) window.setVestiaireFilter(el.dataset.filter);
        break;
      case 'set-flashcard-filter':
        if (window.setFlashcardFilter) window.setFlashcardFilter(el.dataset.filter);
        break;
      case 'set-habit-view-mode':
        if (window.setHabitViewMode) window.setHabitViewMode(el.dataset.view);
        break;

      // Sorts (change event but also handle click if triggered)
      case 'sort-projects':
        if (window.renderProjectGrid) window.renderProjectGrid();
        break;
      case 'sort-todos':
        if (window.renderTodos) window.renderTodos();
        break;
      case 'sort-habits':
        if (window.renderHabits) window.renderHabits();
        break;
      case 'sort-birthdays':
        if (window.renderBirthdays) window.renderBirthdays();
        break;
      case 'sort-vestiaire':
        if (window.renderVestiaire) window.renderVestiaire();
        break;
      case 'sort-flashcards':
        if (window.renderFlashcards) window.renderFlashcards();
        break;
      case 'sort-lists':
        if (window.renderLists) window.renderLists();
        break;
      case 'handle-model-change':
        if (window.handleModelChange) window.handleModelChange();
        break;

      // Open modals / actions
      case 'open-prompt-editor':
        if (window.openPromptEditor) window.openPromptEditor();
        break;
      case 'toggle-archived':
        if (window.toggleShowArchived) window.toggleShowArchived();
        break;
      case 'open-add-project':
        if (window.openAddProjectModal) window.openAddProjectModal();
        break;
      case 'open-add-category':
        if (window.openAddCategoryModal) window.openAddCategoryModal();
        break;
      case 'open-add-habit':
        if (window.openAddHabitModal) window.openAddHabitModal();
        break;
      case 'open-add-habit-category':
        if (window.openAddHabitCategoryModal) window.openAddHabitCategoryModal();
        break;
      case 'open-add-birthday':
        if (window.openAddBirthdayModal) window.openAddBirthdayModal();
        break;
      case 'open-add-vestiaire':
        if (window.openAddVestiaireModal) window.openAddVestiaireModal();
        break;
      case 'open-add-vestiaire-category':
        if (window.openAddVestiaireCategoryModal) window.openAddVestiaireCategoryModal();
        break;
      case 'open-add-flash-deck':
        if (window.openAddFlashDeckModal) window.openAddFlashDeckModal();
        break;
      case 'open-add-list':
        if (window.openAddListModal) window.openAddListModal();
        break;
      case 'open-import':
        if (window.openImportModal) window.openImportModal();
        break;
      case 'start-practice':
        if (window.startPractice) window.startPractice(el.dataset.scope || '__all');
        break;
      case 'start-text-practice':
        if (window.startTextPractice) window.startTextPractice(el.dataset.scope || '__all');
        break;

      // Search
      case 'toggle-search':
        if (window.toggleSearch) window.toggleSearch(el);
        break;
      case 'clear-search':
        if (window.clearPageSearch) window.clearPageSearch(el);
        break;

      // Modal close/save
      case 'close-add-project':
        if (window.closeAddProjectModal) window.closeAddProjectModal();
        break;
      case 'save-new-project':
        if (window.saveNewProject) window.saveNewProject();
        break;
      case 'close-revision':
        if (window.closeRevisionModal) window.closeRevisionModal();
        break;
      case 'submit-revision':
        if (window.submitRevision) window.submitRevision();
        break;
      case 'close-prompt-editor':
        if (window.closePromptEditor) window.closePromptEditor();
        break;
      case 'save-global-prompt':
        if (window.saveGlobalPrompt) window.saveGlobalPrompt();
        break;
      case 'close-project-prompt':
        if (window.closeProjectPrompt) window.closeProjectPrompt();
        break;
      case 'save-project-prompt':
        if (window.saveProjectPrompt) window.saveProjectPrompt();
        break;
      case 'close-edit-project':
        if (window.closeEditProjectModal) window.closeEditProjectModal();
        break;
      case 'save-edit-project':
        if (window.saveEditProject) window.saveEditProject();
        break;
      case 'close-edit-category':
        if (window.closeEditCategoryModal) window.closeEditCategoryModal();
        break;
      case 'save-edit-category':
        if (window.saveEditCategory) window.saveEditCategory();
        break;
      case 'close-delete-confirm':
        if (window.closeDeleteConfirm) window.closeDeleteConfirm();
        break;
      case 'execute-delete-confirm':
        if (window.executeDeleteConfirm) window.executeDeleteConfirm();
        break;

      // Settings
      case 'close-settings':
        if (window.closeSettings) window.closeSettings();
        break;
      case 'overlay-close-settings':
        if (window.closeSettings) window.closeSettings();
        break;
      case 'overlay-close-auth':
        {
          var overlay = document.getElementById('authPromptOverlay');
          if (overlay) overlay.classList.remove('visible');
        }
        break;
      case 'switch-settings-pane':
        if (window.switchSettingsPane && el.dataset.pane) window.switchSettingsPane(el.dataset.pane);
        break;
      case 'toggle-theme':
        if (window.toggleTheme) window.toggleTheme();
        break;
      case 'toggle-nvidia-key-visibility':
        if (window.toggleNvidiaKeyVisibility) window.toggleNvidiaKeyVisibility();
        break;
      case 'save-nvidia-key':
        if (window.saveNvidiaKey) window.saveNvidiaKey();
        break;
      case 'apply-custom-model':
        if (window.applyCustomModel) window.applyCustomModel();
        break;
      case 'test-nvidia-api':
        if (window.testNvidiaApi) window.testNvidiaApi();
        break;
      case 'toggle-nvidia-usage':
        if (window.toggleNvidiaUsageDetail) window.toggleNvidiaUsageDetail();
        break;
      case 'export-backup':
        if (window.exportBackup) window.exportBackup();
        break;
      case 'export-to-drive':
        if (window.exportToGoogleDrive) window.exportToGoogleDrive();
        break;
      case 'import-backup':
        if (window.importBackup) window.importBackup();
        break;

      default:
        // Unknown action, ignore (may be handled by Phase 2 or other modules)
        break;
    }
  }

  function handleChange(e) {
    var el = getActionEl(e.target);
    if (!el) return;
    // Reuse same switch for change-driven actions
    switch (el.dataset.action) {
      case 'sort-projects':
        if (window.renderProjectGrid) window.renderProjectGrid();
        break;
      case 'sort-todos':
        if (window.renderTodos) window.renderTodos();
        break;
      case 'sort-habits':
        if (window.renderHabits) window.renderHabits();
        break;
      case 'sort-birthdays':
        if (window.renderBirthdays) window.renderBirthdays();
        break;
      case 'sort-vestiaire':
        if (window.renderVestiaire) window.renderVestiaire();
        break;
      case 'sort-flashcards':
        if (window.renderFlashcards) window.renderFlashcards();
        break;
      case 'sort-lists':
        if (window.renderLists) window.renderLists();
        break;
      case 'handle-model-change':
        if (window.handleModelChange) window.handleModelChange();
        break;
      default:
        break;
    }
  }

  function handleInput(e) {
    var el = getActionEl(e.target);
    if (!el) return;
    var action = el.dataset.action;
    // These expect the original input event with target.value
    switch (action) {
      case 'filter-projects':
        if (window.filterProjects) window.filterProjects(e);
        break;
      case 'filter-todos':
        if (window.filterTodos) window.filterTodos(e);
        break;
      case 'filter-habits':
        if (window.filterHabits) window.filterHabits(e);
        break;
      case 'filter-birthdays':
        if (window.filterBirthdays) window.filterBirthdays(e);
        break;
      case 'filter-vestiaire':
        if (window.filterVestiaire) window.filterVestiaire(e);
        break;
      case 'filter-flashcards':
        if (window.filterFlashcards) window.filterFlashcards(e);
        break;
      case 'filter-lists':
        if (window.filterLists) window.filterLists(e);
        break;
      default:
        break;
    }
  }

  function handleKeydown(e) {
    var el = getActionEl(e.target);
    if (!el) return;
    if (el.dataset.action === 'save-edit-category-on-enter') {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (window.saveEditCategory) window.saveEditCategory();
      }
    }
  }

  // Install listeners — 4 total instead of 109+
  // Use capture false (bubble) to let inner handlers stopPropagation if needed
  document.addEventListener('click', handleClick, false);
  document.addEventListener('change', handleChange, false);
  document.addEventListener('input', handleInput, false);
  document.addEventListener('keydown', handleKeydown, false);

  // Expose for debugging
  window.__delegationStats = {
    listeners: 4,
    replacedHandlers: 109
  };
})();
