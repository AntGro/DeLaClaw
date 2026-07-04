// ===================================================================
// SHARING INTERFACE — backend-agnostic sharing contract
// ===================================================================
//
// Any sharing backend (Drive, Supabase, Local, …) must implement this
// interface.  The UI layer (sharing-ui.js) and data layers (todos.js,
// habits.js, lists.js) call only these methods — never backend-specific
// APIs.
//
// Data model:
//   - Shared data lives on the GROUP CREATOR's backend.
//   - Group members access it through an adapter matching the creator's
//     backend type — members do NOT need the same backend.
//   - Each member's local DB stores thin pointers (shared_id,
//     shared_group_id) plus local-only fields (category, sort_order,
//     next_due, style attributes, etc.).
//
// Group metadata carries `backendType` so the app knows which adapter
// to instantiate when a member joins a group hosted on a different
// backend.
//
// ===================================================================

/**
 * @typedef {Object} SharingUser
 * @property {string} email
 * @property {string} [displayName]
 */

/**
 * @typedef {Object} GroupMember
 * @property {string} email
 * @property {'creator'|'member'} role
 * @property {boolean} [accepted]
 */

/**
 * @typedef {Object} Group
 * @property {string}  id
 * @property {string}  name
 * @property {string}  backendType    — 'googledrive' | 'supabase' | 'local' | …
 * @property {string}  createdBy      — creator's email
 * @property {string}  [folderId]     — Drive-specific: shared folder ID
 * @property {string}  [connectionUri] — Supabase/Local-specific: endpoint
 * @property {GroupMember[]} members
 */

/**
 * @typedef {Object} SharedItem
 * @property {string}  id
 * @property {string}  group_id
 * @property {'todo'|'habit'|'list_item'} item_type
 * @property {Object}  payload         — type-specific data (text, name, freq…)
 * @property {string[]} [assignees]    — member emails (optional, e.g. todos)
 * @property {boolean} done
 * @property {string[]} [done_by]
 * @property {string}  [done_at]
 * @property {string}  created_by
 * @property {string}  created_at
 * @property {string}  updated_at
 */

/**
 * Abstract sharing interface.
 *
 * Every method is async.  Backends that don't support a capability
 * (e.g. Local can't inviteUser by email) should throw with a clear
 * message — the UI will catch and toast it.
 *
 * @interface SharingAdapter
 */
const SharingInterface = {

  // ── Identity ────────────────────────────────────────────────────

  /** @returns {Promise<SharingUser>} Current authenticated user. */
  async getCurrentUser() {},

  // ── Groups — lifecycle ──────────────────────────────────────────

  /** Create a new group. Creator = current user. */
  async createGroup(name) {},

  /** Load all groups (created + joined). Fires 'sharing-changed'. */
  async loadAll() {},

  /** Delete a group (creator only — removes all shared data). */
  async deleteGroup(groupId) {},

  // ── Groups — membership ─────────────────────────────────────────

  /** Invite a user by email (creator only). */
  async inviteUser(groupId, email) {},

  /** Remove a member (creator only). */
  async removeUser(groupId, email) {},

  /** Leave a group (non-creator). */
  async leaveGroup(groupId) {},

  // ── Groups — join flow ──────────────────────────────────────────

  /**
   * Try to join a group directly given a connection reference.
   * For Drive: folderId.  For Supabase: project URL + token.
   * @returns {Promise<Group|null>}
   */
  async tryDirectJoin(connectionRef) {},

  /**
   * Join with explicit resource IDs (Drive Picker flow).
   * Backends that don't need this can throw 'not supported'.
   */
  async joinWithFileIds(connectionRef, fileIds) {},

  /** Unjoin a link-joined group (remove local reference, keep data). */
  async unjoinGroup(groupId) {},

  // ── Groups — queries ────────────────────────────────────────────

  /** @returns {Group[]} All loaded groups. */
  getAllGroups() {},

  /** @returns {SharedItem[]} All items across all groups. */
  getAllSharedItems() {},

  /** @returns {SharedItem[]} Items in one group, optionally filtered by type. */
  getItems(groupId, itemType) {},

  /** @returns {Group|undefined} Group by its folder/connection ID. */
  getGroupByFolderId(connectionRef) {},

  /** @returns {string|null} Invite link for a group. */
  getInviteLink(groupId) {},

  /** @returns {boolean} Whether this group was joined via link (vs created). */
  isJoinedViaLink(groupId) {},

  // ── Items — CRUD ────────────────────────────────────────────────

  /**
   * Add a shared item.
   * @param {string} groupId
   * @param {{id?, item_type, payload, assignees?}} itemData
   * @returns {Promise<SharedItem>}
   */
  async addItem(groupId, itemData) {},

  /**
   * Update a shared item (partial merge into item fields).
   * @param {string} groupId
   * @param {string} itemId
   * @param {Object} changes — merged via Object.assign
   * @returns {Promise<SharedItem>}
   */
  async updateItem(groupId, itemId, changes) {},

  /** Delete a shared item. */
  async deleteItem(groupId, itemId) {},

  /** Mark an item done. */
  async completeItem(groupId, itemId, doneBy) {},

  /** Mark an item not done. */
  async uncompleteItem(groupId, itemId) {},

  // ── Items — type-specific (habits) ──────────────────────────────

  /** Add a shared habit (habit-specific fields). */
  async addSharedHabit(groupId, habitData) {},

  /** Update a shared habit. */
  async updateSharedHabit(groupId, sharedId, changes) {},

  /** Delete a shared habit. */
  async deleteSharedHabit(groupId, sharedId) {},

  /** Add a completion entry to a shared habit. */
  async addSharedHabitCompletion(groupId, sharedId, completion) {},

  // ── Sync ────────────────────────────────────────────────────────

  /** Poll for remote changes. Fires 'sharing-changed' on updates. */
  async poll() {},

  /** Force-save any pending writes. */
  async forceSave() {},

  /** Stop polling & clean up. */
  destroy() {},

  // ── Capabilities ────────────────────────────────────────────────

  /**
   * Optional Picker for file-based join flows (Drive).
   * Null if the backend doesn't need a picker.
   * @type {((connectionRef: string) => Promise<any[]>)|null}
   */
  openJoinPicker: null,
};

export { SharingInterface };
