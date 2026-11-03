# Character Limits

This page lists the maximum lengths for text fields across DeLaClaw, and how
each one is enforced. Most limits are enforced by the input field itself;
a few are additionally checked when saving, and the sharing group name is
enforced at the backend boundary.

## Item text

| Surface | Limit |
| --- | --- |
| TODO quick-add (TODOs page, Welcome) | 2000 |
| TODO inline edit | 2000 |
| List item quick-add | 2000 |
| List item inline edit | 2000 |
| Project task input | 5000 |
| Project task inline edit | 5000 |
| Habit quick-add (Habits page) | 1000 |
| Habit quick-add (Welcome) | 1000 |
| Habit add/edit (name) | 1000 |
| Habit inline edit (name) | 1000 |
| Habit completion note edit | 500 |

The project task input also shows a live character counter (warning past
70%, danger past 90%) and rejects over-long text on save; the TODO
quick-add shows the same counter but relies on the input cap alone.

## Names, titles, notes

| Field | Limit |
| --- | --- |
| TODO / habit category, create | name 80, shortname 20 |
| TODO / habit category, edit | name 80, shortname 20 |
| Project shortname (create, edit) | 20 |
| List name (create, edit) | 100, shortname 20 |
| Deck shortname (create) | 20 |
| Birthday name (add, edit) | 200, note 500 |
| Calendar event title (add, edit) | 200, note 1000 |
| Sharing group name (create, rename) | 60 |
| Sharing member rename | 50 |
| Agent name | 80 |
| Habit custom frequency-rule free text | 300 |
| List item note (inline edit) | 1000000 |

The sharing group name limit is enforced at the backend boundary as well as
in the input field, so it holds even if the input cap is bypassed.

## No limit

Flashcard questions and answers (add, edit, inline edit), flashcard draft
content, deck names, and all text-revision fields (title, author, content)
have no maximum length.

## Display truncation (not input limits)

Project plan notes and responses (500, with show-more), list item notes (500, with show-more), flashcard fronts in
list views (90), draft content in list views (120), calendar day chips (3).
These only affect how much is shown, not how much can be entered.
