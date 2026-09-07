// ===================================================================
// DEMO DATA — realistic, localised sample content for Demo mode
// ===================================================================
// getDemoData(lang) returns { tableName: [rows], ... }
// Dates are relative to the current date so the data always looks fresh.
// ===================================================================

import { computeNextDue } from './habits.js';
const _now = new Date();
const _todayStr = _now.toISOString().slice(0, 10);
const d = (offset) => {
  const dt = new Date(_now);
  dt.setDate(dt.getDate() + offset);
  return dt.toISOString();
};
const dateOnly = (offset) => {
  const dt = new Date(_todayStr);
  dt.setDate(dt.getDate() + offset);
  return dt.toISOString().slice(0, 10);
};

// ── SHARED (language-independent) ──
function sharedHabitCompletions() {
  return [
    // Morning run — done most days last 2 weeks
    { id: 'demo-hc-001', habit_id: 'demo-habit-001', completed_at: d(-13) },
    { id: 'demo-hc-002', habit_id: 'demo-habit-001', completed_at: d(-12) },
    { id: 'demo-hc-003', habit_id: 'demo-habit-001', completed_at: d(-10) },
    { id: 'demo-hc-004', habit_id: 'demo-habit-001', completed_at: d(-9) },
    { id: 'demo-hc-005', habit_id: 'demo-habit-001', completed_at: d(-7) },
    { id: 'demo-hc-006', habit_id: 'demo-habit-001', completed_at: d(-6) },
    { id: 'demo-hc-007', habit_id: 'demo-habit-001', completed_at: d(-5) },
    { id: 'demo-hc-008', habit_id: 'demo-habit-001', completed_at: d(-3) },
    { id: 'demo-hc-009', habit_id: 'demo-habit-001', completed_at: d(-1) },
    // Reading — very consistent
    { id: 'demo-hc-010', habit_id: 'demo-habit-002', completed_at: d(-13) },
    { id: 'demo-hc-011', habit_id: 'demo-habit-002', completed_at: d(-12) },
    { id: 'demo-hc-012', habit_id: 'demo-habit-002', completed_at: d(-11) },
    { id: 'demo-hc-013', habit_id: 'demo-habit-002', completed_at: d(-10) },
    { id: 'demo-hc-014', habit_id: 'demo-habit-002', completed_at: d(-9) },
    { id: 'demo-hc-015', habit_id: 'demo-habit-002', completed_at: d(-7) },
    { id: 'demo-hc-016', habit_id: 'demo-habit-002', completed_at: d(-5) },
    { id: 'demo-hc-017', habit_id: 'demo-habit-002', completed_at: d(-4) },
    { id: 'demo-hc-018', habit_id: 'demo-habit-002', completed_at: d(-2) },
    { id: 'demo-hc-019', habit_id: 'demo-habit-002', completed_at: d(-1) },
    // Meditate — sporadic
    { id: 'demo-hc-020', habit_id: 'demo-habit-003', completed_at: d(-12) },
    { id: 'demo-hc-021', habit_id: 'demo-habit-003', completed_at: d(-9) },
    { id: 'demo-hc-022', habit_id: 'demo-habit-003', completed_at: d(-5) },
    { id: 'demo-hc-023', habit_id: 'demo-habit-003', completed_at: d(-2) },
    // Guitar — 3x per week
    { id: 'demo-hc-024', habit_id: 'demo-habit-004', completed_at: d(-13) },
    { id: 'demo-hc-025', habit_id: 'demo-habit-004', completed_at: d(-10) },
    { id: 'demo-hc-026', habit_id: 'demo-habit-004', completed_at: d(-8) },
    { id: 'demo-hc-027', habit_id: 'demo-habit-004', completed_at: d(-5) },
    { id: 'demo-hc-028', habit_id: 'demo-habit-004', completed_at: d(-3) },
    // Water plants — 2x per week
    { id: 'demo-hc-029', habit_id: 'demo-habit-005', completed_at: d(-11) },
    { id: 'demo-hc-030', habit_id: 'demo-habit-005', completed_at: d(-7) },
    { id: 'demo-hc-031', habit_id: 'demo-habit-005', completed_at: d(-4) },
    { id: 'demo-hc-032', habit_id: 'demo-habit-005', completed_at: d(-1) },
    // Meal prep — weekly
    { id: 'demo-hc-033', habit_id: 'demo-habit-006', completed_at: d(-14) },
    { id: 'demo-hc-034', habit_id: 'demo-habit-006', completed_at: d(-7) },
    // Journal — every 2 days
    { id: 'demo-hc-035', habit_id: 'demo-habit-007', completed_at: d(-6) },
    { id: 'demo-hc-036', habit_id: 'demo-habit-007', completed_at: d(-4) },
    { id: 'demo-hc-037', habit_id: 'demo-habit-007', completed_at: d(-2) },
    // Deep clean — every 2 weeks
    { id: 'demo-hc-038', habit_id: 'demo-habit-008', completed_at: d(-23) },
    { id: 'demo-hc-039', habit_id: 'demo-habit-008', completed_at: d(-9) },
    // Budget review — monthly on the 15th
    { id: 'demo-hc-040', habit_id: 'demo-habit-009', completed_at: d(-18) },
    // Quarterly goals — every 3 months first Monday
    { id: 'demo-hc-041', habit_id: 'demo-habit-010', completed_at: d(-60) },
    // Dentist — yearly
    { id: 'demo-hc-042', habit_id: 'demo-habit-011', completed_at: d(-150) },
  ];
}

// ── ENGLISH ──
function en() {
  const projects = [
    { id: 'demo-proj-001', name: 'Website Redesign', shortname: 'WEB', color: '#6366f1', tech: 'Next.js, Tailwind', links: [{ label: 'Figma', url: 'https://figma.com/project-web' }], archived: false, sort_order: 0, created_at: d(-45), updated_at: d(-2) },
    { id: 'demo-proj-002', name: 'Book Club — Spring Reads', shortname: 'BOOK', color: '#10b981', tech: '', links: [], archived: false, sort_order: 1, created_at: d(-30), updated_at: d(-5) },
    { id: 'demo-proj-003', name: 'Apartment Move', shortname: 'APT', color: '#f59e0b', tech: '', links: [], archived: false, sort_order: 2, created_at: d(-20), updated_at: d(-1) },
    { id: 'demo-proj-004', name: 'Side Project — Mealwise', shortname: 'MEAL', color: '#ec4899', tech: 'React Native, Supabase', links: [{ label: 'GitHub', url: 'https://github.com/demo/mealwise' }], archived: false, sort_order: 3, created_at: d(-60), updated_at: d(-3) },
    { id: 'demo-proj-005', name: 'Q3 Marketing Plan', shortname: 'MKT', color: '#8b5cf6', tech: '', links: [], archived: true, sort_order: 4, created_at: d(-90), updated_at: d(-40) },
  ];

  const tasks = [
    { id: 'demo-task-001', project: 'demo-proj-001', text: 'Finalise hero section copy', status: 'approved', sort_order: 0, created_at: d(-30), updated_at: d(-8) },
    { id: 'demo-task-002', project: 'demo-proj-001', text: 'Build responsive navbar component', status: 'review', sort_order: 1, created_at: d(-25), updated_at: d(-1) },
    { id: 'demo-task-003', project: 'demo-proj-001', text: 'Set up CI/CD pipeline', status: 'todo', sort_order: 2, created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-task-004', project: 'demo-proj-001', text: 'Performance audit with Lighthouse', status: 'todo', sort_order: 3, created_at: d(-15), updated_at: d(-15) },
    { id: 'demo-task-005', project: 'demo-proj-002', text: 'Finish reading "Klara and the Sun"', status: 'approved', sort_order: 0, created_at: d(-28), updated_at: d(-10) },
    { id: 'demo-task-006', project: 'demo-proj-002', text: 'Write review for group discussion', status: 'review', sort_order: 1, created_at: d(-10), updated_at: d(-2) },
    { id: 'demo-task-007', project: 'demo-proj-003', text: 'Get quotes from 3 moving companies', status: 'approved', sort_order: 0, created_at: d(-18), updated_at: d(-7) },
    { id: 'demo-task-008', project: 'demo-proj-003', text: 'Pack kitchen and living room', status: 'todo', sort_order: 1, created_at: d(-12), updated_at: d(-12) },
    { id: 'demo-task-009', project: 'demo-proj-003', text: 'Forward mail to new address', status: 'todo', sort_order: 2, created_at: d(-10), updated_at: d(-10) },
    { id: 'demo-task-010', project: 'demo-proj-004', text: 'Design onboarding flow mockups', status: 'review', sort_order: 0, created_at: d(-40), updated_at: d(-3) },
    { id: 'demo-task-011', project: 'demo-proj-004', text: 'Implement recipe search API', status: 'approved', sort_order: 1, created_at: d(-50), updated_at: d(-20) },
    { id: 'demo-task-012', project: 'demo-proj-004', text: 'Add push notifications for meal prep', status: 'todo', sort_order: 2, created_at: d(-15), updated_at: d(-15) },
  ];

  const todos = [
    { id: 'demo-todo-001', text: 'Buy groceries (avocados, oat milk, spinach)', done: false, priority: 'urgent', category: 'Personal', sort_order: 0, due_date: dateOnly(1), created_at: d(-2), updated_at: d(-2) },
    { id: 'demo-todo-002', text: 'Schedule dentist appointment', done: false, priority: 'normal', category: 'Health', sort_order: 1, due_date: dateOnly(7), created_at: d(-10), updated_at: d(-10) },
    { id: 'demo-todo-003', text: 'Renew gym membership', done: false, priority: 'normal', category: 'Health', sort_order: 2, due_date: dateOnly(14), created_at: d(-5), updated_at: d(-5) },
    { id: 'demo-todo-004', text: 'Send birthday card to Mum', done: false, priority: 'high', category: 'Family', sort_order: 3, due_date: dateOnly(3), created_at: d(-1), updated_at: d(-1) },
    { id: 'demo-todo-005', text: 'Review Q2 budget spreadsheet', done: true, priority: 'normal', category: 'Work', sort_order: 4, due_date: dateOnly(5), created_at: d(-7), updated_at: d(-7) },
    { id: 'demo-todo-006', text: 'Fix leaking kitchen tap', done: false, priority: 'normal', category: 'Home', sort_order: 5, due_date: null, created_at: d(-14), updated_at: d(-14) },
    { id: 'demo-todo-007', text: 'Return library books', done: true, priority: 'normal', category: 'Personal', sort_order: 6, due_date: dateOnly(-2), created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-todo-008', text: 'Prepare slides for Monday standup', done: false, priority: 'high', category: 'Work', sort_order: 7, due_date: dateOnly(2), created_at: d(-1), updated_at: d(-1) },
  ];

  const habits = [
    { id: 'demo-habit-001', name: 'Morning run (5 km)', frequency_rule: 'every_N_days:1', category: 'Fitness', is_draft: false, next_due: null, sort_order: 0, created_at: d(-60), updated_at: d(-1) },
    { id: 'demo-habit-002', name: 'Read 30 minutes', frequency_rule: 'every_N_days:1', category: 'Learning', is_draft: false, next_due: null, sort_order: 1, created_at: d(-45), updated_at: d(-1) },
    { id: 'demo-habit-003', name: 'Meditate', frequency_rule: 'every_N_days:1', category: 'Wellbeing', is_draft: false, next_due: null, sort_order: 2, created_at: d(-40), updated_at: d(-2) },
    { id: 'demo-habit-004', name: 'Practice guitar', frequency_rule: 'every_N_weeks:1:Mon,Wed,Fri', category: 'Creative', is_draft: false, next_due: null, sort_order: 3, created_at: d(-30), updated_at: d(-3) },
    { id: 'demo-habit-005', name: 'Water the plants', frequency_rule: 'every_N_weeks:1:Wed,Sat', category: 'Home', is_draft: false, next_due: null, sort_order: 4, created_at: d(-50), updated_at: d(-4) },
    { id: 'demo-habit-006', name: 'Weekly meal prep', frequency_rule: 'every_N_weeks:1:Sun', category: 'Health', is_draft: false, next_due: null, sort_order: 5, created_at: d(-35), updated_at: d(-7) },
    { id: 'demo-habit-007', name: 'Journal', frequency_rule: 'every_N_days:2', category: '', is_draft: false, next_due: null, sort_order: 6, created_at: d(-90), updated_at: d(-2) },
    { id: 'demo-habit-008', name: 'Deep clean bathroom', frequency_rule: 'every_N_weeks:2', category: 'Home', is_draft: false, next_due: null, sort_order: 7, created_at: d(-56), updated_at: d(-9) },
    { id: 'demo-habit-009', name: 'Budget review', frequency_rule: 'every_N_months:1:15', category: '', is_draft: false, next_due: null, sort_order: 8, created_at: d(-120), updated_at: d(-18) },
    { id: 'demo-habit-010', name: 'Quarterly goals check-in', frequency_rule: 'every_N_months:3:first:Mon', category: 'Wellbeing', is_draft: false, next_due: null, sort_order: 9, created_at: d(-180), updated_at: d(-60) },
    { id: 'demo-habit-011', name: 'Dentist appointment', frequency_rule: 'yearly:03-15', category: 'Health', is_draft: false, next_due: null, sort_order: 10, created_at: d(-365), updated_at: d(-150) },
  ];

  const habit_completions = sharedHabitCompletions();

  const flashcards = [
    // Deck: World Capitals
    { id: 'demo-fc-001', deck: 'World Capitals', front: 'What is the capital of South Korea?', back: 'Seoul', status: 'mastered', next_review: dateOnly(30), created_at: d(-40), updated_at: d(-5) },
    { id: 'demo-fc-002', deck: 'World Capitals', front: 'What is the capital of Australia?', back: 'Canberra (not Sydney)', status: 'ok', next_review: dateOnly(7), created_at: d(-40), updated_at: d(-3) },
    { id: 'demo-fc-003', deck: 'World Capitals', front: 'What is the capital of Brazil?', back: 'Brasília', status: 'due', next_review: dateOnly(-1), created_at: d(-38), updated_at: d(-10) },
    { id: 'demo-fc-004', deck: 'World Capitals', front: 'What is the capital of Canada?', back: 'Ottawa', status: 'new', next_review: null, created_at: d(-5), updated_at: d(-5) },
    // Deck: Vocabulary
    { id: 'demo-fc-005', deck: 'Vocabulary', front: 'Ephemeral', back: 'Lasting for a very short time. "The ephemeral beauty of cherry blossoms."', status: 'ok', next_review: dateOnly(5), created_at: d(-30), updated_at: d(-4) },
    { id: 'demo-fc-006', deck: 'Vocabulary', front: 'Ubiquitous', back: 'Present, appearing, or found everywhere. "Smartphones have become ubiquitous."', status: 'mastered', next_review: dateOnly(20), created_at: d(-30), updated_at: d(-8) },
    { id: 'demo-fc-007', deck: 'Vocabulary', front: 'Sycophant', back: 'A person who acts obsequiously toward someone important to gain advantage.', status: 'due', next_review: dateOnly(-3), created_at: d(-25), updated_at: d(-12) },
    { id: 'demo-fc-008', deck: 'Vocabulary', front: 'Serendipity', back: 'The occurrence of events by chance in a happy or beneficial way.', status: 'new', next_review: null, created_at: d(-2), updated_at: d(-2) },
    // Deck: History
    { id: 'demo-fc-009', deck: 'History', front: 'When did the Berlin Wall fall?', back: '9 November 1989', status: 'mastered', next_review: dateOnly(25), created_at: d(-35), updated_at: d(-6) },
    { id: 'demo-fc-010', deck: 'History', front: 'Who invented the printing press?', back: 'Johannes Gutenberg (c. 1440)', status: 'ok', next_review: dateOnly(3), created_at: d(-35), updated_at: d(-3) },
    { id: 'demo-fc-011', deck: 'History', front: 'What year did the Titanic sink?', back: '15 April 1912', status: 'due', next_review: dateOnly(0), created_at: d(-30), updated_at: d(-9) },
    { id: 'demo-fc-012', deck: 'History', front: 'Who was the first person to walk on the Moon?', back: 'Neil Armstrong — 20 July 1969', status: 'new', next_review: null, created_at: d(-3), updated_at: d(-3) },
  ];

  const flashcard_notes = [
    { id: 'demo-fn-001', content: 'Add more capitals from Africa and Asia.', proposal_status: null, proposed_front: null, proposed_back: null, proposed_deck: null, created_at: d(-10) },
    { id: 'demo-fn-002', content: 'Renaissance art flashcards — Michelangelo, Da Vinci, Raphael.', proposal_status: 'pending', proposed_front: 'Who painted the ceiling of the Sistine Chapel?', proposed_back: 'Michelangelo (1508–1512)', proposed_deck: 'History', created_at: d(-4) },
    { id: 'demo-fn-003', content: 'The Silk Road — trade routes, key cities, cultural exchanges.', proposal_status: 'ready', proposed_front: 'What ancient network of trade routes connected China to the Mediterranean?', proposed_back: 'The Silk Road — active from the 2nd century BC to the 15th century AD, linking East Asia to Europe via Central Asia.', proposed_deck: 'History', created_at: d(-2) },
  ];

  const birthdays = [
    { id: 'demo-bd-001', name: 'Emma Richardson', birthday: '1990-04-15', note: 'Likes botanical gardens', avatar_url: null, created_at: d(-60), updated_at: d(-60) },
    { id: 'demo-bd-002', name: 'Marcus Chen', birthday: '1993-06-02', note: 'Invite for BBQ', avatar_url: null, created_at: d(-50), updated_at: d(-50) },
    { id: 'demo-bd-003', name: 'Sophie Müller', birthday: '1988-12-19', note: 'Gift idea: cookbook', avatar_url: null, created_at: d(-45), updated_at: d(-45) },
    { id: 'demo-bd-004', name: 'Liam O\'Brien', birthday: '1995-08-30', note: '', avatar_url: null, created_at: d(-40), updated_at: d(-40) },
    { id: 'demo-bd-005', name: 'Aisha Patel', birthday: '1991-05-31', note: 'Turning 35 — surprise party?', avatar_url: null, created_at: d(-35), updated_at: d(-35) },
    { id: 'demo-bd-006', name: 'Carlos Reyes', birthday: '1987-11-07', note: 'Met at the conference', avatar_url: null, created_at: d(-30), updated_at: d(-30) },
  ];

  const vestiaire = [
    { id: 'demo-vest-001', name: 'Linen blazer', category: 'Outerwear', color: 'Navy', brand: 'COS', size: 'M', note: 'Great for summer evenings', purchase_status: null, image_url: null, sort_order: 0, created_at: d(-90), updated_at: d(-10) },
    { id: 'demo-vest-002', name: 'White Oxford shirt', category: 'Tops', color: 'White', brand: 'Uniqlo', size: 'M', note: '', purchase_status: null, image_url: null, sort_order: 1, created_at: d(-80), updated_at: d(-20) },
    { id: 'demo-vest-003', name: 'Slim chinos', category: 'Bottoms', color: 'Khaki', brand: 'Arket', size: '32', note: 'Tapered fit', purchase_status: null, image_url: null, sort_order: 2, created_at: d(-70), updated_at: d(-15) },
    { id: 'demo-vest-004', name: 'Running trainers', category: 'Shoes', color: 'Black/Grey', brand: 'Nike Pegasus', size: '43', note: 'Replace after 800 km', purchase_status: null, image_url: null, sort_order: 3, created_at: d(-60), updated_at: d(-5) },
    { id: 'demo-vest-005', name: 'Wool overcoat', category: 'Outerwear', color: 'Charcoal', brand: 'Massimo Dutti', size: 'L', note: 'Dry clean only', purchase_status: null, image_url: null, sort_order: 4, created_at: d(-120), updated_at: d(-30) },
    { id: 'demo-vest-006', name: 'Canvas tote bag', category: 'Accessories', color: 'Off-white', brand: 'Muji', size: '', note: 'Everyday carry', purchase_status: null, image_url: null, sort_order: 5, created_at: d(-50), updated_at: d(-25) },
  ];

  const lists = [
    { id: 'demo-list-001', name: 'Travel Destinations', shortname: 'Travel', color: '#14b8a6', icon: 'map-pin', sort_order: 0, archived: 0, created_at: d(-30), updated_at: d(-2) },
    { id: 'demo-list-002', name: 'Monthly Expenses to Reimburse', shortname: 'Expenses', color: '#ef4444', icon: 'receipt', sort_order: 1, archived: 0, created_at: d(-15), updated_at: d(-1) },
    { id: 'demo-list-003', name: 'Movies to Watch', shortname: 'Movies', color: '#a855f7', icon: 'film', sort_order: 2, archived: 0, created_at: d(-20), updated_at: d(-3) },
  ];

  const list_items = [
    { id: 'demo-li-001', list_id: 'demo-list-001', text: 'Tokyo', checked: 0, note: null, sort_order: 0, created_at: d(-30), updated_at: d(-30) },
    { id: 'demo-li-002', list_id: 'demo-list-001', text: 'Lisbon', checked: 0, note: null, sort_order: 1, created_at: d(-28), updated_at: d(-28) },
    { id: 'demo-li-003', list_id: 'demo-list-001', text: 'Patagonia', checked: 0, note: null, sort_order: 2, created_at: d(-25), updated_at: d(-25) },
    { id: 'demo-li-004', list_id: 'demo-list-001', text: 'Reykjavik', checked: 0, note: null, sort_order: 3, created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-li-005', list_id: 'demo-list-002', text: 'Uber to office €12', checked: 0, note: null, sort_order: 0, created_at: d(-10), updated_at: d(-10) },
    { id: 'demo-li-006', list_id: 'demo-list-002', text: 'Client lunch €45', checked: 0, note: null, sort_order: 1, created_at: d(-8), updated_at: d(-8) },
    { id: 'demo-li-007', list_id: 'demo-list-002', text: 'Train ticket €28', checked: 0, note: null, sort_order: 2, created_at: d(-5), updated_at: d(-5) },
    { id: 'demo-li-008', list_id: 'demo-list-003', text: 'Mulholland Drive', checked: 0, note: null, sort_order: 0, created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-li-009', list_id: 'demo-list-003', text: 'Stalker', checked: 0, note: null, sort_order: 1, created_at: d(-18), updated_at: d(-18) },
    { id: 'demo-li-010', list_id: 'demo-list-003', text: 'In the Mood for Love', checked: 0, note: null, sort_order: 2, created_at: d(-15), updated_at: d(-15) },
  ];

  return { projects, tasks, todos, habits, habit_completions, flashcards, flashcard_notes, birthdays, vestiaire, lists, list_items };
}

// ── FRENCH ──
function fr() {
  const projects = [
    { id: 'demo-proj-001', name: 'Refonte du site web', shortname: 'WEB', color: '#6366f1', tech: 'Next.js, Tailwind', links: [{ label: 'Figma', url: 'https://figma.com/projet-web' }], archived: false, sort_order: 0, created_at: d(-45), updated_at: d(-2) },
    { id: 'demo-proj-002', name: 'Club de lecture — Printemps', shortname: 'LECT', color: '#10b981', tech: '', links: [], archived: false, sort_order: 1, created_at: d(-30), updated_at: d(-5) },
    { id: 'demo-proj-003', name: 'Déménagement', shortname: 'APT', color: '#f59e0b', tech: '', links: [], archived: false, sort_order: 2, created_at: d(-20), updated_at: d(-1) },
    { id: 'demo-proj-004', name: 'Side Project — Mealwise', shortname: 'MEAL', color: '#ec4899', tech: 'React Native, Supabase', links: [{ label: 'GitHub', url: 'https://github.com/demo/mealwise' }], archived: false, sort_order: 3, created_at: d(-60), updated_at: d(-3) },
    { id: 'demo-proj-005', name: 'Plan marketing T3', shortname: 'MKT', color: '#8b5cf6', tech: '', links: [], archived: true, sort_order: 4, created_at: d(-90), updated_at: d(-40) },
  ];

  const tasks = [
    { id: 'demo-task-001', project: 'demo-proj-001', text: 'Finaliser le texte de la section héro', status: 'approved', sort_order: 0, created_at: d(-30), updated_at: d(-8) },
    { id: 'demo-task-002', project: 'demo-proj-001', text: 'Développer le composant navbar responsive', status: 'review', sort_order: 1, created_at: d(-25), updated_at: d(-1) },
    { id: 'demo-task-003', project: 'demo-proj-001', text: 'Configurer le pipeline CI/CD', status: 'todo', sort_order: 2, created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-task-004', project: 'demo-proj-001', text: 'Audit performance avec Lighthouse', status: 'todo', sort_order: 3, created_at: d(-15), updated_at: d(-15) },
    { id: 'demo-task-005', project: 'demo-proj-002', text: 'Terminer « Klara et le Soleil »', status: 'approved', sort_order: 0, created_at: d(-28), updated_at: d(-10) },
    { id: 'demo-task-006', project: 'demo-proj-002', text: 'Rédiger une critique pour la discussion', status: 'review', sort_order: 1, created_at: d(-10), updated_at: d(-2) },
    { id: 'demo-task-007', project: 'demo-proj-003', text: 'Demander 3 devis de déménageurs', status: 'approved', sort_order: 0, created_at: d(-18), updated_at: d(-7) },
    { id: 'demo-task-008', project: 'demo-proj-003', text: 'Emballer cuisine et salon', status: 'todo', sort_order: 1, created_at: d(-12), updated_at: d(-12) },
    { id: 'demo-task-009', project: 'demo-proj-003', text: 'Faire suivre le courrier', status: 'todo', sort_order: 2, created_at: d(-10), updated_at: d(-10) },
    { id: 'demo-task-010', project: 'demo-proj-004', text: 'Créer les maquettes du parcours d\'accueil', status: 'review', sort_order: 0, created_at: d(-40), updated_at: d(-3) },
    { id: 'demo-task-011', project: 'demo-proj-004', text: 'Implémenter l\'API de recherche de recettes', status: 'approved', sort_order: 1, created_at: d(-50), updated_at: d(-20) },
    { id: 'demo-task-012', project: 'demo-proj-004', text: 'Ajouter les notifications push pour le meal prep', status: 'todo', sort_order: 2, created_at: d(-15), updated_at: d(-15) },
  ];

  const todos = [
    { id: 'demo-todo-001', text: 'Faire les courses (avocat, lait d\'avoine, épinards)', done: false, priority: 'urgent', category: 'Personnel', sort_order: 0, due_date: dateOnly(1), created_at: d(-2), updated_at: d(-2) },
    { id: 'demo-todo-002', text: 'Prendre rendez-vous chez le dentiste', done: false, priority: 'normal', category: 'Santé', sort_order: 1, due_date: dateOnly(7), created_at: d(-10), updated_at: d(-10) },
    { id: 'demo-todo-003', text: 'Renouveler l\'abonnement salle de sport', done: false, priority: 'normal', category: 'Santé', sort_order: 2, due_date: dateOnly(14), created_at: d(-5), updated_at: d(-5) },
    { id: 'demo-todo-004', text: 'Envoyer une carte d\'anniversaire à Maman', done: false, priority: 'high', category: 'Famille', sort_order: 3, due_date: dateOnly(3), created_at: d(-1), updated_at: d(-1) },
    { id: 'demo-todo-005', text: 'Revoir le budget T2 sur le tableur', done: true, priority: 'normal', category: 'Travail', sort_order: 4, due_date: dateOnly(5), created_at: d(-7), updated_at: d(-7) },
    { id: 'demo-todo-006', text: 'Réparer le robinet de la cuisine', done: false, priority: 'normal', category: 'Maison', sort_order: 5, due_date: null, created_at: d(-14), updated_at: d(-14) },
    { id: 'demo-todo-007', text: 'Rendre les livres à la bibliothèque', done: true, priority: 'normal', category: 'Personnel', sort_order: 6, due_date: dateOnly(-2), created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-todo-008', text: 'Préparer les slides pour le standup de lundi', done: false, priority: 'high', category: 'Travail', sort_order: 7, due_date: dateOnly(2), created_at: d(-1), updated_at: d(-1) },
  ];

  const habits = [
    { id: 'demo-habit-001', name: 'Course matinale (5 km)', frequency_rule: 'every_N_days:1', category: 'Sport', is_draft: false, next_due: null, sort_order: 0, created_at: d(-60), updated_at: d(-1) },
    { id: 'demo-habit-002', name: 'Lire 30 minutes', frequency_rule: 'every_N_days:1', category: 'Apprentissage', is_draft: false, next_due: null, sort_order: 1, created_at: d(-45), updated_at: d(-1) },
    { id: 'demo-habit-003', name: 'Méditer', frequency_rule: 'every_N_days:1', category: 'Bien-être', is_draft: false, next_due: null, sort_order: 2, created_at: d(-40), updated_at: d(-2) },
    { id: 'demo-habit-004', name: 'Pratiquer la guitare', frequency_rule: 'every_N_weeks:1:Mon,Wed,Fri', category: 'Créativité', is_draft: false, next_due: null, sort_order: 3, created_at: d(-30), updated_at: d(-3) },
    { id: 'demo-habit-005', name: 'Arroser les plantes', frequency_rule: 'every_N_weeks:1:Wed,Sat', category: 'Maison', is_draft: false, next_due: null, sort_order: 4, created_at: d(-50), updated_at: d(-4) },
    { id: 'demo-habit-006', name: 'Meal prep du dimanche', frequency_rule: 'every_N_weeks:1:Sun', category: 'Santé', is_draft: false, next_due: null, sort_order: 5, created_at: d(-35), updated_at: d(-7) },
    { id: 'demo-habit-007', name: 'Journal', frequency_rule: 'every_N_days:2', category: '', is_draft: false, next_due: null, sort_order: 6, created_at: d(-90), updated_at: d(-2) },
    { id: 'demo-habit-008', name: 'Grand ménage salle de bain', frequency_rule: 'every_N_weeks:2', category: 'Maison', is_draft: false, next_due: null, sort_order: 7, created_at: d(-56), updated_at: d(-9) },
    { id: 'demo-habit-009', name: 'Revue du budget', frequency_rule: 'every_N_months:1:15', category: '', is_draft: false, next_due: null, sort_order: 8, created_at: d(-120), updated_at: d(-18) },
    { id: 'demo-habit-010', name: 'Bilan trimestriel des objectifs', frequency_rule: 'every_N_months:3:first:Mon', category: 'Bien-être', is_draft: false, next_due: null, sort_order: 9, created_at: d(-180), updated_at: d(-60) },
    { id: 'demo-habit-011', name: 'Rendez-vous dentiste', frequency_rule: 'yearly:03-15', category: 'Santé', is_draft: false, next_due: null, sort_order: 10, created_at: d(-365), updated_at: d(-150) },
  ];

  const flashcards = [
    { id: 'demo-fc-001', deck: 'Capitales du monde', front: 'Quelle est la capitale de la Corée du Sud ?', back: 'Séoul', status: 'mastered', next_review: dateOnly(30), created_at: d(-40), updated_at: d(-5) },
    { id: 'demo-fc-002', deck: 'Capitales du monde', front: 'Quelle est la capitale de l\'Australie ?', back: 'Canberra (pas Sydney)', status: 'ok', next_review: dateOnly(7), created_at: d(-40), updated_at: d(-3) },
    { id: 'demo-fc-003', deck: 'Capitales du monde', front: 'Quelle est la capitale du Brésil ?', back: 'Brasília', status: 'due', next_review: dateOnly(-1), created_at: d(-38), updated_at: d(-10) },
    { id: 'demo-fc-004', deck: 'Capitales du monde', front: 'Quelle est la capitale du Canada ?', back: 'Ottawa', status: 'new', next_review: null, created_at: d(-5), updated_at: d(-5) },
    { id: 'demo-fc-005', deck: 'Vocabulaire', front: 'Éphémère', back: 'Qui ne dure qu\'un temps très court. « La beauté éphémère des cerisiers en fleurs. »', status: 'ok', next_review: dateOnly(5), created_at: d(-30), updated_at: d(-4) },
    { id: 'demo-fc-006', deck: 'Vocabulaire', front: 'Ubiquitaire', back: 'Présent partout en même temps. « Les smartphones sont devenus ubiquitaires. »', status: 'mastered', next_review: dateOnly(20), created_at: d(-30), updated_at: d(-8) },
    { id: 'demo-fc-007', deck: 'Vocabulaire', front: 'Flagorneur', back: 'Personne qui flatte avec excès pour obtenir des faveurs.', status: 'due', next_review: dateOnly(-3), created_at: d(-25), updated_at: d(-12) },
    { id: 'demo-fc-008', deck: 'Vocabulaire', front: 'Sérendipité', back: 'Découverte heureuse faite par hasard.', status: 'new', next_review: null, created_at: d(-2), updated_at: d(-2) },
    { id: 'demo-fc-009', deck: 'Histoire', front: 'Quand est tombé le mur de Berlin ?', back: '9 novembre 1989', status: 'mastered', next_review: dateOnly(25), created_at: d(-35), updated_at: d(-6) },
    { id: 'demo-fc-010', deck: 'Histoire', front: 'Qui a inventé l\'imprimerie ?', back: 'Johannes Gutenberg (vers 1440)', status: 'ok', next_review: dateOnly(3), created_at: d(-35), updated_at: d(-3) },
    { id: 'demo-fc-011', deck: 'Histoire', front: 'En quelle année le Titanic a-t-il coulé ?', back: '15 avril 1912', status: 'due', next_review: dateOnly(0), created_at: d(-30), updated_at: d(-9) },
    { id: 'demo-fc-012', deck: 'Histoire', front: 'Qui a été le premier homme à marcher sur la Lune ?', back: 'Neil Armstrong — 20 juillet 1969', status: 'new', next_review: null, created_at: d(-3), updated_at: d(-3) },
  ];

  const flashcard_notes = [
    { id: 'demo-fn-001', content: 'Ajouter plus de capitales d\'Afrique et d\'Asie.', proposal_status: null, proposed_front: null, proposed_back: null, proposed_deck: null, created_at: d(-10) },
    { id: 'demo-fn-002', content: 'Flashcards art de la Renaissance — Michel-Ange, Léonard de Vinci, Raphaël.', proposal_status: 'pending', proposed_front: 'Qui a peint le plafond de la chapelle Sixtine ?', proposed_back: 'Michel-Ange (1508–1512)', proposed_deck: 'Histoire', created_at: d(-4) },
    { id: 'demo-fn-003', content: 'La Route de la Soie — routes commerciales, villes clés, échanges culturels.', proposal_status: 'ready', proposed_front: 'Quel ancien réseau de routes commerciales reliait la Chine à la Méditerranée ?', proposed_back: 'La Route de la Soie — active du IIe siècle av. J.-C. au XVe siècle, reliant l\'Asie de l\'Est à l\'Europe via l\'Asie centrale.', proposed_deck: 'Histoire', created_at: d(-2) },
  ];

  const birthdays = [
    { id: 'demo-bd-001', name: 'Emma Durand', birthday: '1990-04-15', note: 'Aime les jardins botaniques', avatar_url: null, created_at: d(-60), updated_at: d(-60) },
    { id: 'demo-bd-002', name: 'Marc Lefèvre', birthday: '1993-06-02', note: 'Inviter au barbecue', avatar_url: null, created_at: d(-50), updated_at: d(-50) },
    { id: 'demo-bd-003', name: 'Sophie Müller', birthday: '1988-12-19', note: 'Idée cadeau : livre de cuisine', avatar_url: null, created_at: d(-45), updated_at: d(-45) },
    { id: 'demo-bd-004', name: 'Liam O\'Brien', birthday: '1995-08-30', note: '', avatar_url: null, created_at: d(-40), updated_at: d(-40) },
    { id: 'demo-bd-005', name: 'Aïcha Benali', birthday: '1991-05-31', note: 'Fête ses 35 ans — surprise ?', avatar_url: null, created_at: d(-35), updated_at: d(-35) },
    { id: 'demo-bd-006', name: 'Carlos Reyes', birthday: '1987-11-07', note: 'Rencontré à la conférence', avatar_url: null, created_at: d(-30), updated_at: d(-30) },
  ];

  const vestiaire = [
    { id: 'demo-vest-001', name: 'Blazer en lin', category: 'Vestes', color: 'Marine', brand: 'COS', size: 'M', note: 'Parfait pour les soirées d\'été', purchase_status: null, image_url: null, sort_order: 0, created_at: d(-90), updated_at: d(-10) },
    { id: 'demo-vest-002', name: 'Chemise Oxford blanche', category: 'Hauts', color: 'Blanc', brand: 'Uniqlo', size: 'M', note: '', purchase_status: null, image_url: null, sort_order: 1, created_at: d(-80), updated_at: d(-20) },
    { id: 'demo-vest-003', name: 'Chino slim', category: 'Bas', color: 'Beige', brand: 'Arket', size: '32', note: 'Coupe fuselée', purchase_status: null, image_url: null, sort_order: 2, created_at: d(-70), updated_at: d(-15) },
    { id: 'demo-vest-004', name: 'Baskets de course', category: 'Chaussures', color: 'Noir/Gris', brand: 'Nike Pegasus', size: '43', note: 'Remplacer après 800 km', purchase_status: null, image_url: null, sort_order: 3, created_at: d(-60), updated_at: d(-5) },
    { id: 'demo-vest-005', name: 'Manteau en laine', category: 'Vestes', color: 'Anthracite', brand: 'Massimo Dutti', size: 'L', note: 'Nettoyage à sec uniquement', purchase_status: null, image_url: null, sort_order: 4, created_at: d(-120), updated_at: d(-30) },
    { id: 'demo-vest-006', name: 'Tote bag en toile', category: 'Accessoires', color: 'Écru', brand: 'Muji', size: '', note: 'Sac du quotidien', purchase_status: null, image_url: null, sort_order: 5, created_at: d(-50), updated_at: d(-25) },
  ];

  const lists = [
    { id: 'demo-list-001', name: 'Destinations de voyage', shortname: 'Voyage', color: '#14b8a6', icon: 'map-pin', sort_order: 0, archived: 0, created_at: d(-30), updated_at: d(-2) },
    { id: 'demo-list-002', name: 'Notes de frais du mois', shortname: 'Frais', color: '#ef4444', icon: 'receipt', sort_order: 1, archived: 0, created_at: d(-15), updated_at: d(-1) },
    { id: 'demo-list-003', name: 'Films à voir', shortname: 'Films', color: '#a855f7', icon: 'film', sort_order: 2, archived: 0, created_at: d(-20), updated_at: d(-3) },
  ];

  const list_items = [
    { id: 'demo-li-001', list_id: 'demo-list-001', text: 'Tokyo', checked: 0, note: null, sort_order: 0, created_at: d(-30), updated_at: d(-30) },
    { id: 'demo-li-002', list_id: 'demo-list-001', text: 'Lisbonne', checked: 0, note: null, sort_order: 1, created_at: d(-28), updated_at: d(-28) },
    { id: 'demo-li-003', list_id: 'demo-list-001', text: 'Patagonie', checked: 0, note: null, sort_order: 2, created_at: d(-25), updated_at: d(-25) },
    { id: 'demo-li-004', list_id: 'demo-list-001', text: 'Reykjavik', checked: 0, note: null, sort_order: 3, created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-li-005', list_id: 'demo-list-002', text: 'Uber vers le bureau 12 €', checked: 0, note: null, sort_order: 0, created_at: d(-10), updated_at: d(-10) },
    { id: 'demo-li-006', list_id: 'demo-list-002', text: 'Déjeuner client 45 €', checked: 0, note: null, sort_order: 1, created_at: d(-8), updated_at: d(-8) },
    { id: 'demo-li-007', list_id: 'demo-list-002', text: 'Billet de train 28 €', checked: 0, note: null, sort_order: 2, created_at: d(-5), updated_at: d(-5) },
    { id: 'demo-li-008', list_id: 'demo-list-003', text: 'Mulholland Drive', checked: 0, note: null, sort_order: 0, created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-li-009', list_id: 'demo-list-003', text: 'Stalker', checked: 0, note: null, sort_order: 1, created_at: d(-18), updated_at: d(-18) },
    { id: 'demo-li-010', list_id: 'demo-list-003', text: 'In the Mood for Love', checked: 0, note: null, sort_order: 2, created_at: d(-15), updated_at: d(-15) },
  ];

  // Re-use same habit_completions (ids are the same, habit_ids match)
  return { projects, tasks, todos, habits, habit_completions: sharedHabitCompletions(), flashcards, flashcard_notes, birthdays, vestiaire, lists, list_items };
}

// ── SPANISH ──
function es() {
  const projects = [
    { id: 'demo-proj-001', name: 'Rediseño web', shortname: 'WEB', color: '#6366f1', tech: 'Next.js, Tailwind', links: [{ label: 'Figma', url: 'https://figma.com/proyecto-web' }], archived: false, sort_order: 0, created_at: d(-45), updated_at: d(-2) },
    { id: 'demo-proj-002', name: 'Club de lectura — Primavera', shortname: 'LECT', color: '#10b981', tech: '', links: [], archived: false, sort_order: 1, created_at: d(-30), updated_at: d(-5) },
    { id: 'demo-proj-003', name: 'Mudanza', shortname: 'APT', color: '#f59e0b', tech: '', links: [], archived: false, sort_order: 2, created_at: d(-20), updated_at: d(-1) },
    { id: 'demo-proj-004', name: 'Side Project — Mealwise', shortname: 'MEAL', color: '#ec4899', tech: 'React Native, Supabase', links: [{ label: 'GitHub', url: 'https://github.com/demo/mealwise' }], archived: false, sort_order: 3, created_at: d(-60), updated_at: d(-3) },
    { id: 'demo-proj-005', name: 'Plan de marketing T3', shortname: 'MKT', color: '#8b5cf6', tech: '', links: [], archived: true, sort_order: 4, created_at: d(-90), updated_at: d(-40) },
  ];

  const tasks = [
    { id: 'demo-task-001', project: 'demo-proj-001', text: 'Finalizar el copy de la sección hero', status: 'approved', sort_order: 0, created_at: d(-30), updated_at: d(-8) },
    { id: 'demo-task-002', project: 'demo-proj-001', text: 'Construir el componente navbar responsive', status: 'review', sort_order: 1, created_at: d(-25), updated_at: d(-1) },
    { id: 'demo-task-003', project: 'demo-proj-001', text: 'Configurar el pipeline CI/CD', status: 'todo', sort_order: 2, created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-task-004', project: 'demo-proj-001', text: 'Auditoría de rendimiento con Lighthouse', status: 'todo', sort_order: 3, created_at: d(-15), updated_at: d(-15) },
    { id: 'demo-task-005', project: 'demo-proj-002', text: 'Terminar de leer «Klara y el Sol»', status: 'approved', sort_order: 0, created_at: d(-28), updated_at: d(-10) },
    { id: 'demo-task-006', project: 'demo-proj-002', text: 'Escribir la reseña para la discusión', status: 'review', sort_order: 1, created_at: d(-10), updated_at: d(-2) },
    { id: 'demo-task-007', project: 'demo-proj-003', text: 'Pedir 3 presupuestos de mudanza', status: 'approved', sort_order: 0, created_at: d(-18), updated_at: d(-7) },
    { id: 'demo-task-008', project: 'demo-proj-003', text: 'Empacar cocina y salón', status: 'todo', sort_order: 1, created_at: d(-12), updated_at: d(-12) },
    { id: 'demo-task-009', project: 'demo-proj-003', text: 'Redirigir el correo a la nueva dirección', status: 'todo', sort_order: 2, created_at: d(-10), updated_at: d(-10) },
    { id: 'demo-task-010', project: 'demo-proj-004', text: 'Diseñar mockups del flujo de onboarding', status: 'review', sort_order: 0, created_at: d(-40), updated_at: d(-3) },
    { id: 'demo-task-011', project: 'demo-proj-004', text: 'Implementar la API de búsqueda de recetas', status: 'approved', sort_order: 1, created_at: d(-50), updated_at: d(-20) },
    { id: 'demo-task-012', project: 'demo-proj-004', text: 'Añadir notificaciones push para meal prep', status: 'todo', sort_order: 2, created_at: d(-15), updated_at: d(-15) },
  ];

  const todos = [
    { id: 'demo-todo-001', text: 'Comprar víveres (aguacate, leche de avena, espinacas)', done: false, priority: 'urgent', category: 'Personal', sort_order: 0, due_date: dateOnly(1), created_at: d(-2), updated_at: d(-2) },
    { id: 'demo-todo-002', text: 'Pedir cita con el dentista', done: false, priority: 'normal', category: 'Salud', sort_order: 1, due_date: dateOnly(7), created_at: d(-10), updated_at: d(-10) },
    { id: 'demo-todo-003', text: 'Renovar membresía del gimnasio', done: false, priority: 'normal', category: 'Salud', sort_order: 2, due_date: dateOnly(14), created_at: d(-5), updated_at: d(-5) },
    { id: 'demo-todo-004', text: 'Enviar tarjeta de cumpleaños a Mamá', done: false, priority: 'high', category: 'Familia', sort_order: 3, due_date: dateOnly(3), created_at: d(-1), updated_at: d(-1) },
    { id: 'demo-todo-005', text: 'Revisar el presupuesto T2 en la hoja de cálculo', done: true, priority: 'normal', category: 'Trabajo', sort_order: 4, due_date: dateOnly(5), created_at: d(-7), updated_at: d(-7) },
    { id: 'demo-todo-006', text: 'Arreglar el grifo de la cocina', done: false, priority: 'normal', category: 'Hogar', sort_order: 5, due_date: null, created_at: d(-14), updated_at: d(-14) },
    { id: 'demo-todo-007', text: 'Devolver los libros a la biblioteca', done: true, priority: 'normal', category: 'Personal', sort_order: 6, due_date: dateOnly(-2), created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-todo-008', text: 'Preparar las diapositivas para el standup del lunes', done: false, priority: 'high', category: 'Trabajo', sort_order: 7, due_date: dateOnly(2), created_at: d(-1), updated_at: d(-1) },
  ];

  const habits = [
    { id: 'demo-habit-001', name: 'Carrera matutina (5 km)', frequency_rule: 'every_N_days:1', category: 'Deporte', is_draft: false, next_due: null, sort_order: 0, created_at: d(-60), updated_at: d(-1) },
    { id: 'demo-habit-002', name: 'Leer 30 minutos', frequency_rule: 'every_N_days:1', category: 'Aprendizaje', is_draft: false, next_due: null, sort_order: 1, created_at: d(-45), updated_at: d(-1) },
    { id: 'demo-habit-003', name: 'Meditar', frequency_rule: 'every_N_days:1', category: 'Bienestar', is_draft: false, next_due: null, sort_order: 2, created_at: d(-40), updated_at: d(-2) },
    { id: 'demo-habit-004', name: 'Practicar guitarra', frequency_rule: 'every_N_weeks:1:Mon,Wed,Fri', category: 'Creatividad', is_draft: false, next_due: null, sort_order: 3, created_at: d(-30), updated_at: d(-3) },
    { id: 'demo-habit-005', name: 'Regar las plantas', frequency_rule: 'every_N_weeks:1:Wed,Sat', category: 'Hogar', is_draft: false, next_due: null, sort_order: 4, created_at: d(-50), updated_at: d(-4) },
    { id: 'demo-habit-006', name: 'Meal prep semanal', frequency_rule: 'every_N_weeks:1:Sun', category: 'Salud', is_draft: false, next_due: null, sort_order: 5, created_at: d(-35), updated_at: d(-7) },
    { id: 'demo-habit-007', name: 'Diario', frequency_rule: 'every_N_days:2', category: '', is_draft: false, next_due: null, sort_order: 6, created_at: d(-90), updated_at: d(-2) },
    { id: 'demo-habit-008', name: 'Limpieza a fondo del baño', frequency_rule: 'every_N_weeks:2', category: 'Hogar', is_draft: false, next_due: null, sort_order: 7, created_at: d(-56), updated_at: d(-9) },
    { id: 'demo-habit-009', name: 'Revisión del presupuesto', frequency_rule: 'every_N_months:1:15', category: '', is_draft: false, next_due: null, sort_order: 8, created_at: d(-120), updated_at: d(-18) },
    { id: 'demo-habit-010', name: 'Revisión trimestral de objetivos', frequency_rule: 'every_N_months:3:first:Mon', category: 'Bienestar', is_draft: false, next_due: null, sort_order: 9, created_at: d(-180), updated_at: d(-60) },
    { id: 'demo-habit-011', name: 'Cita con el dentista', frequency_rule: 'yearly:03-15', category: 'Salud', is_draft: false, next_due: null, sort_order: 10, created_at: d(-365), updated_at: d(-150) },
  ];

  const flashcards = [
    { id: 'demo-fc-001', deck: 'Capitales del mundo', front: '¿Cuál es la capital de Corea del Sur?', back: 'Seúl', status: 'mastered', next_review: dateOnly(30), created_at: d(-40), updated_at: d(-5) },
    { id: 'demo-fc-002', deck: 'Capitales del mundo', front: '¿Cuál es la capital de Australia?', back: 'Canberra (no Sídney)', status: 'ok', next_review: dateOnly(7), created_at: d(-40), updated_at: d(-3) },
    { id: 'demo-fc-003', deck: 'Capitales del mundo', front: '¿Cuál es la capital de Brasil?', back: 'Brasilia', status: 'due', next_review: dateOnly(-1), created_at: d(-38), updated_at: d(-10) },
    { id: 'demo-fc-004', deck: 'Capitales del mundo', front: '¿Cuál es la capital de Canadá?', back: 'Ottawa', status: 'new', next_review: null, created_at: d(-5), updated_at: d(-5) },
    { id: 'demo-fc-005', deck: 'Vocabulario', front: 'Efímero', back: 'Que dura muy poco tiempo. «La efímera belleza de los cerezos en flor.»', status: 'ok', next_review: dateOnly(5), created_at: d(-30), updated_at: d(-4) },
    { id: 'demo-fc-006', deck: 'Vocabulario', front: 'Ubicuo', back: 'Que está presente en todas partes. «Los smartphones se han vuelto ubicuos.»', status: 'mastered', next_review: dateOnly(20), created_at: d(-30), updated_at: d(-8) },
    { id: 'demo-fc-007', deck: 'Vocabulario', front: 'Sicofante', back: 'Persona que adula servilmente a alguien poderoso para obtener ventajas.', status: 'due', next_review: dateOnly(-3), created_at: d(-25), updated_at: d(-12) },
    { id: 'demo-fc-008', deck: 'Vocabulario', front: 'Serendipia', back: 'Hallazgo afortunado e inesperado que se produce de manera accidental.', status: 'new', next_review: null, created_at: d(-2), updated_at: d(-2) },
    { id: 'demo-fc-009', deck: 'Historia', front: '¿Cuándo cayó el Muro de Berlín?', back: '9 de noviembre de 1989', status: 'mastered', next_review: dateOnly(25), created_at: d(-35), updated_at: d(-6) },
    { id: 'demo-fc-010', deck: 'Historia', front: '¿Quién inventó la imprenta?', back: 'Johannes Gutenberg (c. 1440)', status: 'ok', next_review: dateOnly(3), created_at: d(-35), updated_at: d(-3) },
    { id: 'demo-fc-011', deck: 'Historia', front: '¿En qué año se hundió el Titanic?', back: '15 de abril de 1912', status: 'due', next_review: dateOnly(0), created_at: d(-30), updated_at: d(-9) },
    { id: 'demo-fc-012', deck: 'Historia', front: '¿Quién fue la primera persona en caminar sobre la Luna?', back: 'Neil Armstrong — 20 de julio de 1969', status: 'new', next_review: null, created_at: d(-3), updated_at: d(-3) },
  ];

  const flashcard_notes = [
    { id: 'demo-fn-001', content: 'Añadir más capitales de África y Asia.', proposal_status: null, proposed_front: null, proposed_back: null, proposed_deck: null, created_at: d(-10) },
    { id: 'demo-fn-002', content: 'Flashcards de arte renacentista — Miguel Ángel, Da Vinci, Rafael.', proposal_status: 'pending', proposed_front: '¿Quién pintó el techo de la Capilla Sixtina?', proposed_back: 'Miguel Ángel (1508–1512)', proposed_deck: 'Historia', created_at: d(-4) },
    { id: 'demo-fn-003', content: 'La Ruta de la Seda — rutas comerciales, ciudades clave, intercambios culturales.', proposal_status: 'ready', proposed_front: '¿Qué antigua red de rutas comerciales conectaba China con el Mediterráneo?', proposed_back: 'La Ruta de la Seda — activa desde el siglo II a.C. hasta el siglo XV, uniendo Asia Oriental con Europa a través de Asia Central.', proposed_deck: 'Historia', created_at: d(-2) },
  ];

  const birthdays = [
    { id: 'demo-bd-001', name: 'Elena Vásquez', birthday: '1990-04-15', note: 'Le gustan los jardines botánicos', avatar_url: null, created_at: d(-60), updated_at: d(-60) },
    { id: 'demo-bd-002', name: 'Marco Torres', birthday: '1993-06-02', note: 'Invitar a la parrillada', avatar_url: null, created_at: d(-50), updated_at: d(-50) },
    { id: 'demo-bd-003', name: 'Sophie Müller', birthday: '1988-12-19', note: 'Idea de regalo: libro de cocina', avatar_url: null, created_at: d(-45), updated_at: d(-45) },
    { id: 'demo-bd-004', name: 'Liam O\'Brien', birthday: '1995-08-30', note: '', avatar_url: null, created_at: d(-40), updated_at: d(-40) },
    { id: 'demo-bd-005', name: 'Aisha Patel', birthday: '1991-05-31', note: 'Cumple 35 — ¿fiesta sorpresa?', avatar_url: null, created_at: d(-35), updated_at: d(-35) },
    { id: 'demo-bd-006', name: 'Carlos Reyes', birthday: '1987-11-07', note: 'Lo conocí en la conferencia', avatar_url: null, created_at: d(-30), updated_at: d(-30) },
  ];

  const vestiaire = [
    { id: 'demo-vest-001', name: 'Blazer de lino', category: 'Abrigos', color: 'Azul marino', brand: 'COS', size: 'M', note: 'Genial para noches de verano', purchase_status: null, image_url: null, sort_order: 0, created_at: d(-90), updated_at: d(-10) },
    { id: 'demo-vest-002', name: 'Camisa Oxford blanca', category: 'Camisas', color: 'Blanco', brand: 'Uniqlo', size: 'M', note: '', purchase_status: null, image_url: null, sort_order: 1, created_at: d(-80), updated_at: d(-20) },
    { id: 'demo-vest-003', name: 'Chino slim', category: 'Pantalones', color: 'Caqui', brand: 'Arket', size: '32', note: 'Corte entallado', purchase_status: null, image_url: null, sort_order: 2, created_at: d(-70), updated_at: d(-15) },
    { id: 'demo-vest-004', name: 'Zapatillas para correr', category: 'Calzado', color: 'Negro/Gris', brand: 'Nike Pegasus', size: '43', note: 'Reemplazar tras 800 km', purchase_status: null, image_url: null, sort_order: 3, created_at: d(-60), updated_at: d(-5) },
    { id: 'demo-vest-005', name: 'Abrigo de lana', category: 'Abrigos', color: 'Carbón', brand: 'Massimo Dutti', size: 'L', note: 'Solo limpieza en seco', purchase_status: null, image_url: null, sort_order: 4, created_at: d(-120), updated_at: d(-30) },
    { id: 'demo-vest-006', name: 'Bolso tote de lona', category: 'Accesorios', color: 'Crudo', brand: 'Muji', size: '', note: 'Para el día a día', purchase_status: null, image_url: null, sort_order: 5, created_at: d(-50), updated_at: d(-25) },
  ];

  const lists = [
    { id: 'demo-list-001', name: 'Destinos de viaje', shortname: 'Viajes', color: '#14b8a6', icon: 'map-pin', sort_order: 0, archived: 0, created_at: d(-30), updated_at: d(-2) },
    { id: 'demo-list-002', name: 'Gastos a reembolsar', shortname: 'Gastos', color: '#ef4444', icon: 'receipt', sort_order: 1, archived: 0, created_at: d(-15), updated_at: d(-1) },
    { id: 'demo-list-003', name: 'Películas por ver', shortname: 'Pelis', color: '#a855f7', icon: 'film', sort_order: 2, archived: 0, created_at: d(-20), updated_at: d(-3) },
  ];

  const list_items = [
    { id: 'demo-li-001', list_id: 'demo-list-001', text: 'Tokio', checked: 0, note: null, sort_order: 0, created_at: d(-30), updated_at: d(-30) },
    { id: 'demo-li-002', list_id: 'demo-list-001', text: 'Lisboa', checked: 0, note: null, sort_order: 1, created_at: d(-28), updated_at: d(-28) },
    { id: 'demo-li-003', list_id: 'demo-list-001', text: 'Patagonia', checked: 0, note: null, sort_order: 2, created_at: d(-25), updated_at: d(-25) },
    { id: 'demo-li-004', list_id: 'demo-list-001', text: 'Reikiavik', checked: 0, note: null, sort_order: 3, created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-li-005', list_id: 'demo-list-002', text: 'Uber a la oficina 12 €', checked: 0, note: null, sort_order: 0, created_at: d(-10), updated_at: d(-10) },
    { id: 'demo-li-006', list_id: 'demo-list-002', text: 'Comida con cliente 45 €', checked: 0, note: null, sort_order: 1, created_at: d(-8), updated_at: d(-8) },
    { id: 'demo-li-007', list_id: 'demo-list-002', text: 'Billete de tren 28 €', checked: 0, note: null, sort_order: 2, created_at: d(-5), updated_at: d(-5) },
    { id: 'demo-li-008', list_id: 'demo-list-003', text: 'Mulholland Drive', checked: 0, note: null, sort_order: 0, created_at: d(-20), updated_at: d(-20) },
    { id: 'demo-li-009', list_id: 'demo-list-003', text: 'Stalker', checked: 0, note: null, sort_order: 1, created_at: d(-18), updated_at: d(-18) },
    { id: 'demo-li-010', list_id: 'demo-list-003', text: 'In the Mood for Love', checked: 0, note: null, sort_order: 2, created_at: d(-15), updated_at: d(-15) },
  ];

  return { projects, tasks, todos, habits, habit_completions: sharedHabitCompletions(), flashcards, flashcard_notes, birthdays, vestiaire, lists, list_items };
}

// ── MAIN EXPORT ──
export function getDemoData(lang) {
  const gen = lang === 'fr' ? fr : lang === 'es' ? es : en;
  const data = gen();

  // Compute next_due for each habit from completions + frequency_rule
  if (data.habits && data.habit_completions) {
    for (const habit of data.habits) {
      const completions = data.habit_completions
        .filter(c => c.habit_id === habit.id)
        .sort((a, b) => b.completed_at.localeCompare(a.completed_at));
      const lastDone = completions.length > 0 ? completions[0].completed_at.slice(0, 10) : null;
      habit.next_due = computeNextDue(habit.frequency_rule, lastDone);
    }
  }

  // Settings — just the language
  data.settings = [{ id: 'demo-settings-1', key: 'lang', value: lang, created_at: d(-1), updated_at: d(-1) }];

  // Texts for revision — one poem per language
  const poems = {
    en: {
      title: 'Ozymandias',
      author: 'Percy Bysshe Shelley',
      deck: 'Poetry',
      content: `I met a traveller from an antique land,\nWho said — "Two vast and trunkless legs of stone\nStand in the desert. . . . Near them, on the sand,\nHalf sunk a shattered visage lies, whose frown,\nAnd wrinkled lip, and sneer of cold command,\nTell that its sculptor well those passions read\nWhich yet survive, stamped on these lifeless things,\nThe hand that mocked them, and the heart that fed;\nAnd on the pedestal, these words appear:\nMy name is Ozymandias, King of Kings;\nLook on my Works, ye Mighty, and despair!\nNothing beside remains. Round the decay\nOf that colossal Wreck, boundless and bare\nThe lone and level sands stretch far away."`,
    },
    fr: {
      title: 'Demain, dès l\'aube',
      author: 'Victor Hugo',
      deck: 'Poésie',
      content: `Demain, dès l'aube, à l'heure où blanchit la campagne,\nJe partirai. Vois-tu, je sais que tu m'attends.\nJ'irai par la forêt, j'irai par la montagne.\nJe ne puis demeurer loin de toi plus longtemps.\n\nJe marcherai les yeux fixés sur mes pensées,\nSans rien voir au dehors, sans entendre aucun bruit,\nSeul, inconnu, le dos courbé, les mains croisées,\nTriste, et le jour pour moi sera comme la nuit.\n\nJe ne regarderai ni l'or du soir qui tombe,\nNi les voiles au loin descendant vers Harfleur,\nEt quand j'arriverai, je mettrai sur ta tombe\nUn bouquet de houx vert et de bruyère en fleur.`,
    },
    es: {
      title: 'Poema 20',
      author: 'Pablo Neruda',
      deck: 'Poesía',
      content: `Puedo escribir los versos más tristes esta noche.\nEscribir, por ejemplo: «La noche está estrellada,\ny tiritan, azules, los astros, a lo lejos.»\n\nEl viento de la noche gira en el cielo y canta.\nPuedo escribir los versos más tristes esta noche.\nYo la quise, y a veces ella también me quiso.\n\nEn las noches como ésta la tuve entre mis brazos.\nLa besé tantas veces bajo el cielo infinito.\n\nElla me quiso, a veces yo también la quería.\nCómo no haber amado sus grandes ojos fijos.`,
    },
  };
  const poem = poems[lang] || poems.en;
  data.texts = [{
    id: 'demo-text-001', deck: poem.deck, title: poem.title, author: poem.author,
    content: poem.content, lines_per_chunk: 4, context_lines: 1,
    created_at: d(-20), updated_at: d(-3),
  }];
  // Generate chunk progress for the poem
  const poemLines = poem.content.split('\n');
  const poemChunks = [];
  let ci = 0, nonEmpty = 0, chunk = [];
  for (const line of poemLines) {
    chunk.push(line);
    if (line.trim() !== '') nonEmpty++;
    if (nonEmpty >= 4) {
      poemChunks.push(ci);
      ci++; chunk = []; nonEmpty = 0;
    }
  }
  if (chunk.length > 0) { poemChunks.push(ci); }
  data.text_line_progress = poemChunks.map(idx => ({
    id: `demo-tlp-${idx}`, text_id: 'demo-text-001', chunk_index: idx,
    strength: idx === 0 ? 5 : idx === 1 ? 3 : 0,
    next_review: idx === 0 ? dateOnly(7) : idx === 1 ? dateOnly(1) : null,
    last_reviewed: idx <= 1 ? d(-2) : null,
    created_at: d(-20), updated_at: d(-2),
  }));
  data.prompts = [];

  return data;
}

/** Returns an empty dataset with the same table keys */
export function getEmptyData() {
  return {
    projects: [], tasks: [], todos: [], habits: [], habit_completions: [],
    flashcards: [], flashcard_notes: [], birthdays: [], vestiaire: [],
    lists: [], list_items: [],
    settings: [], prompts: [], texts: [], text_line_progress: [], daily_visits: [],
    todo_categories: [], habit_categories: [], vestiaire_categories: [], flashcard_decks: [],
  };
}
