// ===================================================================
// SHARING INTERFACE — canonical contract for all sharing adapters
// ===================================================================
//
// The Drive adapter MUST conform to this interface.
// The factory in sharing.js validates every adapter at creation time
// using validateSharingAdapter() — a missing or mistyped method is
// a hard error, not a silent runtime crash.
//
// Data shapes
// -----------
//
// SharingUser   { member_id?: string, display_name: string, backendUserId?: string }
//
// GroupMember   { member_id: string, /* deterministic per user: hash of their email, never the raw email.
//                                  Stable across invites, so a removed-then-reinvited member keeps the same ID. */
//                 role: 'creator'|'owner'|'member',
//                 status: 'pending'|'joined'|'left',
//                 display_name: string, /* user-chosen pseudo */
//                 invited_label?: string, joined_at?: string|null }
//
// Group         { id: string, name: string, backendType: string,
//                 created_by: string|null, members: GroupMember[], folderId?: string }
//
// SharedItem    { id: string, group_id: string, group_name?: string,
//                 item_type: 'todo'|'habit'|'list_item',
//                 payload?: object, assignees?: string[], done: boolean,
//                 done_by?: string[], created_by: string, created_at: string,
//                 updated_at: string }
//
// Identity invariant:
// Emails are permission material, not identity. Shared identity is
// member_id + group-local display_name. Raw emails must not be stored in
// shared group state or emitted into agent-readable data.
//
// ===================================================================

/**
 * Every key that a sharing adapter MUST expose.
 * Value = 'fn' (function/async function) or 'any' (any type, incl. null).
 */
export const SHARING_INTERFACE = {
  // ── Identity ────────────────────────────────────────────────
  getCurrentUser:           'fn',   // () => SharingUser | Promise<SharingUser>
  getCurrentMemberId:       'fn',   // (groupId) => Promise<string|null>

  // ── Groups — lifecycle ──────────────────────────────────────
  createGroup:              'fn',   // (name: string, onProgress?: (ev: {step, done, total}) => void) => Promise<Group>
  loadAll:                  'fn',   // () => Promise<Group[]>
  deleteGroup:              'fn',   // (groupId) => Promise<void> — creator-only, throws otherwise
  renameGroup:              'fn',   // (groupId, newName: string) => Promise<Group> — creator-only, throws otherwise
  deleteOwnedGroups:        'fn',   // () => Promise<void> — delete every group created by the user; throws on any failure (account-deletion flow)
  leaveJoinedGroups:        'fn',   // () => Promise<void> — leave every joined group (strict); throws on any failure (account-deletion flow)

  // ── Groups — membership ─────────────────────────────────────
  // inviteUser/removeUser are creator-only and throw otherwise.
  inviteUser:               'fn',   // (groupId, inviteTargetOrLabel) => Promise<void>
  removeUser:               'fn',   // (groupId, member_id) => Promise<void>
  unjoinGroup:              'fn',   // (groupId, opts?) => Promise<void> — the only leave path; opts.strict throws instead of warning (account-deletion flow)

  // ── Groups — join flow ──────────────────────────────────────
  // joinWithFileIds requires a matching pending invite (by emailHash) AND the
  // full required file set (getRequiredGroupFiles); Drive access alone is not
  // enough, and a partial file grant can never half-join.
  tryDirectJoin:            'fn',   // (connectionRef) => Promise<Group|null>
  joinWithFileIds:          'fn',   // (connectionRef, fileIds) => Promise<Group>
  getRequiredGroupFiles:    'fn',   // () => string[] — file keys a join must include
  mapDocsToFileIds:         'fn',   // (docs) => {key: fileId} — map Drive docs to required file keys
  reconnectGroup:           'fn',   // (groupId, newUrl, newAnonKey, token) => Promise<Group>

  // ── Groups — queries ────────────────────────────────────────
  getAllGroups:              'fn',   // () => Group[]
  getGroup:                 'fn',   // (groupId) => Group|null
  getCurrentMember:         'fn',   // (groupId) => GroupMember|null | Promise<GroupMember|null>
  getAgentSafeGroup:        'fn',   // (groupId) => Group|null
  getItems:                 'fn',   // (groupId, itemType?) => SharedItem[]
  getGroupByFolderId:       'fn',   // (connectionRef) => Group|undefined
  getInviteLink:            'fn',   // (groupId) => string|null
  isJoinedViaLink:          'fn',   // (groupId) => boolean

  // ── Items — queries ─────────────────────────────────────────
  getAllSharedItems:         'fn',   // (itemType?) => SharedItem[]
  getAllSharedHabits:        'fn',   // () => SharedItem[]
  getAllSharedTodos:         'fn',   // () => SharedItem[]
  getAllSharedListItems:     'fn',   // () => SharedItem[]

  // ── Items — invite codes ────────────────────────────────────
  getMemberInviteLink:       'any',  // (groupId, token) => string|null | null for Drive (uses getInviteLink)

  // ── Items — CRUD ────────────────────────────────────────────
  addItem:                  'fn',   // (groupId, itemData) => Promise<SharedItem>; itemData may carry onStaged(item), fired after in-memory staging, before the Drive upload; a failed upload rolls back the staging and rethrows
  updateItem:               'fn',   // (groupId, itemId, changes, opts?) => Promise<SharedItem>; opts.onStaged like addItem; a failed upload restores the previous in-memory values
  deleteItem:               'fn',   // (groupId, itemId, opts?) => Promise<void>; opts.onStaged like addItem; a failed upload restores the item and its intents
  completeItem:             'fn',   // (groupId, itemId, doneBy?, opts?) => Promise<SharedItem>
  uncompleteItem:           'fn',   // (groupId, itemId, opts?) => Promise<SharedItem>

  // ── Items — habits (type-specific) ──────────────────────────
  addSharedHabit:           'fn',   // (groupId, habitData, opts?) => Promise<SharedItem>; opts.onStaged like addItem
  updateSharedHabit:        'fn',   // (groupId, sharedId, changes, opts?) => Promise<SharedItem>; opts.onStaged like addItem
  deleteSharedHabit:        'fn',   // (groupId, sharedId, opts?) => Promise<void>; opts.onStaged like addItem
  addSharedHabitCompletion:  'fn',  // (groupId, sharedId, completion, opts?) => Promise<SharedItem>; opts.onStaged like addItem

  // ── Sync ────────────────────────────────────────────────────
  poll:                     'fn',   // () => Promise<boolean>
  forceSave:                'fn',   // () => Promise<void>
  startPolling:             'fn',   // () => void
  stopPolling:              'fn',   // () => void
  onUpdate:                 'fn',   // (fn) => void | unsubscribe
  destroy:                  'fn',   // () => void

  // ── Capabilities ────────────────────────────────────────────
  openJoinPicker:           'any',  // ((ref) => Promise<any[]>) | null
};

/**
 * Validate that `adapter` implements every required key.
 * Throws on the first violation — fail loud at init, not at runtime.
 *
 * @param {Object} adapter
 * @param {string} label — backend label (for error messages)
 */
export function validateSharingAdapter(adapter, label) {
  for (const [key, kind] of Object.entries(SHARING_INTERFACE)) {
    if (!(key in adapter)) {
      throw new Error(`Sharing adapter "${label}" is missing required key: ${key}`);
    }
    if (kind === 'fn' && typeof adapter[key] !== 'function') {
      throw new Error(
        `Sharing adapter "${label}": ${key} must be a function, got ${typeof adapter[key]}`
      );
    }
  }
}
