# Share Existing Items & Categories — Final Design

Reviewed: 2026-07-28

## Core pattern: delete-and-recreate

All share/unshare flows follow the same pattern: create the target object using existing functions, then delete the source. No in-place ID mutation.

## Approved decisions

### 1. Share action on existing items
Add a share button to existing TODOs, habits, and list items. Opens the group picker popover. Flow: create the shared object (reusing existing shared-item creation functions) → delete the personal object. The personal item does NOT keep its local ID.

### 2. Shared item stays in its current category
When sharing an existing item, it remains in the user's current category. `__shared__` is only for items received from others.

### 3. Already-shared items cannot be re-shared
If an item already has a `shared_group_id`, the share action is hidden or disabled. No multi-group sharing in v1.

### 4. Unshare / personal copy actions
- **Creator unshare**: creates a personal duplicate of the shared item, then deletes the shared item. Item becomes private, stays in current category.
- **Non-creator "copy to personal"**: creates a personal duplicate (placed in General category if currently in `__shared__`). Does NOT delete the shared item — it stays for other members.

### 5. Category bulk share (Option A — stateless)
One-time bulk action on a category header. For each item in the category:
- Not shared yet → share with the selected group
- Already shared (same or different group) → skip

No ongoing link. New items added later are not auto-shared. Memory-less.

### 9. Group deleted or left — cleanup
**Creator deletes group:**
- Confirmation modal with a toggle: convert shared items to personal copies vs delete them
- Warning shown if the group has active members (they will lose the items)
- All group-related items are deleted (or converted per toggle)

**Member leaves group:**
- Confirmation modal with a toggle: create personal copies of shared items before leaving
- Leaving does NOT delete shared items for other members
- All items created by the leaving member are reassigned to the group owner (creator_id update)

### 11. Received items land in `__shared__`
Always Option A: received items go to the `__shared__` category on the receiver's side.

### 12. Supabase backend
Same `sharing_items` table. No schema change for sharing. No category↔group column (Option B rejected).

### 13. Drive backend
Same group file append via `addItem`/`deleteItem`. No category-level linking.

### 14. Habits — completions travel with the habit
When sharing an existing habit: create a shared copy of the habit AND copy all completion records (re-pointed to the new shared habit ID). Then delete the personal habit and its personal completion records.

### 15. Lists — same as category bulk share
"Share list" = bulk share all items, same logic as decision #5. No list-specific behavior.

### 19. Offline cache keeps sharing metadata
IndexedDB stores shared items with `shared_id` and `shared_group_id`. Offline edits queue for sync. Group-deletion cleanup (#9) runs on reconnect.

### 20. Last-write-wins for conflicts
No merge, no per-field resolution in v1. Delete beats edit.

## Rejected decisions (not implemented)

- **#6, #7, #8, #10**: Option B (category↔group linking) not chosen
- **#16**: Export keeps sharing metadata as-is (accurate snapshot, deal with stale refs on import later)
- **#17**: No Option B, not applicable
- **#18**: Import should try to restore sharing if groups/permissions still exist, fallback to private otherwise

## Export / Import

- **Export**: includes shared items with full sharing metadata. Accurate snapshot.
- **Import**: attempts to re-link shared items to existing groups if the group exists and the user has permissions. Falls back to private if not.

## Open edges

- Admin unshare power for group owner (when original creator has left) — deferred, acceptable for v1
- Smart import partial matches (group exists but user no longer a member) — needs careful handling
