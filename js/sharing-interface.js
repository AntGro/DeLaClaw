// ===================================================================
// SHARING INTERFACE — canonical contract for all sharing adapters
// ===================================================================
//
// Both adapters (Drive, Supabase) MUST conform to this interface.
// The factory in sharing.js validates every adapter at creation time
// using validateSharingAdapter() — a missing or mistyped method is
// a hard error, not a silent runtime crash.
//
// Data shapes
// -----------
//
// SharingUser   { memberId?: string, displayName: string, backendUserId?: string }
//
// GroupMember   { memberId: string, role: 'creator'|'owner'|'member',
//                 status: 'pending'|'joined'|'revoked', displayName: string,
//                 invitedLabel?: string, joinedAt?: string|null }
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
// memberId + group-local displayName. Raw emails must not be stored in
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
  createGroup:              'fn',   // (name: string) => Promise<Group>
  loadAll:                  'fn',   // () => Promise<Group[]>
  deleteGroup:              'fn',   // (groupId) => Promise<void>

  // ── Groups — membership ─────────────────────────────────────
  inviteUser:               'fn',   // (groupId, inviteTargetOrLabel) => Promise<void>
  removeUser:               'fn',   // (groupId, memberId) => Promise<void>
  leaveGroup:               'fn',   // (groupId) => Promise<void>

  // ── Groups — join flow ──────────────────────────────────────
  tryDirectJoin:            'fn',   // (connectionRef) => Promise<Group|null>
  joinWithFileIds:          'fn',   // (connectionRef, fileIds) => Promise<Group>
  unjoinGroup:              'fn',   // (groupId) => Promise<void>

  // ── Groups — queries ────────────────────────────────────────
  getAllGroups:              'fn',   // () => Group[]
  getGroup:                 'fn',   // (groupId) => Group|null
  getCurrentMember:         'fn',   // (groupId) => GroupMember|null | Promise<GroupMember|null>
  getAgentSafeGroup:        'fn',   // (groupId) => Group|null
  getItems:                 'fn',   // (groupId, itemType?) => SharedItem[]
  getGroupByFolderId:       'fn',   // (connectionRef) => Group|undefined
  getInviteLink:            'fn',   // (groupId) => string|null
  isJoinedViaLink:          'fn',   // (groupId) => boolean
  getRevokedMembers:        'fn',   // (groupId) => GroupMember[]  (status='revoked')

  // ── Items — queries ─────────────────────────────────────────
  getAllSharedItems:         'fn',   // (itemType?) => SharedItem[]
  getAllSharedHabits:        'fn',   // () => SharedItem[]
  getAllSharedTodos:         'fn',   // () => SharedItem[]
  getAllSharedListItems:     'fn',   // () => SharedItem[]

  // ── Items — invite codes ────────────────────────────────────
  getMemberInviteLink:       'any',  // (groupId, token) => string|null | null for Drive (uses getInviteLink)

  // ── Items — CRUD ────────────────────────────────────────────
  addItem:                  'fn',   // (groupId, itemData) => Promise<SharedItem>
  updateItem:               'fn',   // (groupId, itemId, changes) => Promise<SharedItem>
  deleteItem:               'fn',   // (groupId, itemId) => Promise<void>
  completeItem:             'fn',   // (groupId, itemId, doneBy?) => Promise<SharedItem>
  uncompleteItem:           'fn',   // (groupId, itemId) => Promise<SharedItem>

  // ── Items — habits (type-specific) ──────────────────────────
  addSharedHabit:           'fn',   // (groupId, habitData) => Promise<SharedItem>
  updateSharedHabit:        'fn',   // (groupId, sharedId, changes) => Promise<SharedItem>
  deleteSharedHabit:        'fn',   // (groupId, sharedId) => Promise<void>
  addSharedHabitCompletion:  'fn',  // (groupId, sharedId, completion) => Promise<SharedItem>

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
 * @param {string} label — 'googledrive' | 'supabase' (for error messages)
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
