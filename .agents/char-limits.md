# Character limits inventory

Agent-only reference. Source of truth is the code (template `maxlength`
attributes, `state.js` constants, `inlineEditText` options, adapter checks);
this note is a map, not an enforcement layer. Last verified against the
codebase Nov 2026.

## Mechanisms

- HTML `maxlength` — browser-enforced on the input itself.
- JS `maxLength` — set on the element by code (`inlineEditText` option, or
  directly on a custom input).
- Save-time check — JS validation on submit, with a toast on reject.
- Adapter check — enforced at the backend boundary, not just in the UI.
- Live counter — display only (`len/limit`, warn past 70%, danger past 90%);
  it does not enforce anything by itself.

## Item text

| Surface | Limit | Mechanism |
| --- | --- | --- |
| TODO quick-add (TODOs page, Welcome) | 2000 | `maxlength` + live counter |
| TODO inline edit | 2000 | JS `maxLength` |
| List item quick-add | 2000 | `maxlength` |
| List item inline edit | 2000 | JS `maxLength` |
| Project task input | 5000 (`MAX_TEXT_LEN`) | `maxlength` + live counter + save-time reject |
| Project task inline edit | 5000 (`MAX_TEXT_LEN`) | JS `maxLength` |
| Habit quick-add (Habits page) | 1000 | `maxlength` |
| Habit quick-add (Welcome) | 200 | `maxlength` |
| Habit add/edit modal (name) | 1000 | `maxlength` |
| Habit inline edit (name) | 1000 | JS `maxLength` |
| Habit completion note edit | 500 | `maxlength` |

## Names, titles, notes

| Field | Limit | Mechanism |
| --- | --- | --- |
| TODO / habit / list category, create | name 40, shortname 20 | `maxlength` |
| TODO / habit / list category, edit | name 80, shortname 20 | `maxlength` |
| Project shortname (create, edit) | 20 | `maxlength` |
| List name (create, edit) | 100, shortname 20 | `maxlength` |
| Deck shortname (create) | 20 | `maxlength` |
| Birthday name (add, edit) | 200, note 500 | `maxlength` |
| Calendar event title (add, edit) | 200, note 1000 | `maxlength` |
| Sharing group name (create, rename) | 60 | `maxlength` + adapter check (Drive adapter throws past 60; the UI cap is cosmetic) |
| Sharing member rename | 50 | `maxlength` |
| Agent name | 80 | `maxlength` |
| Habit custom frequency-rule free text | 300 | JS `maxLength` |

## Known inconsistencies

- Habit quick-add is 1000 on the Habits page but 200 on Welcome.
- Category names are 40 on create but 80 on edit (TODOs, habits, lists).

## No limit (unlimited input)

Flashcard question/answer (add, edit, inline edit), flashcard draft content,
deck names, and all text-revision fields (title, author, content).

## Display-only truncation (not input limits)

Project plan notes and responses (500, with show-more), flashcard fronts in
list views (90), draft content in list views (120), calendar day chips (3).
