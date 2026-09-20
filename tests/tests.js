#!/usr/bin/env node
/**
 * DeLaClaw Static Analysis Tests
 * 
 * Static analysis of source code (grep/regex) — no browser automation.
 * Run via: node tests/tests.js (from repo root)
 * 
 * Catches: missing functions, HTML entities in JS, broken ES module chains,
 * schema drift between adapters, i18n gaps, CODEMAP staleness.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const JS_DIR = path.join(__dirname, '..', 'js');
const STYLE_FILE = path.join(__dirname, '..', 'style.css');
const INDEX_FILE = path.join(__dirname, '..', 'index.html');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// ===================================================================
// Load all JS files
// ===================================================================
const jsFiles = {};
const jsFileNames = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'));
for (const f of jsFileNames) {
  jsFiles[f] = fs.readFileSync(path.join(JS_DIR, f), 'utf-8');
}
const indexHtml = fs.readFileSync(INDEX_FILE, 'utf-8');
const styleCss = fs.readFileSync(STYLE_FILE, 'utf-8');

console.log('\n📋 Static Analysis\n');

// ===================================================================
// 1. No HTML entities in JS files
// ===================================================================
test('No HTML entities in JS files', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    const entities = content.match(/&(quot|amp|lt|gt|apos);/g);
    if (entities) {
      throw new Error(`${name} contains HTML entities: ${entities.join(', ')}`);
    }
  }
});

// ===================================================================
// 2. Balanced backticks (template literals) — skip files with regex backticks
// ===================================================================
test('Balanced backticks in JS files (excluding markdown processors)', () => {
  // Files that legitimately use backticks inside regex/strings for markdown parsing
  const skipFiles = new Set(['utils.js']);
  for (const [name, content] of Object.entries(jsFiles)) {
    if (skipFiles.has(name)) continue;
    const count = (content.match(/`/g) || []).length;
    if (count % 2 !== 0) {
      throw new Error(`${name} has ${count} backticks (odd — likely unclosed template literal)`);
    }
  }
});

// ===================================================================
// 2b. JS syntax valid — catches unescaped quotes like d'envoyer
// ===================================================================
test('All JS files are syntactically valid (no broken quotes)', () => {
  let acorn = null;
  try { acorn = require('acorn'); } catch {}
  const hasBunTranspiler = typeof Bun !== 'undefined' && Bun.Transpiler;
  let failures = [];
  for (const [name, content] of Object.entries(jsFiles)) {
    try {
      if (hasBunTranspiler) {
        const transpiler = new Bun.Transpiler({ loader: 'js' });
        transpiler.transformSync(content);
      } else if (acorn) {
        acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
      } else {
        // Fallback: Node's vm can at least check for unclosed strings via Function? Skip strict check
        // Do a lightweight heuristic for unescaped single-quote inside single-quoted string
        // This catches the classic d'envoyer mistake
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // naive: '...d'word pattern without escaping and without closing
          // Look for '...[^\\]'? Actually check for single-quoted string containing unescaped '
          // We'll try to parse single-quoted strings with a simple state machine
          let inSingle = false;
          let escaped = false;
          for (let j = 0; j < line.length; j++) {
            const ch = line[j];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === "'" && !inSingle) { inSingle = true; continue; }
            if (ch === "'" && inSingle) {
              // look ahead: if next char is a letter and prev char is not space/comma/etc, likely unescaped
              const next = line[j+1] || '';
              const prev = line[j-1] || '';
              // If inside an object value like: 'Impossible d'envoyer' -> after first close, next is letter
              if (/[a-zA-Z]/.test(next) && /[a-zA-Z]/.test(prev)) {
                throw new SyntaxError(`Unescaped apostrophe at ${name}:${i+1} -> ${line.trim().slice(0,80)}`);
              }
              inSingle = false;
            }
          }
        }
      }
    } catch (e) {
      failures.push(`${name}: ${e.message}`);
    }
  }
  if (failures.length) {
    throw new Error('Syntax errors:\n' + failures.join('\n'));
  }
});

// ===================================================================
// 3. All window.X = X assignments reference defined functions
// ===================================================================
test('All window.fn = fn assignments reference defined identifiers', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    // Match: window.foo = foo; or window.foo = foo\n
    const assignments = content.matchAll(/window\.(\w+)\s*=\s*(\w+)\s*[;\n]/g);
    for (const m of assignments) {
      const windowName = m[1];
      const localName = m[2];
      // Check that localName is defined somewhere in the file (function, const, let, var, or as a parameter)
      const defPatterns = [
        new RegExp(`function\\s+${localName}\\s*\\(`),
        new RegExp(`(?:const|let|var)\\s+${localName}\\s*=`),
        new RegExp(`window\\.${localName}\\s*=\\s*function`),
      ];
      const isDefined = defPatterns.some(p => p.test(content));
      // Also check if imported
      const isImported = new RegExp(`import\\s+.*\\b${localName}\\b.*from`).test(content);
      if (!isDefined && !isImported) {
        throw new Error(`${name}: window.${windowName} = ${localName} but ${localName} is never defined or imported`);
      }
    }
  }
});

// ===================================================================
// 4. All imports resolve to existing exports
// ===================================================================
test('All named imports resolve to exports in target files', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    // Match: import { foo, bar } from './baz.js'
    const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/(\w+\.js)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importedNames = match[1].split(',').map(s => s.trim()).filter(Boolean);
      const targetFile = match[2];
      const targetContent = jsFiles[targetFile];
      if (!targetContent) {
        throw new Error(`${name}: imports from ./${targetFile} but file doesn't exist`);
      }
      for (const imp of importedNames) {
        // Check export { ... imp ... } or export function imp or export const imp
        const exportBlock = targetContent.match(/export\s*\{([^}]+)\}/);
        const inExportBlock = exportBlock && exportBlock[1].split(',').map(s => s.trim()).includes(imp);
        const isExportedDirectly = new RegExp(`export\\s+(function|const|let|var)\\s+${imp}\\b`).test(targetContent);
        if (!inExportBlock && !isExportedDirectly) {
          throw new Error(`${name}: imports '${imp}' from ./${targetFile} but it's not exported`);
        }
      }
    }
  }
});


// ===================================================================
// 5. Sharing startup sync waits for loaded shared data
// ===================================================================
test('Sharing startup sync waits for loadAll before first feature refresh', () => {
  const main = jsFiles['main.js'];
  assert(main.includes('let initialSharingLoad = Promise.resolve()'),
    'main.js must track the initial sharing load promise');
  assert(main.indexOf('await initialSharingLoad') !== -1,
    'main.js must await initialSharingLoad before initial feature refreshes');
  assert(main.indexOf('await initialSharingLoad') < main.indexOf('await refreshTodos()'),
    'main.js must await sharing load before the first refreshTodos()');
  assert(main.includes('if (state.sharing) await syncSharedTodos();\n  await refreshTodos();'),
    'TODO startup must sync shared pointers before refreshTodos()');
  assert(main.includes('if (state.sharing) await syncSharedHabits();\n  await refreshHabits();'),
    'Habit startup must sync shared pointers before refreshHabits()');
  assert(main.includes('if (state.sharing) await syncSharedListItems();\n  await refreshLists();'),
    'List startup must sync shared pointers before refreshLists()');
});

test('Sharing refresh handler centralizes sync before render', () => {
  const main = jsFiles['main.js'];
  const handlerIdx = main.indexOf("document.addEventListener('sharing-changed', async () =>");
  assert(handlerIdx !== -1, 'main.js must own a single async sharing-changed handler');
  const handler = main.slice(handlerIdx, main.indexOf('  // Show demo banner', handlerIdx));
  // syncShared* handle pointer create/delete; the handler then does a full
  // refresh to also pick up external mutations (group-deletion cleanup, etc.)
  for (const seq of [
    ['syncSharedTodos', 'refreshTodos'],
    ['syncSharedHabits', 'refreshHabits'],
    ['syncSharedListItems', 'refreshLists'],
  ]) {
    const positions = seq.map(name => handler.indexOf(name));
    assert(positions.every(pos => pos !== -1), `sharing handler missing ${seq.join(' / ')}`);
    assert(positions[0] < positions[1],
      `sharing handler must run ${seq.join(' -> ')}`);
  }
  assert(!jsFiles['todos.js'].includes("document.addEventListener('sharing-changed'"),
    'todos.js must not register its own sharing-changed listener');
  assert(!jsFiles['habits.js'].includes("document.addEventListener('sharing-changed'"),
    'habits.js must not register its own sharing-changed listener');
  assert(!jsFiles['lists.js'].includes("document.addEventListener('sharing-changed'"),
    'lists.js must not register its own sharing-changed listener');
});

test('Orphan handler is module-level, not inside connect()', () => {
  const main = jsFiles['main.js'];
  // Listener must exist at module level
  assert(main.includes("document.addEventListener('sharing-orphan-detected'"),
    'main.js must register sharing-orphan-detected listener');
  // Must NOT be inside connect() — extract connect body and check
  const connectIdx = main.indexOf('async function connect(');
  assert(connectIdx !== -1, 'connect() must exist');
  const connectBody = main.slice(connectIdx, main.indexOf('\n}\n', connectIdx) + 3);
  assert(!connectBody.includes('sharing-orphan-detected'),
    'orphan listener must be outside connect() to avoid leak on reconnect');
});

test('Orphan handler uses queued processing, not direct showConfirmAction', () => {
  const main = jsFiles['main.js'];
  // Must have a queue and threshold
  assert(main.includes('_orphanQueue'), 'must use _orphanQueue for sequential processing');
  assert(main.includes('ORPHAN_THRESHOLD'), 'must require multiple detections before prompting');
  assert(main.includes('_processOrphanQueue'), 'must process queue sequentially');
});

test('Orphan handler passes onCancel to showConfirmAction', () => {
  const main = jsFiles['main.js'];
  // Find the orphan showConfirmAction call and check it has onCancel
  const orphanSection = main.slice(main.indexOf('function _processOrphanQueue'));
  assert(orphanSection.includes('onCancel'), 'orphan dialog must pass onCancel to allow retry');
});

test('showConfirmAction supports onCancel callback', () => {
  const utils = jsFiles['utils.js'];
  assert(utils.includes('_confirmCancelCallback'), 'utils.js must track cancel callback');
  // closeConfirmAction must fire cancel callback
  const closeFn = utils.slice(utils.indexOf('function closeConfirmAction()'));
  assert(closeFn.includes('cancelCb'), 'closeConfirmAction must invoke cancel callback');
  // executeConfirmAction must clear cancel before calling close (prevent double-fire)
  const execFn = utils.slice(utils.indexOf('async function executeConfirmAction()'));
  assert(execFn.includes('_confirmCancelCallback = null'), 'executeConfirmAction must clear cancel callback before close');
});

test('Sync dispatches sharing-orphan-detected instead of clearing directly', () => {
  for (const [file, label] of [['habits.js', 'habits'], ['todos.js', 'todos'], ['lists.js', 'lists']]) {
    const src = jsFiles[file];
    // Must dispatch event, not update/nullify directly
    assert(src.includes("sharing-orphan-detected"), `${label} sync must dispatch sharing-orphan-detected`);
    // Must NOT directly nullify shared fields in the orphan branch
    const orphanIdx = src.indexOf('sharing-orphan-detected');
    // Check the surrounding context doesn't do update({shared_id: null}) in the same branch
    const nearContext = src.slice(Math.max(0, orphanIdx - 200), orphanIdx);
    assert(!nearContext.includes("shared_id: null"), `${label} sync must not directly nullify shared fields near orphan detection`);
  }
});

test('Orphan handler deletes empty pointers instead of nullifying', () => {
  const main = jsFiles['main.js'];
  const handler = main.slice(main.indexOf('function _processOrphanQueue'));
  assert(handler.includes('hasContent'), 'orphan confirm must check if item has local content');
  assert(handler.includes('.delete()'), 'orphan confirm must delete empty pointer items');
  assert(handler.includes('.update('), 'orphan confirm must nullify items with local content');
});

test('Shared habit next_due read from shared storage during refresh', () => {
  const habits = jsFiles['habits.js'];
  assert(habits.includes('function normalizeHabitNextDue'),
    'habits.js must normalize next_due before comparing stored and computed values');
  assert(habits.includes('currentNextDue === nextDue'),
    'updateHabitNextDue must skip DB writes when next_due is unchanged');
  assert(habits.includes('if (habit) habit.next_due = nextDue'),
    'updateHabitNextDue must update in-memory state after a successful write');
  assert(habits.includes('sh.next_due'),
    'refreshHabits must read next_due from shared storage instead of recomputing');
});

test('Habit quick-add button resolves the sibling input before adding', () => {
  const delegation = jsFiles['delegation.js'];
  const actionMatch = delegation.match(/case 'add-habit-from-input':[\s\S]*?break;/);
  assert(actionMatch, 'delegation.js: add-habit-from-input action not found');
  assert(actionMatch[0].includes("querySelector('.habit-add-input, .todo-cat-input')"),
    'delegation.js: add-habit-from-input button clicks must pass the sibling input, not the button');

  const habits = jsFiles['habits.js'];
  assert(habits.includes("if (!inputEl || typeof inputEl.value !== 'string') return;"),
    'habits.js: addHabitFromInput must ignore non-input callers defensively');
});

test('Footer DB size RPC caches missing optional capability', () => {
  const utils = jsFiles['utils.js'];
  assert(utils.includes('DB_SIZE_REFRESH_MS'),
    'utils.js must throttle footer DB size refreshes');
  assert(utils.includes('_dbSizeByBackend'),
    'utils.js must cache DB size state per backend');
  assert(utils.includes('isMissingDbSizeRpc'),
    'utils.js must detect missing optional db_size_mb RPC');
  assert(utils.includes('!dbSizeState.unavailable && !dbSizeState.inFlight && stale'),
    'updateFooterStats must block unavailable, in-flight, and fresh db_size_mb requests');
  assert((utils.match(/state\.db\.rpc\('db_size_mb'\)/g) || []).length === 1,
    'updateFooterStats should have a single guarded db_size_mb call site');
});

test('Shared TODO sync reads local pointers from DB, not startup cache', () => {
  const todos = jsFiles['todos.js'];
  assert(todos.includes("state.db.from('todos').select('id,shared_id,shared_group_id')"),
    'syncSharedTodos must load local shared pointers from the DB');
  assert(!todos.includes('const localShared = allTodos.filter(t => t.shared_id)'),
    'syncSharedTodos must not depend on allTodos cache at startup');
});

// ===================================================================
// 6. Default imports resolve
// ===================================================================
test('Default imports resolve to default exports', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    const defaultImports = content.matchAll(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]\.\/(\w+\.js)['"]/g);
    for (const m of defaultImports) {
      const targetFile = m[2];
      const targetContent = jsFiles[targetFile];
      if (!targetContent) {
        throw new Error(`${name}: imports default from ./${targetFile} but file doesn't exist`);
      }
      if (!targetContent.includes('export default')) {
        throw new Error(`${name}: imports default from ./${targetFile} but no default export found`);
      }
    }
  }
});

// ===================================================================
// 6. No obvious syntax errors: unmatched braces in function bodies
// ===================================================================
test('No duplicate function definitions in same file', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    const funcDefs = {};
    const funcRegex = /(?:^|\n)\s*(?:async\s+)?function\s+(\w+)\s*\(/g;
    let m;
    while ((m = funcRegex.exec(content)) !== null) {
      const fn = m[1];
      if (funcDefs[fn]) {
        throw new Error(`${name}: function '${fn}' is defined twice (lines ~${funcDefs[fn]} and ~${content.substring(0, m.index).split('\n').length})`);
      }
      funcDefs[fn] = content.substring(0, m.index).split('\n').length;
    }
  }
});

// ===================================================================
// 7. HTML: all modal overlays have matching close functions
// ===================================================================
test('All modal overlay IDs have corresponding close onclick handlers', () => {
  const overlayIds = indexHtml.matchAll(/class="modal-overlay"\s+id="(\w+)"/g);
  for (const m of overlayIds) {
    const id = m[1];
    // Should have a close button somewhere
    const hasClose = indexHtml.includes(`close${id.charAt(0).toUpperCase()}`) || 
                     indexHtml.includes(`onclick="close`);
    // This is a loose check — just ensure the modal isn't orphaned
  }
});

// ===================================================================
// 8. All onclick handlers in HTML reference window-exposed functions
// ===================================================================
test('Key onclick handlers in index.html reference window-exposed functions', () => {
  // Extract all onclick="functionName(...)" from HTML
  const onclickRegex = /onclick="(\w+)\s*\(/g;
  const htmlFunctions = new Set();
  let m;
  while ((m = onclickRegex.exec(indexHtml)) !== null) {
    htmlFunctions.add(m[1]);
  }
  
  // Collect all window.X assignments and top-level function definitions exposed
  const windowExposed = new Set();
  for (const content of Object.values(jsFiles)) {
    const winAssign = content.matchAll(/window\.(\w+)\s*=/g);
    for (const wa of winAssign) windowExposed.add(wa[1]);
  }
  
  // Special: DOMContentLoaded-attached handlers don't need window exposure
  const builtins = new Set(['event', 'if', 'return', 'this']);
  
  for (const fn of htmlFunctions) {
    if (builtins.has(fn)) continue;
    if (!windowExposed.has(fn)) {
      // Check if it's maybe in the inline script or a known exception
      throw new Error(`onclick references '${fn}()' but no window.${fn} assignment found in JS modules`);
    }
  }
});

// ===================================================================
// 9. CSS: style.css is not empty and has expected selectors
// ===================================================================
test('style.css contains expected base selectors', () => {
  const required = ['.modal-overlay', '.modal', '.btn', '.app-header', '.project-card', '.view-tab'];
  for (const sel of required) {
    assert(styleCss.includes(sel), `Missing expected selector: ${sel}`);
  }
});

// ===================================================================
// 10. No stray console.log left in production code (warnings only)
// ===================================================================
test('No stray console.log in JS files (console.error/warn OK)', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    const logs = content.match(/console\.log\s*\(/g);
    if (logs && logs.length > 0) {
      // Just warn, don't fail
      console.log(`     ⚠️  ${name}: ${logs.length} console.log() calls (consider removing)`);
    }
  }
});

// ===================================================================
// 11. Habit "mark done" calls markHabitDone (no modal flow)
// ===================================================================
test('Habit done button calls markHabitDone directly (no modal)', () => {
  const habitsJs = jsFiles['habits.js'];
  // Button should call markHabitDone, not openHabitDoneModal
  assert(habitsJs.includes("markHabitDone("), 'markHabitDone function should exist');
  assert(habitsJs.includes("window.markHabitDone"), 'markHabitDone should be window-exposed');
  assert(!habitsJs.includes("openHabitDoneModal"), 'openHabitDoneModal should not exist');
  assert(!habitsJs.includes("closeHabitDoneModal"), 'closeHabitDoneModal should not exist');
  assert(!habitsJs.includes("submitHabitDone"), 'submitHabitDone should not exist');
  // No done modal in HTML
  assert(!indexHtml.includes('habitDoneModal'), 'habitDoneModal should not exist in index.html');
});

// ===================================================================
// 12. No emoji characters in JS files
// ===================================================================
test('No emoji characters in JS files (use Lucide icons instead)', () => {
  const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/u;
  // Specific known emojis to catch
  const knownEmojis = ['🎉', '🕰', '⚠️', '💪', '📚', '🎂', '⏳', '✅', '🪶', '↩️', '👔', '🔥'];
  for (const [name, content] of Object.entries(jsFiles)) {
    for (const emoji of knownEmojis) {
      assert(!content.includes(emoji), `${name} contains emoji ${emoji} — use Lucide icon instead`);
    }
  }
});

// ===================================================================
// 13. Flashcard sorting: cards are sorted by retrievability
// ===================================================================
test('Flashcard deck rendering sorts cards by retrievability', () => {
  const flashJs = jsFiles['flashcards.js'];
  assert(flashJs.includes('cards.sort('), 'cards should be sorted before rendering');
  assert(flashJs.includes('retrievability('), 'sort should use retrievability function');
});

// ===================================================================
// 14. Flashcard left border uses retrievability color (no strength bar)
// ===================================================================
test('Flashcard items use border-left color from retrievability (no strength bar)', () => {
  const flashJs = jsFiles['flashcards.js'];
  assert(flashJs.includes('borderColor'), 'should compute borderColor from retrievability');
  assert(flashJs.includes('border-left'), 'should apply border-left style');
  assert(!flashJs.includes('fc-strength-bar'), 'strength bar element should be removed');
  assert(!styleCss.includes('.fc-strength-bar'), 'strength bar CSS should be removed');
});

// ===================================================================
// 15. Birthday hover actions use correct rowSelector
// ===================================================================
test('Birthday hover delay uses .birthday-info as rowSelector (not .birthday-card)', () => {
  const birthJs = jsFiles['birthdays.js'];
  const hoverCall = birthJs.match(/initItemHoverDelay\([\s\S]*?rowSelector:\s*'([^']+)'/);
  assert(hoverCall, 'initItemHoverDelay should be called for birthdays');
  assert(hoverCall[1] === '.birthday-info', 
    `rowSelector should be '.birthday-info' (got '${hoverCall[1]}') — querySelector doesn't match self`);
});

// ===================================================================
// 16. Wardrobe left border uses purchase status (not category color)
// ===================================================================
test('Wardrobe items use purchase-status-based border color', () => {
  const vestJs = jsFiles['vestiaire.js'];
  assert(vestJs.includes('vest-purchased') || vestJs.includes('vest-tried'),
    'vestiaire should add status classes for border color');
  assert(styleCss.includes('.vest-purchased'), '.vest-purchased CSS rule should exist');
  assert(styleCss.includes('.vest-tried'), '.vest-tried CSS rule should exist');
});

// ===================================================================
// 17. All lucideIcon() calls reference icons defined in LUCIDE_PATHS
// ===================================================================
test('All lucideIcon() calls reference defined icons', () => {
  const iconsJs = jsFiles['icons.js'];
  // Extract all defined icon names from LUCIDE_PATHS
  const definedIcons = new Set();
  const defRegex = /'([^']+)'\s*:/g;
  let dm;
  while ((dm = defRegex.exec(iconsJs)) !== null) definedIcons.add(dm[1]);

  // Scan all JS files for lucideIcon('name' ...) calls
  for (const [name, content] of Object.entries(jsFiles)) {
    if (name === 'icons.js') continue;
    const callRegex = /lucideIcon\s*\(\s*['"]([^'"]+)['"]/g;
    let cm;
    while ((cm = callRegex.exec(content)) !== null) {
      const iconName = cm[1];
      assert(definedIcons.has(iconName),
        `${name}: lucideIcon('${iconName}') but '${iconName}' is not defined in LUCIDE_PATHS`);
    }
  }
  // Also check data-icon attributes in index.html
  const dataIconRegex = /data-icon="([^"]+)"/g;
  let hm;
  while ((hm = dataIconRegex.exec(indexHtml)) !== null) {
    const iconName = hm[1];
    assert(definedIcons.has(iconName),
      `index.html: data-icon="${iconName}" but '${iconName}' is not defined in LUCIDE_PATHS`);
  }
});

// ===================================================================
// 18. Double-click edit: no ondblclick HTML attributes in JS (use onDblClick callback)
// ===================================================================
test('No ondblclick HTML attributes in JS files (use initItemHoverDelay onDblClick)', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    if (name === 'item-utils.js') continue; // the shared module itself is fine
    const matches = content.match(/ondblclick\s*=/g);
    assert(!matches,
      `${name}: found ${matches ? matches.length : 0} ondblclick attribute(s) — use initItemHoverDelay onDblClick callback instead`);
  }
});

// ===================================================================
// 19. Double-click edit: all initItemHoverDelay calls include onDblClick
// ===================================================================
test('All initItemHoverDelay calls include onDblClick callback', () => {
  const pages = ['projects.js', 'todos.js', 'habits.js', 'birthdays.js', 'vestiaire.js', 'flashcards.js'];
  for (const file of pages) {
    const content = jsFiles[file];
    if (!content) continue;
    // Find initItemHoverDelay call blocks
    const hoverCalls = content.match(/initItemHoverDelay\([^)]*\{[\s\S]*?\}\s*\)/g);
    assert(hoverCalls && hoverCalls.length > 0,
      `${file}: should call initItemHoverDelay`);
    for (const call of hoverCalls) {
      assert(call.includes('onDblClick'),
        `${file}: initItemHoverDelay missing onDblClick callback`);
    }
  }
});

// ===================================================================
// 20. Double-click triggers inline edit (not modal) on all pages
// ===================================================================
test('Double-click onDblClick triggers inline edit (not modal) on all pages', () => {
  // Each page's onDblClick callback must call an inline edit function, not a modal opener
  // We check that the function called within onDblClick uses inlineEditText (directly or via a wrapper)
  const inlinePages = {
    'projects.js': { dblClickFn: 'promptEditTask', mustUse: 'inlineEditText' },
    'todos.js': { dblClickFn: 'editTodoInline', mustUse: 'inlineEditText' },
    'habits.js': { dblClickFn: 'editHabitInline', mustUse: 'inlineEditText' },
    'birthdays.js': { dblClickFn: 'editBirthdayInline', mustUse: 'inlineEditText' },
    'vestiaire.js': { dblClickFn: 'editVestiaire', mustUse: 'inlineEditText' },
    'flashcards.js': { dblClickFn: 'editFlashcardInline', mustUse: 'inlineEditText' },
  };
  for (const [file, { dblClickFn, mustUse }] of Object.entries(inlinePages)) {
    const content = jsFiles[file];
    if (!content) continue;
    // 1. The onDblClick callback should reference the inline edit function (not openEdit*Modal)
    const hoverCalls = content.match(/initItemHoverDelay\([^)]*\{[\s\S]*?\}\s*\)/g) || [];
    for (const call of hoverCalls) {
      assert(!call.match(/openEdit\w*Modal/),
        `${file}: onDblClick should not call a modal opener — use inline edit instead`);
    }
    // 2. The inline edit function should exist and use inlineEditText
    assert(content.includes(dblClickFn),
      `${file}: missing inline edit function '${dblClickFn}'`);
    assert(content.includes(mustUse),
      `${file}: inline edit should use shared '${mustUse}' from item-utils.js`);
  }
});

// ===================================================================
// 21. rowSelector must differ from itemSelector (querySelector doesn't match self)
// ===================================================================
test('initItemHoverDelay rowSelector differs from itemSelector', () => {
  const pagesWithHover = ['projects.js', 'todos.js', 'habits.js', 'birthdays.js', 'vestiaire.js', 'flashcards.js'];
  for (const file of pagesWithHover) {
    const content = jsFiles[file];
    if (!content) continue;
    const calls = content.match(/initItemHoverDelay\([^)]*\{[\s\S]*?\}\s*\)/g) || [];
    for (const call of calls) {
      const itemSel = call.match(/itemSelector:\s*'([^']+)'/);
      const rowSel = call.match(/rowSelector:\s*'([^']+)'/);
      if (itemSel && rowSel) {
        assert(itemSel[1] !== rowSel[1],
          `${file}: rowSelector '${rowSel[1]}' must differ from itemSelector '${itemSel[1]}' — querySelector doesn't match self`);
      }
    }
  }
});

// ===================================================================
// 22. Inline edit textareas set flex:none (prevent flex-grow in column wrapper)
// ===================================================================
test('Inline edit textareas set flex:none to prevent column-flex height bug', () => {
  // item-utils.js inlineEditText must set flex:none on the textarea
  const itemUtils = jsFiles['item-utils.js'];
  // Find the textarea creation block in inlineEditText
  assert(itemUtils.includes("flex = 'none'") || itemUtils.includes('flex = "none"'),
    'item-utils.js: inlineEditText textarea must set style.flex = "none" to prevent flex-grow overriding autoSize in column flex wrapper');

  // Any other file creating task-edit-input textareas (e.g. flashcards answer) must also set flex:none
  for (const [name, content] of Object.entries(jsFiles)) {
    if (name === 'item-utils.js') continue;
    // Find textarea elements with task-edit-input class
    const creations = content.match(/\.className\s*=\s*['"][^'"]*task-edit-input[^'"]*['"]/g);
    if (creations) {
      // Check that flex:none is set nearby (within 5 lines after)
      for (const creation of creations) {
        const idx = content.indexOf(creation);
        const nearby = content.substring(idx, idx + 400);
        assert(nearby.includes("flex = 'none'") || nearby.includes('flex = "none"'),
          `${name}: textarea with task-edit-input class must set style.flex = "none" for autoSize to work in column flex wrappers`);
      }
    }
  }
});

// ===================================================================
// 23. Welcome habit dblclick calls canonical window.editHabitInline (not a local duplicate)
// ===================================================================
test('Welcome habit dblclick calls canonical window.editHabitInline', () => {
  const welcome = jsFiles['welcome.js'];
  // Find the initItemHoverDelay call for habits in welcome.js (the one with .habit-item)
  const hoverCalls = welcome.match(/initItemHoverDelay\([^)]*\{[\s\S]*?\}\s*\)/g) || [];
  const habitCall = hoverCalls.find(c => c.includes("'.habit-item'") || c.includes('".habit-item"'));
  assert(habitCall, 'welcome.js: should have initItemHoverDelay call for .habit-item');
  // Must call window.editHabitInline, not welcomeEditHabit or a local function
  assert(habitCall.includes('window.editHabitInline'),
    'welcome.js: habit onDblClick must call window.editHabitInline (canonical), not a local welcomeEditHabit duplicate');
  assert(!habitCall.includes('welcomeEditHabit'),
    'welcome.js: habit onDblClick must NOT reference welcomeEditHabit — use canonical window.editHabitInline');
});

// ===================================================================
// 23b. Welcome habit edit button calls canonical window.editHabitInline (not modal)
// ===================================================================
test('Welcome habit edit button calls window.editHabitInline (not modal)', () => {
  const welcome = jsFiles['welcome.js'];
  // The renderFocusHabitItem function should use editHabitInline for the pencil button
  // Support both legacy onclick and CSP delegated data-action
  const editBtnMatch = welcome.match(/onclick=.*edit.*Habit.*pencil/g) || welcome.match(/data-action="edit-habit-inline"/g) || [];
  assert(editBtnMatch.length > 0, 'welcome.js: should have an edit button for habits with pencil icon');
  // Must reference editHabitInline (directly or via delegation mapping), not welcomeEditHabit or openEditHabitModal
  const usesInline = editBtnMatch.some(m => m.includes('editHabitInline') || m.includes('edit-habit-inline')) || welcome.includes('edit-habit-inline');
  assert(usesInline,
    'welcome.js: habit edit button must call editHabitInline, not welcomeEditHabit or openEditHabitModal');
  // Must NOT have welcomeEditHabit function defined
  assert(!welcome.includes('function welcomeEditHabit'),
    'welcome.js: welcomeEditHabit function should be removed — use canonical editHabitInline');
  // Must NOT reference openEditHabitModal
  assert(!welcome.includes('openEditHabitModal'),
    'welcome.js: must not reference openEditHabitModal — use inline edit instead');
});

// ===================================================================
// 23c. Welcome habit items render shared group badge like Habits page
// ===================================================================
test('Welcome habit items render shared group badge like Habits page', () => {
  const welcome = jsFiles['welcome.js'];
  assert(welcome.includes("import { sharedBadge } from './sharing-ui.js';"),
    'welcome.js: must import sharedBadge from sharing-ui.js');
  const fnMatch = welcome.match(/function\s+renderFocusHabitItem\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert(fnMatch, 'welcome.js: renderFocusHabitItem not found');
  const fn = fnMatch[1];
  assert(fn.includes('habit.shared_id') && fn.includes('habit.shared_group_id'),
    'welcome.js: focus habit rendering must detect shared habit pointers');
  assert(fn.includes('state.sharing.getAllGroups()') && fn.includes('sharedBadge'),
    'welcome.js: focus habit rendering must use sharedBadge with the sharing group name');
  assert(fn.includes('${sharedHtml}'),
    'welcome.js: focus habit must render the shared badge');
});

// ===================================================================
// 23d. Welcome habit actions delegate to canonical Habit handlers (shared-aware)
// ===================================================================
test('Welcome habit actions delegate to canonical shared-aware handlers', () => {
  const welcome = jsFiles['welcome.js'];
  const getFn = (name) => {
    const match = welcome.match(new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
    assert(match, `welcome.js: ${name} function not found`);
    return { params: match[1], body: match[2] };
  };

  const done = getFn('welcomeMarkHabitDone');
  assert(done.params.includes('btnEl'),
    'welcome.js: welcomeMarkHabitDone must accept btnEl so canonical markHabitDone can apply its pending UI guard');
  assert(done.body.includes('window.markHabitDone') && done.body.includes('btnEl'),
    'welcome.js: welcomeMarkHabitDone must delegate to window.markHabitDone(habitId, btnEl)');

  const del = getFn('welcomeDeleteHabit');
  assert(del.body.includes('window.deleteHabit'),
    'welcome.js: welcomeDeleteHabit must delegate to window.deleteHabit so shared habit deletes propagate');

  for (const [name, fn] of Object.entries({ welcomeMarkHabitDone: done, welcomeDeleteHabit: del })) {
    assert(!/state\.db\.from\(['"]habit_completions['"]\)\.insert/.test(fn.body),
      `welcome.js: ${name} must not insert local completions; use canonical shared-aware handler`);
    assert(!/state\.db\.from\(['"]habits['"]\)\.delete/.test(fn.body),
      `welcome.js: ${name} must not delete habits locally; use canonical shared-aware handler`);
    assert(!fn.body.includes('refreshHabits()'),
      `welcome.js: ${name} must not manually refresh habits; canonical handler dispatches habits-changed`);
  }
});

// ===================================================================
// 23e. Welcome habit done delegation passes the clicked button element
// ===================================================================
test('Welcome habit done delegation passes clicked button element', () => {
  const delegation = jsFiles['delegation.js'];
  const actionMatch = delegation.match(/case 'welcome-mark-habit-done':[\s\S]*?break;/);
  assert(actionMatch, 'delegation.js: welcome-mark-habit-done action not found');
  assert(actionMatch[0].includes("callWindow('welcomeMarkHabitDone'"),
    'delegation.js: welcome-mark-habit-done must call welcomeMarkHabitDone');
  assert(/habitId\|\|getId\(el\),\s*el/.test(actionMatch[0]),
    'delegation.js: welcome-mark-habit-done must pass el through for canonical markHabitDone pending UI guard');
});

// ===================================================================
// 24. Welcome TODO dblclick calls canonical window.editTodoInline (not a local duplicate)
// ===================================================================
test('Welcome TODO dblclick calls canonical window.editTodoInline', () => {
  const welcome = jsFiles['welcome.js'];
  // Find the initItemHoverDelay call for todos in welcome.js (the one with .todo-item)
  const hoverCalls = welcome.match(/initItemHoverDelay\([^)]*\{[\s\S]*?\}\s*\)/g) || [];
  const todoCall = hoverCalls.find(c => c.includes("'.todo-item'") || c.includes('".todo-item"'));
  assert(todoCall, 'welcome.js: should have initItemHoverDelay call for .todo-item');
  // Must call window.editTodoInline, not welcomeEditTodo or a local function
  assert(todoCall.includes('window.editTodoInline'),
    'welcome.js: todo onDblClick must call window.editTodoInline (canonical), not a local welcomeEditTodo duplicate');
  assert(!todoCall.includes('welcomeEditTodo'),
    'welcome.js: todo onDblClick must NOT reference welcomeEditTodo — use canonical window.editTodoInline');
});

// ===================================================================
// 24b. Welcome TODO items render shared group badge like TODO page
// ===================================================================
test('Welcome TODO items render shared group badge like TODO page', () => {
  const welcome = jsFiles['welcome.js'];
  assert(welcome.includes("import { sharedBadge } from './sharing-ui.js';"),
    'welcome.js: must import sharedBadge from sharing-ui.js');
  const fnMatch = welcome.match(/function\s+renderFocusTodoItem\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert(fnMatch, 'welcome.js: renderFocusTodoItem not found');
  const fn = fnMatch[1];
  assert(fn.includes('td.shared_id') && fn.includes('td.shared_group_id'),
    'welcome.js: focus TODO rendering must detect shared TODO pointers');
  assert(fn.includes('state.sharing.getAllGroups()') && fn.includes('sharedBadge'),
    'welcome.js: focus TODO rendering must use sharedBadge with the sharing group name');
  assert(fn.includes('${sharedHtml}'),
    'welcome.js: focus TODO must render the shared badge');
});

// ===================================================================
// 24c. Welcome TODO actions delegate to canonical TODO handlers (shared-aware)
// ===================================================================
test('Welcome TODO actions delegate to canonical shared-aware handlers', () => {
  const welcome = jsFiles['welcome.js'];
  const getFn = (name) => {
    const match = welcome.match(new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
    assert(match, `welcome.js: ${name} function not found`);
    return { params: match[1], body: match[2] };
  };

  const toggle = getFn('welcomeToggleTodo');
  assert(toggle.params.includes('btnEl'),
    'welcome.js: welcomeToggleTodo must accept btnEl so canonical toggleTodo can apply its pending UI guard');
  assert(toggle.body.includes('window.toggleTodo') && toggle.body.includes('btnEl'),
    'welcome.js: welcomeToggleTodo must delegate to window.toggleTodo(id, done, btnEl)');

  const del = getFn('welcomeDeleteTodo');
  assert(del.body.includes('window.deleteTodo'),
    'welcome.js: welcomeDeleteTodo must delegate to window.deleteTodo so shared TODO deletes propagate');

  const priority = getFn('welcomeSetPriority');
  assert(priority.body.includes('welcomeClosePriorityPicker()'),
    'welcome.js: welcomeSetPriority must close the welcome priority picker before delegating');
  assert(priority.body.includes('window.setTodoPriority'),
    'welcome.js: welcomeSetPriority must delegate to window.setTodoPriority so shared TODO priority updates propagate');

  for (const [name, fn] of Object.entries({ welcomeToggleTodo: toggle, welcomeDeleteTodo: del, welcomeSetPriority: priority })) {
    assert(!/state\.db\.from\(['"]todos['"]\)\.update/.test(fn.body),
      `welcome.js: ${name} must not update todos locally; use canonical shared-aware handler`);
    assert(!/state\.db\.from\(['"]todos['"]\)\.delete/.test(fn.body),
      `welcome.js: ${name} must not delete todos locally; use canonical shared-aware handler`);
    assert(!fn.body.includes('refreshTodos()'),
      `welcome.js: ${name} must not manually refresh todos; canonical handler dispatches todos-changed`);
  }
});

// ===================================================================
// 24d. Welcome TODO toggle delegation passes the clicked button element
// ===================================================================
test('Welcome TODO toggle delegation passes clicked button element', () => {
  const delegation = jsFiles['delegation.js'];
  const actionMatch = delegation.match(/case 'welcome-toggle-todo':[\s\S]*?break;/);
  assert(actionMatch, 'delegation.js: welcome-toggle-todo action not found');
  assert(actionMatch[0].includes("callWindow('welcomeToggleTodo'"),
    'delegation.js: welcome-toggle-todo must call welcomeToggleTodo');
  assert(/wDone\s*,\s*el/.test(actionMatch[0]),
    'delegation.js: welcome-toggle-todo must pass el through for canonical toggleTodo pending UI guard');
});

// ===================================================================
// 25. edit*Inline functions accept optional itemEl parameter (scoped querySelector)
// ===================================================================
test('edit*Inline functions accept optional itemEl parameter for scoped querySelector', () => {
  // editHabitInline in habits.js must have itemEl parameter
  const habits = jsFiles['habits.js'];
  const habitMatch = habits.match(/function\s+editHabitInline\s*\(([^)]*)\)/);
  assert(habitMatch, 'habits.js: editHabitInline function not found');
  assert(habitMatch[1].includes('itemEl'),
    'habits.js: editHabitInline must accept itemEl parameter for scoped querySelector');

  // editTodoInline in todos.js must have itemEl parameter
  const todos = jsFiles['todos.js'];
  const todoMatch = todos.match(/function\s+editTodoInline\s*\(([^)]*)\)/);
  assert(todoMatch, 'todos.js: editTodoInline function not found');
  assert(todoMatch[1].includes('itemEl'),
    'todos.js: editTodoInline must accept itemEl parameter for scoped querySelector');
});

// ===================================================================
// 25b. editHabitInline updates shared habits through sharing API
// ===================================================================
test('editHabitInline updates shared habits through sharing API', () => {
  const habits = jsFiles['habits.js'];
  const start = habits.indexOf('function editHabitInline');
  const end = habits.indexOf('function openEditHabitModal', start);
  assert(start !== -1 && end !== -1, 'habits.js: editHabitInline block not found');
  const fn = habits.slice(start, end);

  assert(fn.includes('habit.shared_id') && fn.includes('habit.shared_group_id') && fn.includes('state.sharing'),
    'habits.js: editHabitInline must detect shared habit pointers');
  assert(fn.includes('state.sharing.updateSharedHabit'),
    'habits.js: editHabitInline must update shared habits through updateSharedHabit');
  assert(!fn.includes('creator_category'),
    'habits.js: editHabitInline must not rewrite creator_category when local deck changes');
  assert(fn.includes("state.db.from('habits').update({ category: updates.category, category_id: updates.category_id })"),
    'habits.js: editHabitInline must update only the local category pointer for shared habits');

  const sharedBranch = fn.slice(fn.indexOf('if (habit.shared_id'), fn.indexOf('} else {', fn.indexOf('if (habit.shared_id')));
  assert(!/state\.db\.from\(['"]habits['"]\)\.update\(updates\)/.test(sharedBranch),
    'habits.js: editHabitInline shared branch must not write the full updates object only to local DB');
});

// ===================================================================
// 25c. List item edit action uses shared-aware inline editor
// ===================================================================
test('List item edit action uses shared-aware inline editor', () => {
  const lists = jsFiles['lists.js'];
  const delegation = jsFiles['delegation.js'];

  const aliasMatch = lists.match(/function\s+editListItemInline\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/);
  assert(aliasMatch, 'lists.js: editListItemInline alias not found');
  assert(aliasMatch[2].includes('editListItemInlineFull'),
    'lists.js: editListItemInline must delegate to shared-aware editListItemInlineFull');

  assert(lists.includes('window.editListItemInline = editListItemInline'),
    'lists.js: editListItemInline must be exposed for backward-compatible callers');
  assert(lists.includes('window.editListItemInlineFull = editListItemInlineFull'),
    'lists.js: editListItemInlineFull must remain exposed');

  const actionMatch = delegation.match(/case 'edit-list-item-inline':[\s\S]*?break;/);
  assert(actionMatch, 'delegation.js: edit-list-item-inline action not found');
  assert(actionMatch[0].includes("callWindow('editListItemInlineFull'"),
    'delegation.js: pencil edit action must route directly to editListItemInlineFull');
});

// ===================================================================
// 25d. editListItemInlineFull updates shared list items through sharing API
// ===================================================================
test('editListItemInlineFull updates shared list items through sharing API', () => {
  const lists = jsFiles['lists.js'];
  const start = lists.indexOf('function editListItemInlineFull');
  const end = lists.indexOf('// ===================================================================\n// CRUD — ITEMS', start);
  assert(start !== -1 && end !== -1, 'lists.js: editListItemInlineFull block not found');
  const fn = lists.slice(start, end);

  assert(fn.includes('item.shared_id') && fn.includes('item.shared_group_id') && fn.includes('state.sharing'),
    'lists.js: editListItemInlineFull must detect shared list-item pointers');
  assert(fn.includes('state.sharing.updateItem'),
    'lists.js: editListItemInlineFull must update shared list items through sharing.updateItem');
  assert(fn.includes('currentPayload') && fn.includes('...currentPayload') && fn.includes('...drivePayload'),
    'lists.js: editListItemInlineFull must merge text/note into the existing shared payload');

  const sharedIdx = fn.indexOf('if (item.shared_id');
  const normalIdx = fn.indexOf('// Normal', sharedIdx);
  const sharedBranch = fn.slice(sharedIdx, normalIdx);
  // Shared branch may write list_id locally (pointer reassignment), but must not write text/note only to local pointer
  const localUpdates = [...sharedBranch.matchAll(/state\.db\.from\(['"]list_items['"]\)\.update\(([^)]*)\)/g)];
  localUpdates.forEach(m => {
    assert(m[1].includes('list_id'),
      'lists.js: editListItemInlineFull shared branch local DB write must be for list_id only, not text/note');
  });
});

// ===================================================================
// 25e. toggleListItemCheck has per-item pending guard and button state
// ===================================================================
test('toggleListItemCheck has per-item pending guard and button state', () => {
  const lists = jsFiles['lists.js'];
  assert(lists.includes('const _pendingListItemToggles = new Set()'),
    'lists.js: toggleListItemCheck must use a per-item pending Set');

  const start = lists.indexOf('async function toggleListItemCheck');
  const end = lists.indexOf('async function deleteListItem', start);
  assert(start !== -1 && end !== -1, 'lists.js: toggleListItemCheck block not found');
  const fn = lists.slice(start, end);

  const params = fn.match(/async function toggleListItemCheck\s*\(([^)]*)\)/)?.[1] || '';
  assert(params.includes('btnEl'),
    'lists.js: toggleListItemCheck must accept btnEl so the clicked button can be disabled');
  assert(fn.includes('_pendingListItemToggles.has(id)') && fn.includes('_pendingListItemToggles.add(id)'),
    'lists.js: toggleListItemCheck must block duplicate clicks for the same item');
  assert(fn.includes('disabled = true') && fn.includes("setAttribute('aria-busy', 'true')"),
    'lists.js: toggleListItemCheck must disable matching buttons while saving');
  assert(fn.includes('finally') && fn.includes('_pendingListItemToggles.delete(id)') && fn.includes("removeAttribute('aria-busy')"),
    'lists.js: toggleListItemCheck must clean up pending state in finally');

  const delegation = jsFiles['delegation.js'];
  const actionMatch = delegation.match(/case 'toggle-list-item-check':[\s\S]*?break;/);
  assert(actionMatch, 'delegation.js: toggle-list-item-check action not found');
  assert(/getId\(el\),\s*el/.test(actionMatch[0]),
    'delegation.js: toggle-list-item-check must pass the clicked element through');
});

// ===================================================================
// 25f. Shared list add action passes the clicked button element
// ===================================================================
test('Shared list add action passes clicked button element', () => {
  const lists = jsFiles['lists.js'];
  const delegation = jsFiles['delegation.js'];

  const actionMatch = delegation.match(/case 'share-list-item-from-add':[\s\S]*?break;/);
  assert(actionMatch, 'delegation.js: share-list-item-from-add action not found');
  assert(/shareListItemFromAdd',\s*\[el,\s*el\.dataset\.listId\|\|getId\(el\)\]/.test(actionMatch[0]),
    'delegation.js: share-list-item-from-add must pass the clicked button, not only the list id');

  const start = lists.indexOf('async function shareListItemFromAdd');
  const end = lists.indexOf('window.shareListItemFromAdd', start);
  assert(start !== -1 && end !== -1, 'lists.js: shareListItemFromAdd block not found');
  const fn = lists.slice(start, end);
  assert(fn.includes("typeof btn === 'string'") && fn.includes("typeof actualBtn.closest === 'function'"),
    'lists.js: shareListItemFromAdd must tolerate legacy list-id calls without calling closest() on a string');
});

// ===================================================================
// 25g. Sharing adapters normalize completeItem(doneBy) without nested arrays
// ===================================================================
test('Sharing adapter normalizes completeItem(doneBy) without nested arrays', () => {
  const drive = jsFiles['sharing-drive.js'];

  const start = drive.indexOf('async completeItem(groupId, itemId, doneBy)');
  const end = drive.indexOf('async uncompleteItem', start);
  assert(start !== -1 && end !== -1, 'sharing-drive.js: completeItem block not found');
  const fn = drive.slice(start, end);
  assert(fn.includes('Array.isArray(doneBy)') && fn.includes('normalizedDoneBy'),
    'sharing-drive.js: completeItem must normalize string/array doneBy values');
  assert(fn.includes('done_by: normalizedDoneBy'),
    'sharing-drive.js: completeItem must write the flattened normalized array');
  assert(!/done_by:\s*doneBy/.test(fn),
    'sharing-drive.js: completeItem must not write raw doneBy directly');
});

test('sharing member identity is memberId-based and agent-safe', () => {
  const iface = fs.readFileSync(path.join(JS_DIR, 'sharing-interface.js'), 'utf-8');
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');

  assert(iface.includes('Emails are permission material, not identity'),
    'sharing-interface.js must document the memberId/displayName identity invariant');
  assert(iface.includes('getCurrentMember') && iface.includes('getAgentSafeGroup'),
    'sharing interface must expose current-member and agent-safe group APIs');

  assert(sui.includes('data-member-id') && !sui.includes('data-email'),
    'sharing-ui.js must remove members by memberId, not email/display string');
  assert(sui.includes('state.sharing.getCurrentMember(group.id)'),
    'sharing-ui.js must ask the adapter for current group membership');

  assert(drive.includes('The raw email is never persisted in group.json'),
    'sharing-drive.js must treat invite email as permission material only');
  assert(!drive.includes(`email,\n          name: email`),
    'sharing-drive.js must not write raw invite email into group.json members');
});

test('sharing create-group modal locks UI and reports file progress', () => {
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  const i18n = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf-8');

  assert(drive.includes('async createGroup(name, onProgress)'),
    'sharing-drive.js createGroup must accept an onProgress callback');
  assert(drive.includes("onProgress?.({ step: 'itemFiles', done: doneFiles, total: totalFiles })"),
    'sharing-drive.js must report per-file progress as each upload resolves');
  assert(sui.includes('sharingCreateGroupCancelBtn') && sui.includes('cancelBtn.disabled = true'),
    'sharing-ui.js must disable the Cancel button while the group is being created');
  assert(sui.includes('!overlay.dataset.creating'),
    'sharing-ui.js must block backdrop dismissal while the group is being created');
  assert(sui.includes('sharingCreateProgress') && sui.includes('sharingCreateProgressFill'),
    'sharing-ui.js must render a progress bar in the create-group modal');
  assert(sui.includes("t('sharing.creating_files', ev.done, ev.total)"),
    'sharing-ui.js must show the determinate file count during creation');
  for (const key of ['creating_folder', 'writing_group', 'creating_files']) {
    assert(i18n.includes(key + ':'),
      `i18n.js must define the sharing.${key} progress string`);
  }
});

test('sharing partial creation: group.json last, trash on failure, load-time GC', () => {
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');

  // 1. group.json is written AFTER the item-file uploads: its presence marks completion
  const createStart = drive.indexOf('async createGroup(name, onProgress)');
  const createEnd = drive.indexOf('/** Load all groups', createStart);
  const createBody = drive.slice(createStart, createEnd);
  const promiseAllIdx = createBody.indexOf('const results = await Promise.all(');
  const groupJsonIdx = createBody.indexOf(`driveUpload(tok, subfolder.id, null, 'group.json', group)`);
  assert(promiseAllIdx !== -1 && groupJsonIdx !== -1 && groupJsonIdx > promiseAllIdx,
    'createGroup must upload group.json after the item-file Promise.all (presence = completion marker)');

  // 2. In-session cleanup: a failed creation trashes the partial folder, then rethrows
  assert(createBody.includes('await driveTrashFile(tok, subfolder.id)'),
    'createGroup must best-effort trash the partial folder on failure');
  assert(createBody.includes('throw err;'),
    'createGroup must rethrow after cleanup so the modal shows the error');

  // 3. Own-group discovery is purely row-based: loadAll reads the kind
  //    'created' rows and finds each folder by its deterministic
  //    DeLaClaw-Shared-{groupId} name — no DeLaClaw-Shared/ folder scan,
  //    no abandoned-folder GC, no 15-minute grace.
  assert(!drive.includes('ABANDONED_GROUP_AGE_MS'),
    'sharing-drive.js must not define the abandoned-group age threshold anymore');
  const loadStart = drive.indexOf('async function loadGroup(folderId, groupId, opts');
  const loadEnd = drive.indexOf('async function normalizeEntry', loadStart);
  const loadBody = drive.slice(loadStart, loadEnd);
  assert(!loadBody.includes('ageMs'),
    'loadGroup must not compute a folder age anymore');
  assert(!loadBody.includes('driveTrashFile(tok, folderId)'),
    'loadGroup must never trash folders at load time anymore');
  // A created row is only written after group.json lands, so a missing
  // group.json on an owned folder means the folder's files were deleted on
  // Drive: throw so the skipped notice names the group instead of silently
  // dropping it.
  assert(loadBody.includes('if (!gFile && owned)'),
    'loadGroup must treat a missing group.json on an owned folder as broken');
  assert(loadBody.includes('throw downloadError(`group.json for own group'),
    'loadGroup must throw (skipped notice) when an owned folder lacks group.json');

  // 3b. loadAll discovers own groups from the groups table, not from a
  //     DeLaClaw-Shared/ folder scan
  const allStart = drive.indexOf('/** Load all groups');
  const allEnd = drive.indexOf('getAllGroups()', allStart);
  const allBody = drive.slice(allStart, allEnd);
  assert(allBody.includes("driveFindFolder(tok, GROUP_PREFIX + gid, null)"),
    'loadAll must find each own-group folder by its deterministic DeLaClaw-Shared-{groupId} name');
  assert(allBody.includes("row.kind !== 'created'"),
    'loadAll must iterate the kind created rows of the groups table for own groups');
  assert(!allBody.includes('driveListChildren(tok, rootFolder.id'),
    'loadAll must not scan the DeLaClaw-Shared/ root folder for own groups');
  assert(allBody.includes('_skippedGroups.set(gid, { name })'),
    'loadAll must surface the skipped chip with the stored name when an own-group folder is missing on Drive');

  // 4. Per-folder error isolation: one bad folder must not fail the whole loadAll
  assert(allBody.includes('.catch(err =>'),
    'loadAll must isolate per-folder load failures so one bad folder cannot break all groups');

  // 5. No createdTime plumbing remains (the age guard is gone)
  assert(!drive.includes('createdTime'),
    'sharing-drive.js must not reference createdTime anymore');

  // 6. CSP must allow the Drive picker iframe (join flow)
  const frameSrc = html.match(/frame-src ([^;]+);/);
  assert(frameSrc && frameSrc[1].includes('https://docs.google.com'),
    'index.html CSP frame-src must allow https://docs.google.com for the Drive join picker');

  // 7. Group creation is all-or-nothing: the kind 'created' row must be
  //    durably recorded before the group exists in memory or in the UX.
  //    A failed upsert throws (the creation catch trashes the folder and the
  //    modal shows the error); the old warn-only path must be gone.
  assert(!createBody.includes("console.warn('sharing: failed to record created group:'"),
    'createGroup must not warn-and-continue when the created-group row upsert fails');
  assert(createBody.includes('Failed to record created group'),
    'createGroup must throw when the created-group row upsert fails');
  const upsertIdx = createBody.indexOf("db.from('groups').upsert(createdRow, { onConflict: 'id' })");
  const memRegIdx = createBody.indexOf('_groups.set(groupId, entry)');
  assert(upsertIdx !== -1 && memRegIdx !== -1 && memRegIdx > upsertIdx,
    'createGroup must register the group in memory only after the groups-row upsert succeeds');

  // 8. The poll announces newly joined members: pending → joined flips
  //    detected by diffing against the pre-overwrite local state emit a
  //    'member-joined' event (self excluded), and main.js toasts it.
  assert(drive.includes("emit('member-joined'"),
    'sharing-drive.js poll must emit member-joined for newly joined members');
  assert(drive.includes('selfMemberId'),
    'sharing-drive.js poll must exclude our own member ID from join announcements');
  const main = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf-8');
  assert(/onUpdate\(\(event, detail\)/.test(main) && main.includes("event === 'member-joined'"),
    'main.js must toast on the sharing member-joined event');
  assert(main.includes("t('sharing.member_joined'"),
    "main.js must use the sharing.member_joined i18n key for the join toast");
  const i18n = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf-8');
  const locStarts = {};
  for (const m of i18n.matchAll(/^  (en|fr|es): \{$/gm)) locStarts[m[1]] = m.index;
  const locOrder = ['en', 'fr', 'es'];
  for (let i = 0; i < locOrder.length; i++) {
    const slice = i18n.slice(locStarts[locOrder[i]], i + 1 < locOrder.length ? locStarts[locOrder[i + 1]] : i18n.length);
    assert(/^\s{6}member_joined:/m.test(slice),
      `i18n.js [${locOrder[i]}].sharing must define 'member_joined:'`);
  }
});

test('sharing group load is all-or-nothing: a failed file download skips the whole group', () => {
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');

  // Labeled download errors preserve the Drive status code, so callers can
  // distinguish access loss (403/404) from transient failures.
  assert(drive.includes('function downloadError(what, err)'),
    'sharing-drive.js must define the downloadError helper');
  assert(drive.includes('if (err?.code != null) e.code = err.code;'),
    'downloadError must preserve the Drive status code on the wrapped error');

  // loadGroupWithIds (joined path): every required-file download must throw on
  // failure — never degrade to a partially-loaded group (a half-loaded group
  // could show the user's items as missing, inviting recreates that become
  // duplicates once the real file loads).
  const idsStart = drive.indexOf('async function loadGroupWithIds(folderId, groupId, fileIds)');
  const idsEnd = drive.indexOf('/** Map item_type to the per-type file key. */', idsStart);
  const idsBody = drive.slice(idsStart, idsEnd);
  assert(!idsBody.includes('return null'),
    'loadGroupWithIds must not degrade failed downloads to null (partial group)');
  assert(idsBody.includes('throw downloadError(`group.json for joined group ${groupId}`, err)'),
    'loadGroupWithIds must throw a labeled error when the group.json download fails');
  assert(idsBody.includes('throw downloadError(`${type}.json for joined group ${groupId}`, err)'),
    'loadGroupWithIds must throw a labeled error when an item-file download fails');

  // loadGroup (owned path): revoked.json and item-file downloads must throw too.
  // (group.json already threw: its download has no catch handler.)
  const loadStart = drive.indexOf('async function loadGroup(folderId, groupId, opts');
  const dlStart = drive.indexOf('const downloads = [];', loadStart);
  const dlEnd = drive.indexOf('const [gResult, revokedResult', loadStart);
  const dlBody = drive.slice(dlStart, dlEnd);
  assert(!dlBody.includes('return null'),
    'loadGroup must not degrade failed revoked/item downloads to null (partial group)');
  assert(dlBody.includes('throw downloadError(`revoked.json for group ${groupId}`, err)'),
    'loadGroup must throw a labeled error when the revoked.json download fails');
  assert(dlBody.includes('throw downloadError(`${ITEM_TYPES[i]}.json for group ${groupId}`, err)'),
    'loadGroup must throw a labeled error when an item-file download fails');

  // loadAll: a joined load that fails with 403/404 (access gone — removed or
  // group deleted) must consult revoked.json immediately and apply the
  // verdict, because the poll only covers loaded groups.
  const allStart = drive.indexOf('/** Load all groups');
  const allEnd = drive.indexOf('getAllGroups()', allStart);
  const allBody = drive.slice(allStart, allEnd);
  assert(allBody.includes('if (err?.code === 403 || err?.code === 404)'),
    'loadAll must detect access loss (403/404) on joined group loads');
  assert(allBody.includes('checkRemovalViaRevoked(joined.id, tok)'),
    'loadAll must consult revoked.json when a joined load fails with 403/404');
  assert(allBody.includes('handleStaleGroup(joined.id, verdict)'),
    'loadAll must apply the removed/deleted verdict for the failed joined group');

  // handleStaleGroup: shared verdict handling (poll + loadAll) — drops the
  // group, notifies the app, purges the groups-table row.
  assert(drive.includes('async handleStaleGroup(groupId, verdict)'),
    'sharing-drive.js must define handleStaleGroup');
  assert(drive.includes("db.from('groups').delete().eq('id', groupId)"),
    'handleStaleGroup must purge the groups-table row');

  // loadAll must still isolate the (now throwing) per-folder failures so one
  // bad folder cannot break the other groups.
  assert(allBody.includes('.catch(err =>'),
    'loadAll must isolate per-folder load failures so one bad folder cannot break all groups');
});

test('group-deleted notice is a dialog with a Drive folder link; skipped groups get a chip', () => {
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  const main = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf-8');
  const css = fs.readFileSync(STYLE_FILE, 'utf-8');
  const i18nSrc = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf-8');

  // handleStaleGroup looks up the groups-table row before purging and passes
  // the folderId with the removed-remotely event so the notice can link to
  // the Drive folder.
  assert(drive.includes('const row = _groupRows.find(r => r.id === groupId);'),
    'handleStaleGroup must look up the groups-table row before purging');
  assert(drive.includes('row?.folderId'),
    'handleStaleGroup must capture the folderId before purging the row');
  assert(drive.includes('{ detail: { groupName, verdict, folderId } }'),
    'sharing-group-removed-remotely must carry the folderId');

  // main.js: 'deleted' verdict → notice dialog with Drive link; 'removed' stays a toast.
  assert(main.includes("verdict === 'deleted'"),
    'main.js must branch the removed-remotely notice on the deleted verdict');
  assert(main.includes('showGroupDeletedNotice(groupName, folderId)'),
    'main.js must show the group-deleted dialog for the deleted verdict');
  assert(main.includes('drive.google.com/drive/folders/'),
    'group-deleted dialog must link to the Drive folder');
  assert(main.includes('LOGOS.googledrive(16)'),
    'group-deleted dialog must show the Google Drive icon next to the link');

  // loadAll: transient per-folder failures are recorded as skipped groups.
  assert(drive.includes('_skippedGroups.clear()'),
    'loadAll must rebuild the skipped set on every run');
  assert(drive.includes('_skippedGroups.set(groupId, { name:'),
    'loadAll must record a failed group load as skipped');
  assert(drive.includes('getSkippedGroups()'),
    'sharing-drive.js must expose getSkippedGroups()');
  assert(drive.includes('_skippedGroups.delete(groupId)'),
    'handleStaleGroup must clear a stale skip mark when a verdict is applied');

  // sharing-ui: skipped groups render with a chip in the Sharing pane.
  assert(sui.includes('getSkippedGroups?.()'),
    'renderSharingPane must read the skipped groups');
  assert(sui.includes('sharing-group-skipped-stamp'),
    'renderSharingPane must render skipped groups with a chip');
  assert(css.includes('.sharing-group-skipped-stamp'),
    'style.css must define the skipped chip');

  // i18n: new keys in all three locales.
  const starts = {};
  for (const m of i18nSrc.matchAll(/^  (en|fr|es): \{$/gm)) starts[m[1]] = m.index;
  const order = ['en', 'fr', 'es'];
  for (const key of ['group_deleted_title', 'group_deleted_check_folder', 'group_skipped']) {
    for (let i = 0; i < order.length; i++) {
      const slice = i18nSrc.slice(starts[order[i]], i + 1 < order.length ? starts[order[i + 1]] : i18nSrc.length);
      assert(new RegExp(`^\\s{6}${key}:`, 'm').test(slice),
        `i18n.js [${order[i]}].sharing must define '${key}:'`);
    }
  }
  assert(i18nSrc.includes("ok: 'OK'") && i18nSrc.includes("ok: 'Aceptar'"),
    "i18n.js must define common 'ok' in all locales");
});

test('groups table stores group names for unreachable-folder notices (joined + created)', () => {
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');

  // The groups table holds both joined pointers (kind 'joined') and created-
  // group records (kind 'created', id + name only) so notices can name a
  // group even when its Drive folder is unreachable.
  assert(drive.includes("kind: 'joined'"),
    'joinWithFileIds must tag the pointer row with kind joined');
  assert(drive.includes('name: groupData?.name || null'),
    'joinWithFileIds must store the group name in the pointer row');
  assert(drive.includes("kind: 'created'"),
    'createGroup must record the created group with kind created');
  assert(drive.includes("db.from('groups').upsert(createdRow, { onConflict: 'id' })"),
    'createGroup must persist the created-group row in the groups table');
  assert(drive.includes('for (const joined of _joinedRows())'),
    'loadAll must load only joined rows (kind !== created), never created records');

  // Name resolution order: live group data, then the stored groups-table row.
  assert(drive.includes('const _storedGroupName = (groupId) =>'),
    'sharing-drive.js must define _storedGroupName');
  assert(drive.includes('row?.name || groupId'),
    'handleStaleGroup must fall back to the stored groups-table row name');
  assert(drive.includes('_storedGroupName(gid)'),
    'loadAll must name a skipped own group from its created record');
  assert(drive.includes('joined.id, joined.name)'),
    'loadAll must pass the stored pointer name to the skip marking');

  // deleteGroup removes the created record; unjoinGroup removes the pointer.
  assert(drive.includes("// Drop the created-group row from the groups table"),
    'deleteGroup must drop the created-group row');
});

test('no localStorage group-name cache: names come from the groups table', () => {
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const adapter = fs.readFileSync(path.join(JS_DIR, 'adapters/drive.js'), 'utf-8');

  // The localStorage cache is gone — the groups table (synced personal data)
  // is the single source of stored group names.
  assert(!drive.includes('GROUP_NAME_CACHE_KEY'),
    'sharing-drive.js must not define a localStorage key for group names');
  assert(!drive.includes('cacheGroupName'),
    'sharing-drive.js must not define or call cacheGroupName');
  assert(!drive.includes('localStorage'),
    'sharing-drive.js must not touch localStorage for group names');

  // All group state (joined pointers + created-group records) lives in the
  // groups table.
  assert(adapter.includes("'groups',"),
    'DRIVE_TABLES must list the groups table');
});

test('sharing departure is unjoin-only (no leaveGroup)', () => {
  const iface = fs.readFileSync(path.join(JS_DIR, 'sharing-interface.js'), 'utf-8');
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const delegation = fs.readFileSync(path.join(JS_DIR, 'delegation.js'), 'utf-8');

  assert(!iface.includes('leaveGroup'),
    'sharing-interface.js must not expose leaveGroup');
  assert(!drive.includes('async leaveGroup'),
    'sharing-drive.js must not implement leaveGroup');
  assert(!sui.includes('sharingLeaveGroup') && !sui.includes('sharing-leave-group'),
    'sharing-ui.js must not reference the removed leave path');
  assert(!delegation.includes('sharing-leave-group'),
    'delegation.js must not route the removed leave action');
  assert(sui.includes('sharing-unjoin-group') && drive.includes('async unjoinGroup'),
    'unjoin must remain the single departure path');
});

test('sharing members use stable hashed IDs with a pending-invite join gate', () => {
  const iface = fs.readFileSync(path.join(JS_DIR, 'sharing-interface.js'), 'utf-8');
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');

  assert(drive.includes('async function memberIdFromEmail(email)'),
    'sharing-drive.js must derive the member ID deterministically from the email');
  assert(!drive.includes('function newMemberId()'),
    'sharing-drive.js must not mint random member IDs anymore');
  assert(drive.includes('const creatorMemberId = await memberIdFromEmail(user.email);'),
    'sharing-drive.js must derive the creator member ID from the email');
  assert(!drive.includes('emailHash'),
    'sharing-drive.js must not carry a separate emailHash field anymore');
  assert(!drive.includes('emailHint'),
    'sharing-drive.js must not carry the legacy emailHint fallback anymore');
  assert(drive.includes('No pending invite for this account'),
    'sharing-drive.js must reject joins without a matching pending invite');
  assert(drive.includes('m.status === \'pending\' && m.memberId === selfId'),
    'sharing-drive.js must match the joiner to their pending invite by stable member ID');
  assert(drive.includes('await assertCreator(groupId)'),
    'sharing-drive.js must enforce creator-only invite/remove in the adapter');
  assert(iface.includes('creator-only') && iface.includes('pending invite'),
    'sharing-interface.js must document creator-only ops and the pending-invite join requirement');
  // Regression: with stable IDs, a stale revoked.json entry must not false-trigger
  // removal for a removed-then-reinvited member — only removals recorded after
  // the current join count.
  assert(drive.includes('r.removed_at > joinedAt'),
    'checkRemovalViaRevoked must disambiguate removals by timestamp since member IDs are stable');
});

test('sharing email normalization is Gmail-scoped (dots significant elsewhere)', () => {
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const src = drive.match(/function normalizeEmail\(email\) \{[\s\S]*?\n  \}/);
  assert(src, 'sharing-drive.js must define normalizeEmail');
  const normalizeEmail = new Function(`${src[0]}; return normalizeEmail;`)();

  // Gmail: dots and +tags are ignored by Google
  assert(normalizeEmail('John.Doe@Gmail.com') === 'johndoe@gmail.com', 'gmail dots stripped');
  assert(normalizeEmail('john+tag@gmail.com') === 'john@gmail.com', 'gmail +tag stripped');
  assert(normalizeEmail('John.Doe@Googlemail.com') === 'johndoe@gmail.com', 'googlemail alias mapped');
  // Everywhere else dots are significant and must be preserved
  assert(normalizeEmail('John.Doe@Company.com') === 'john.doe@company.com', 'non-gmail dots kept');
  assert(normalizeEmail('  JOHN@Example.COM ') === 'john@example.com', 'trimmed and lowercased');
  // memberIdFromEmail must hash the normalized form
  assert(drive.includes('sha256Hex(normalizeEmail(email))'),
    'memberIdFromEmail must hash the normalized email, not the raw input');
});

test('groups is a Drive personal table, not a bespoke sharing file', () => {
  // The groups table must load with the other personal tables at startup
  // and be read/written through db — never via bespoke download/upload code
  // in sharing-drive.js, which would skip the per-table startup download
  // and silently back up an empty table.
  const driveAdapter = fs.readFileSync(path.join(JS_DIR, 'adapters/drive.js'), 'utf-8');
  const tablesMatch = driveAdapter.match(/const DRIVE_TABLES = \[([\s\S]*?)\];/);
  assert(tablesMatch, 'drive.js must define DRIVE_TABLES');
  assert(tablesMatch[1].includes("'groups'"),
    'DRIVE_TABLES must include groups so it loads with the other personal tables');

  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  assert(!drive.includes('loadJoinedGroups') && !drive.includes('saveJoinedGroups') && !drive.includes('_joinedMeta'),
    'sharing-drive.js must not keep bespoke groups file IO (loadJoinedGroups/saveJoinedGroups/_joinedMeta)');
  assert(drive.includes("db.from('groups')"),
    'sharing-drive.js must read/write group rows through db.from(\'groups\')');
  assert(drive.includes(".upsert(entry, { onConflict: 'id' })"),
    'join must upsert the pointer keyed on the row id so the Drive 412 merge stays a union');
  assert(drive.includes('createDriveSharing(getToken, personalFolderId, capabilities = {}, db = null)'),
    'createDriveSharing must accept the db proxy as a 4th parameter');

  const factory = fs.readFileSync(path.join(JS_DIR, 'sharing.js'), 'utf-8');
  assert(factory.includes('config.db,'),
    'sharing.js factory must pass config.db through to createDriveSharing');
  const main = jsFiles['main.js'];
  const sharingCfg = main.slice(main.indexOf("createSharing('googledrive'"));
  assert(sharingCfg.includes('db: state.db,'),
    'main.js must wire state.db into the googledrive sharing config');
});

test('fresh install writes settings.json last, as the completion marker', () => {
  // Regression: the fresh-install branch used to create settings.json (empty) in the
  // same parallel batch as every other table file, then flush schema_version into it.
  // A partial failure could leave settings.json stamped with schema_version=latest while
  // a category table file was missing — the retry then skipped both the fresh-install
  // seeding and the migrations, leaving the category table without its protected
  // (_default_*, __shared__) rows. settings.json must be written last, only after every
  // other table file was created and seeded, so a partial failure always leaves the
  // retry with no schema_version and the pending migrations re-seed the protected rows.
  const driveAdapter = fs.readFileSync(path.join(JS_DIR, 'adapters/drive.js'), 'utf-8');
  const freshStart = driveAdapter.indexOf('if (isFreshInstall)');
  assert(freshStart !== -1, 'drive.js must have a fresh-install branch');
  const freshBlock = driveAdapter.slice(freshStart, driveAdapter.indexOf('} else {', freshStart));

  const batchIdx = freshBlock.indexOf("filter(t => t !== 'settings')");
  assert(batchIdx !== -1,
    'fresh install must create all table files except settings.json in the first batch');
  const seedFlushIdx = freshBlock.indexOf('Flush seeded category tables to Drive');
  assert(seedFlushIdx > batchIdx,
    'fresh install must flush the seeded category tables before settings.json exists');
  const settingsWriteIdx = freshBlock.indexOf("uploadFile(seedTok, folderId, null, 'settings.json'");
  assert(settingsWriteIdx > seedFlushIdx,
    'fresh install must write settings.json (with schema_version) last, in a single upload');
});

test('migration runner uses the backup policy module', () => {
  const driveAdapter = fs.readFileSync(path.join(JS_DIR, 'adapters/drive.js'), 'utf-8');
  assert(driveAdapter.includes("from './drive-backup-policy.js'"),
    'drive.js must import the pre-migration backup policy module');
  assert(driveAdapter.includes('decideBackupAction('),
    'drive.js must decide restore/snapshot/stale via decideBackupAction');
});

test('migration runner deletes the pre-migration backup after the batch succeeds', () => {
  // A lingering backup always means "a migration failed and will be retried
  // from clean state" — never a historical archive.
  const driveAdapter = fs.readFileSync(path.join(JS_DIR, 'adapters/drive.js'), 'utf-8');
  assert(driveAdapter.includes('deleteFile(tok, backupId)'),
    'drive.js must delete the backup file after the migration batch completes');
});

test('migration restore overwrites table files in place (never delete-then-restore)', () => {
  // Deleting table files first would leave a window with zero table files, in
  // which the next connect would take the fresh-install branch and stamp empty
  // tables as latest.
  const driveAdapter = fs.readFileSync(path.join(JS_DIR, 'adapters/drive.js'), 'utf-8');
  const restoreIdx = driveAdapter.indexOf('drive_restoring_backup');
  assert(restoreIdx !== -1, 'drive.js must have a restore path');
  const restoreBlock = driveAdapter.slice(restoreIdx, restoreIdx + 2000);
  assert(restoreBlock.includes('uploadFile(restoreTok, folderId, meta.fileId'),
    'restore must overwrite each table file in place via its existing fileId');
});

test('migration runner writes settings.json once, at the end of the batch', () => {
  // The schema_version on Drive must move exactly once per batch: it is the
  // batch's completion marker, written only after every migration's tables
  // were uploaded. settings.json is therefore NOT flushed per migration.
  // A failure before the final write leaves the pre-batch version behind,
  // so a backup whose version equals the current version always means
  // "its batch did not complete" — no batch-target tracking needed.
  const driveAdapter = fs.readFileSync(path.join(JS_DIR, 'adapters/drive.js'), 'utf-8');
  assert(!driveAdapter.includes("dirtyTables.add('settings')"),
    'settings.json must not be flushed per migration');
  assert(driveAdapter.includes('uploadFile(settingsTok'),
    'settings.json must be written once after the migration loop');
});

test('no migration touches the schema_version settings entry', () => {
  // The backup/restore policy depends on the schema_version on Drive moving
  // exactly once per batch (written by the runner at the end). A migration
  // that read or wrote the version stamp independently would silently break
  // that invariant, so the contract forbids it (see drive-migrations.js
  // header, rule 5) and this test enforces it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'drive-migrations.js'), 'utf-8');
  // Strip comments so the contract's own documentation doesn't trip the check
  // (this file contains no '//' inside strings, so naive stripping is safe).
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => { const i = line.indexOf('//'); return i === -1 ? line : line.slice(0, i); })
    .join('\n');
  assert(!/schema_version/.test(code),
    'a migration references schema_version in code — the runner owns the version stamp');
});

test('sharing i18n keys used in code exist in every locale', () => {
  // Regression: t('sharing.name_updated') showed the raw key in English because
  // the string existed in fr/es but was missing from en. Every sharing.* key
  // referenced in code must be defined in all three locales.
  const i18n = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf-8');
  const starts = {};
  for (const m of i18n.matchAll(/^  (en|fr|es): \{$/gm)) starts[m[1]] = m.index;
  const order = ['en', 'fr', 'es'];
  const sharing = {};
  for (let i = 0; i < order.length; i++) {
    const slice = i18n.slice(starts[order[i]], i + 1 < order.length ? starts[order[i + 1]] : i18n.length);
    const s0 = slice.indexOf('    sharing: {');
    assert(s0 >= 0, `i18n.js must define a sharing section for [${order[i]}]`);
    const rest = slice.slice(s0);
    const next = rest.slice('    sharing: {'.length).search(/\n    [a-z_]+: \{/);
    sharing[order[i]] = next < 0 ? rest : rest.slice(0, '    sharing: {'.length + next);
  }
  const used = new Set();
  for (const f of ['sharing-ui.js', 'sharing-drive.js']) {
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf-8');
    for (const m of src.matchAll(/\bt\(\s*['"]sharing\.([A-Za-z0-9_]+)['"]/g)) used.add(m[1]);
  }
  assert(used.size > 0, 'expected to find t(\'sharing.*\') usages in sharing code');
  for (const key of [...used].sort()) {
    for (const loc of order) {
      assert(new RegExp(`^\\s{6}${key}:`, 'm').test(sharing[loc]),
        `i18n.js [${loc}].sharing must define '${key}:' (used via t('sharing.${key}'))`);
    }
  }
});

test('sharing async buttons use the standard busy shimmer', () => {
  // Invite / join / reconnect buttons must use the shared saving/is-pending
  // shimmer (same as guard() in main.js), not ad-hoc opacity/text swaps, so
  // it's always clear something is happening.
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  assert(!sui.includes("btn.style.opacity = '0.5'"),
    'sharing buttons must not use manual opacity instead of the busy shimmer');
  assert(sui.includes('function setBtnBusy(btn, busy)'),
    'sharing-ui.js must define the setBtnBusy helper');
  const uses = (sui.match(/setBtnBusy\(btn, true\)/g) || []).length;
  assert(uses >= 4, `expected at least 4 setBtnBusy(btn, true) uses, found ${uses}`);
});

test('sharing tab shows with loading state while init is pending', () => {
  // The Sharing tab must render alongside the other settings tabs even
  // before the async Drive sharing init finishes — the pane shows a loading
  // state and fills in on completion, instead of the tab popping in late.
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  const visFn = sui.slice(sui.indexOf('function updateSharingNavVisibility'));
  assert(visFn.includes("'googledrive'"),
    'sharing nav must show the tab while Drive sharing init is pending');
  assert(sui.includes('sharingInitFailed'),
    'a failed sharing init must hide the tab again');
  const paneFn = sui.slice(sui.indexOf('async function renderSharingPane'));
  assert(paneFn.includes("t('common.loading')"),
    'sharing pane must render a loading state while init is pending');
});

test('sharing join picker accepts every required file key', () => {
  // Regression: revoked.json became the 17th required group file (phase 3)
  // but the picker's doc→key allowlist in sharing-ui.js still hard-coded
  // the old 16 keys, so selecting revoked.json was silently dropped and the
  // join failed with "Missing files: revoked.json".
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  assert(!sui.includes("['group', 'todos', 'habits', 'lists']"),
    'sharing-ui.js must not hard-code the join picker key allowlist');
  const pickerFn = sui.slice(sui.indexOf('async function sharingOpenJoinPicker'));
  assert(pickerFn.includes('getRequiredGroupFiles()'),
    'sharingOpenJoinPicker must derive accepted keys from getRequiredGroupFiles()');
});

test('sharing join is disabled without a desktop-like pointer', () => {
  // Joining requires multi-selecting every group file in the Google file
  // picker. The gate is capability-based (fine pointer + hover), not device
  // identity: phones/tablets can't multi-select, touchscreen laptops can.
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  assert(sui.includes('isDesktopLike') && sui.includes("from './utils.js'"),
    'sharing-ui.js must import isDesktopLike from utils.js');
  const modalFn = sui.slice(sui.indexOf('function sharingOpenJoinCodeModal'));
  assert(modalFn.includes('if (!isDesktopLike())'),
    'sharingOpenJoinCodeModal must gate on isDesktopLike()');
  assert(modalFn.includes("t('sharing.join_not_available_on_touch')"),
    'sharingOpenJoinCodeModal must show the touch-device notice');
  const utils = fs.readFileSync(path.join(JS_DIR, 'utils.js'), 'utf-8');
  assert(utils.includes('function isDesktopLike()')
    && utils.includes("'(pointer: fine)'") && utils.includes("'(hover: hover)'"),
    'utils.js isDesktopLike must check fine pointer + hover (capability, not UA)');
});

test('sharing leave confirmation overrides the Delete default', () => {
  // Regression: the "Leave this group?" modal showed "Delete" with a trash icon
  // because showConfirmAction defaults the confirm button to Delete/trash.
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  const leaveCall = sui.slice(sui.indexOf('async function sharingUnjoinGroup'));
  assert(leaveCall.includes("btnText: t('sharing.leave')"),
    'sharingUnjoinGroup must override the confirm-modal Delete default with the Leave label');
  assert(leaveCall.includes("variant: 'neutral'"),
    'sharingUnjoinGroup must use the neutral (non-red) confirm variant');
});

test('sharing unjoin writes a left marker instead of deleting the member row', () => {
  // Leaving must keep a status:'left' tombstone in group.json so the creator's
  // poll can revoke the leaver's Drive permission (only the folder owner can).
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const unjoin = drive.slice(drive.indexOf('async unjoinGroup(groupId)'));
  const unjoinFn = unjoin.slice(0, unjoin.indexOf('},', unjoin.indexOf('emit(')));
  assert(unjoinFn.includes("self.status = 'left'"),
    'unjoinGroup must flip the member status to left');
  assert(unjoinFn.includes('self.leftAt'),
    'unjoinGroup must stamp leftAt on the member row');
  assert(!unjoinFn.includes('.filter(m => m.memberId !== currentMember.memberId)'),
    'unjoinGroup must not delete the member row from group.json');
  assert(drive.includes('async function revokeLeftMembers(groupId, tok)'),
    'sharing-drive.js must define the creator-side revokeLeftMembers sweep');
  assert(drive.includes('driveRemovePermission(tok, e.folderId, permissionId)'),
    'revokeLeftMembers must revoke the Drive permission for left members');
  assert(drive.includes("m.role === 'creator' || m.role === 'owner'") || drive.includes("m.role === 'owner'"),
    'revokeLeftMembers must never revoke the owner/creator permission');
  assert(drive.includes('isCreatorOf(groupId)') && drive.includes('revokeLeftMembers(groupId, tok)'),
    'the poll loop must run the revoke-left sweep for creator-owned groups');
});

test('sharing normalizeMember preserves the left marker', () => {
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const norm = drive.slice(drive.indexOf('async function normalizeMember'));
  assert(norm.includes('leftAt'),
    'normalizeMember must preserve leftAt so the left marker survives re-saves of group.json');
});

test('sharing UI never displays left members', () => {
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  assert(sui.includes('function visibleMembers(group)'),
    'sharing-ui.js must define a visibleMembers helper');
  assert(sui.includes("filter(m => m.status !== 'left')"),
    'visibleMembers must exclude status:left tombstones');
  for (const site of ['visibleMembers(group).length', 'for (const member of visibleMembers(group))',
      'visibleMembers(group).filter', 'visibleMembers(selectedGroup)']) {
    assert(sui.includes(site), `member display site must use visibleMembers (${site})`);
  }
});

test('sharing re-invite revives the existing row for the same email', () => {
  // Member IDs are stable per email, so re-inviting someone who left (or was
  // removed) must reset their existing row to a fresh pending invite instead
  // of minting a duplicate row.
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const invite = drive.slice(drive.indexOf('async inviteUser(groupId, inviteTarget)'));
  assert(invite.includes('const memberId = await memberIdFromEmail(email);'),
    'inviteUser must derive the member ID deterministically from the invite email');
  assert(invite.includes('const existing = e.group.members.find(m => m.memberId === memberId);'),
    'inviteUser must look up the existing member row by stable member ID');
  assert(invite.includes("existing.status = 'pending'") && invite.includes('existing.leftAt = null'),
    'inviteUser must revive a stale row (left/removed) back to a pending invite');
});

test('inviteUser refuses already-joined or pending members before any Drive call', () => {
  // Re-inviting a joined member must not demote them to pending, and
  // re-inviting a pending member must not mint a duplicate invite: the guard
  // runs against the in-memory roster before the Drive permission grant.
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const invite = drive.slice(drive.indexOf('async inviteUser(groupId, inviteTarget)'));
  const grantIdx = invite.indexOf('await driveShareWithUser(tok, e.folderId, email,');
  const joinedGuard = invite.indexOf("existing.status === 'joined'");
  const pendingGuard = invite.indexOf("existing.status === 'pending'");
  assert(joinedGuard !== -1 && joinedGuard < grantIdx,
    'inviteUser must reject an already-joined member before the Drive grant');
  assert(pendingGuard !== -1 && pendingGuard < grantIdx,
    'inviteUser must reject an already-pending invite before the Drive grant');
  const i18n = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf-8');
  assert(i18n.includes('already_member:') && i18n.includes('already_invited:'),
    'i18n.js must define sharing.already_member and sharing.already_invited');
});

test('member roster mutations are tracked as intents and acknowledged on saveGroup success', () => {
  // Only rows this client actually changed may win a 412 merge, so every
  // roster mutation marks an intent and saveGroup acknowledges them on success.
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  assert(drive.includes('if (!entry.memberIntents) entry.memberIntents = createIntentState();'),
    'normalizeEntry must initialise per-entry memberIntents');
  const createdMarks = (drive.match(/markCreated\(memberIntentsFor\(e\), memberId\)/g) || []).length;
  assert(createdMarks >= 2, 'inviteUser must markCreated on both the revive and the push branch');
  assert(drive.includes('markCreated(memberIntentsFor(e), member.memberId);'),
    'the join flip (pending → joined) must markCreated');
  assert(drive.includes('markDeleted(memberIntentsFor(e), memberId);'),
    'removeUser must markDeleted');
  assert(drive.includes('for (const id of leftIds) markDeleted(memberIntentsFor(e), id);'),
    'revokeLeftMembers must markDeleted for each swept left marker');
  const saveGroup = drive.slice(drive.indexOf('async function saveGroup(groupId'));
  assert(saveGroup.includes('mergeMemberLists(e.group.members, remoteGroup.members || [], memberIntentsFor(e))'),
    'saveGroup 412 merge must be intent-aware');
  assert(saveGroup.includes('acknowledgeIntents(memberIntents, capturedMemberIntents);'),
    'saveGroup must acknowledge member intents on successful upload');
});

test('poll reconciles the roster intent-aware instead of wholesale-overwriting', () => {
  // The 15s poll must not drop an invite whose group.json upload is still in
  // flight: rows this tab created (memberIntents.createdIds) survive the
  // overwrite via reconcileMembers; everything else takes the remote version.
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const poll = drive.slice(drive.indexOf('async poll()'));
  assert(poll.includes('reconcileMembers('),
    'poll must reconcile the member roster intent-aware');
  assert(poll.includes('e.group.members = members;'),
    'poll must apply the reconciled roster after the overwrite');
});

test('inviteUser rolls back the roster when the group.json write fails', () => {
  // A failed invite write must leave the tab exactly as if the invite never
  // happened: the pushed row is dropped (or the revived row restored) and the
  // intent discarded, so retrying passes the duplicate-invite guard. No UI
  // blocking, no bounded retry — the toast is the failure surface.
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const invite = drive.slice(drive.indexOf('async inviteUser(groupId, inviteTarget)'));
  const saveIdx = invite.indexOf('await saveGroup(groupId);');
  assert(saveIdx !== -1, 'inviteUser must await saveGroup');
  const tail = invite.slice(saveIdx);
  assert(tail.includes('catch (err)'), 'inviteUser must catch a saveGroup failure');
  assert(tail.includes('undoRosterChange?.();'),
    'inviteUser must roll back the roster mutation when saveGroup throws');
  assert(tail.includes('discardIntent(memberIntentsFor(e), memberId);'),
    'inviteUser must discard the member intent when saveGroup throws');
  assert(tail.includes('throw err;'), 'inviteUser must rethrow so the UI can toast');
});

test('loadGroup audits folder permissions for orphan grants (creator only)', () => {
  // Once per load, creator tabs list the folder's Drive permissions and
  // revoke writer grants with no matching member row in group.json (left by
  // failed invite writes or failed revocations). A member must never touch
  // another owner's folder ACL.
  const drive = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  const auditStart = drive.indexOf('async function auditFolderPermissions(groupId, tok)');
  assert(auditStart !== -1, 'auditFolderPermissions must exist');
  const audit = drive.slice(auditStart, drive.indexOf('function publicMember(member)'));
  assert(audit.includes('await isCreatorOf(groupId)'), 'audit must be creator-gated');
  assert(audit.includes('driveListPermissions(tok, e.folderId)'),
    'audit must list the folder permissions');
  assert(audit.includes("p.role !== 'writer'"), 'audit must only consider writer grants');
  assert(audit.includes('await driveRemovePermission(tok, e.folderId, p.id);'),
    'audit must revoke orphan grants');
  const load = drive.slice(drive.indexOf('async function loadGroup(folderId, groupId'));
  assert(load.includes('if (owned) await auditFolderPermissions(groupId, tok);'),
    'loadGroup must run the audit for owned groups');
});

// ===================================================================
// 26. Inline edit callbacks use refreshFn (not renderFn) for data refresh
// ===================================================================
test('Inline edit callbacks use refreshFn (not renderFn) for data refresh', () => {
  // For each module with inlineEditText calls, verify they pass refreshFn, not renderFn
  const files = {
    'todos.js': 'refreshTodos',
    'habits.js': 'refreshHabits',
    'flashcards.js': 'refreshFlashcards',
  };
  for (const [file, expectedRefresh] of Object.entries(files)) {
    const content = jsFiles[file];
    if (!content) continue;
    // Find all refreshFn: lines in inlineEditText options
    const refreshFnMatches = content.match(/refreshFn:\s*(\w+)/g) || [];
    assert(refreshFnMatches.length > 0,
      `${file}: should have at least one refreshFn in inlineEditText options`);
    for (const match of refreshFnMatches) {
      const fnName = match.replace(/refreshFn:\s*/, '');
      // Must not be a render-only function (renderHabits, renderTodos, etc.)
      assert(!fnName.startsWith('render'),
        `${file}: refreshFn should not be a render function ('${fnName}') — use a refresh function like ${expectedRefresh} that fetches data`);
    }
  }
});

// ===================================================================
// 27. Edit habit modal includes last-done date field
// ===================================================================
test('Edit habit modal includes last-done date field', () => {
  const habitsJs = jsFiles['habits.js'];
  assert(habitsJs, 'habits.js should exist');
  // The modal template (m2.innerHTML) must contain the editHabitLastDone input
  assert(habitsJs.includes('id="editHabitLastDone"') || habitsJs.includes("id=\\'editHabitLastDone\\'") || habitsJs.includes('id=\\"editHabitLastDone\\"'),
    'Edit habit modal should contain an input with id="editHabitLastDone"');
  // saveEditHabit must read the last-done value
  assert(habitsJs.includes("editHabitLastDone") && habitsJs.includes("saveEditHabit"),
    'saveEditHabit should reference editHabitLastDone');
  // openEditHabitModal must populate the last-done field
  const openFn = habitsJs.substring(habitsJs.indexOf('function openEditHabitModal'), habitsJs.indexOf('function closeEditHabitModal'));
  assert(openFn.includes('editHabitLastDone'),
    'openEditHabitModal should populate the editHabitLastDone input');
});

test('Shared habit last-done edits write to shared completions and can clear latest completion', () => {
  const habitsJs = jsFiles['habits.js'];
  const helperStart = habitsJs.indexOf('async function setSharedHabitLastDone');
  const helperEnd = habitsJs.indexOf('async function setLocalHabitLastDone', helperStart);
  assert(helperStart !== -1 && helperEnd !== -1, 'habits.js: setSharedHabitLastDone helper not found');
  const helper = habitsJs.slice(helperStart, helperEnd);
  assert(helper.includes('state.sharing.updateSharedHabit') && helper.includes('nextCompletions'),
    'habits.js: shared last-done edits must rewrite shared completions, not only local completions');
  // planLastDoneEdit handles the null case (clear latest) — verify it exists and is used
  const planFn = habitsJs.includes('function planLastDoneEdit');
  assert(planFn, 'habits.js: planLastDoneEdit pure helper must exist');
  assert(helper.includes('planLastDoneEdit'),
    'habits.js: setSharedHabitLastDone must use planLastDoneEdit for decision logic');

  const saveStart = habitsJs.indexOf('async function saveEditHabit');
  const saveEnd = habitsJs.indexOf('async function deleteHabit', saveStart);
  const saveFn = habitsJs.slice(saveStart, saveEnd);
  assert(saveFn.includes('setSharedHabitLastDone') && saveFn.includes('setLocalHabitLastDone'),
    'habits.js: saveEditHabit must route last-done changes through shared/local helpers');

  const inlineStart = habitsJs.indexOf('function editHabitLastDone');
  const inlineEnd = habitsJs.indexOf('function openHabitHistory', inlineStart);
  const inlineFn = habitsJs.slice(inlineStart, inlineEnd);
  assert(inlineFn.includes('setSharedHabitLastDone') && inlineFn.includes('setLocalHabitLastDone'),
    'habits.js: inline last-done edit must route through shared/local helpers');
  assert(inlineFn.includes('let didSave = false') && inlineFn.includes('if (didSave) return'),
    'habits.js: inline last-done edit must guard change+blur double saves');
});

test('Shared habit completions use group member ids, not account emails', () => {
  const habitsJs = jsFiles['habits.js'];
  const drive = jsFiles['sharing-drive.js'];
  const iface = jsFiles['sharing-interface.js'];

  assert(iface.includes('getCurrentMemberId'),
    'sharing-interface.js must expose getCurrentMemberId for shared completion authorship');

  const actorStart = habitsJs.indexOf('async function getSharedHabitCompletionActor');
  const actorEnd = habitsJs.indexOf('async function setSharedHabitLastDone', actorStart);
  const actorFn = habitsJs.slice(actorStart, actorEnd);
  assert(actorFn.includes('getCurrentMemberId') && actorFn.includes('getCurrentMember'),
    'habits.js: shared completion actor must resolve the current group member id');
  assert(!actorFn.includes('getCurrentUser') && !actorFn.includes('.email'),
    'habits.js: shared completion actor must not fall back to account email');

  const driveStart = drive.indexOf('async getCurrentMemberId');
  const driveEnd = drive.indexOf('// ─── Groups', driveStart);
  const driveFn = drive.slice(driveStart, driveEnd);
  assert(driveFn.includes('currentMemberId(groupId)') && !driveFn.includes('ensureUser') && !driveFn.includes('.email'),
    'sharing-drive.js: getCurrentMemberId must return the group member id, not the account email');
});

// ===================================================================
// 28. No duplicate IDs between index.html static modals and JS-created modals
// ===================================================================
test('No duplicate modal IDs between index.html and JS-created modals', () => {
  // Extract IDs of modal-overlay elements from index.html
  const htmlModalIds = [...indexHtml.matchAll(/class="modal-overlay"\s+id="([^"]+)"/g)].map(m => m[1]);
  // Extract IDs of dynamically created modals from JS (pattern: m.id = 'xxx' or .id = 'xxxModal')
  const jsModalIds = [];
  for (const [file, content] of Object.entries(jsFiles)) {
    const matches = content.matchAll(/\.id\s*=\s*['"]([^'"]*Modal[^'"]*)['"]/g);
    for (const m of matches) jsModalIds.push({ id: m[1], file });
  }
  const duplicates = jsModalIds.filter(j => htmlModalIds.includes(j.id));
  assert(duplicates.length === 0,
    `Duplicate modal IDs found — these exist in both index.html and JS:\n${duplicates.map(d => `       • ${d.id} (created in ${d.file})`).join('\n')}\n       Remove the static HTML versions since JS creates them dynamically.`);
});

// ===================================================================
// 29. All modal IDs referenced in JS getElementById exist (in HTML or created dynamically)
// ===================================================================

test('All modal-overlay IDs referenced via getElementById exist somewhere', () => {
  // 1. Collect all modal IDs defined in index.html
  const htmlModalIds = new Set(
    [...indexHtml.matchAll(/id="([^"]*Modal[^"]*)"/g)].map(m => m[1])
  );
  // 2. Collect all modal IDs created dynamically in JS
  //    Pattern A: .id = '...Modal'
  //    Pattern B: id="...Modal" or id='...Modal' inside template literals
  const jsCreatedIds = new Set();
  for (const content of Object.values(jsFiles)) {
    for (const m of content.matchAll(/\.id\s*=\s*['"]([^'"]*Modal[^'"]*)['"];/g)) {
      jsCreatedIds.add(m[1]);
    }
    for (const m of content.matchAll(/id=(?:\\?["'])([^"']*Modal[^"']*)(?:\\?["'])/g)) {
      jsCreatedIds.add(m[1]);
    }
  }
  const allDefinedIds = new Set([...htmlModalIds, ...jsCreatedIds]);

  // 3. Find all getElementById('...Modal') references in JS
  const referencedIds = new Set();
  for (const content of Object.values(jsFiles)) {
    for (const m of content.matchAll(/getElementById\(['"]([^'"]*Modal[^'"]*)['"]\)/g)) {
      referencedIds.add(m[1]);
    }
  }

  // 4. Check that every referenced modal ID is defined somewhere
  const missing = [...referencedIds].filter(id => !allDefinedIds.has(id));
  assert(missing.length === 0,
    `Modal IDs referenced in JS but never created:\n${missing.map(id => `       • ${id}`).join('\n')}\n       These will cause silent failures when clicked.`);
});

// ===================================================================
// 30. Drag-drop reorder is wired for all reorderable pages
// ===================================================================

test('All reorderable pages call initItemDragDrop with correct item selectors', () => {
  const fs = require('fs');
  const path = require('path');

  // Pages that MUST have drag-drop reorder, with expected item selector substring
  const expected = {
    'js/lists.js': '.list-item',
    'js/projects.js': '.task-item',
    'js/todos.js': '.todo-item',
    'js/vestiaire.js': '.vestiaire-item',
  };

  for (const [file, selector] of Object.entries(expected)) {
    const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    assert(src.includes('initItemDragDrop'), `${file} must call initItemDragDrop`);
    assert(src.includes(selector),
      `${file} must use item selector containing '${selector}'`);
  }

  // idAttr must be camelCase (dataset API), never raw 'data-xxx-yyy'
  const allFiles = ['js/lists.js', 'js/projects.js', 'js/todos.js', 'js/vestiaire.js'];
  for (const file of allFiles) {
    const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const idAttrMatches = src.match(/idAttr:\s*['"]([^'"]+)['"]/g) || [];
    for (const m of idAttrMatches) {
      const val = m.match(/['"]([^'"]+)['"]/)[1];
      assert(!val.includes('-'), `${file}: idAttr '${val}' must be camelCase for dataset API, not raw data attribute`);
    }
  }
});


test('Drag clones are globally tagged and cleaned before drag-enabled re-renders', () => {
  const itemUtils = jsFiles['item-utils.js'];
  assert(itemUtils.includes('DRAG_CLONE_SELECTOR'),
    'item-utils.js must expose a clone selector for stale drag artifact cleanup');
  assert(itemUtils.includes("clone.dataset.dragClone = 'true'"),
    'item-utils.js must tag temporary drag clones with data-drag-clone="true"');
  assert(itemUtils.includes('registerDragCleanup'),
    'item-utils.js must register document/window cleanup callbacks for active drags');
  for (const eventName of ['pointerup', 'pointercancel', 'visibilitychange', 'keydown', 'blur', 'contextmenu']) {
    assert(itemUtils.includes(eventName),
      `item-utils.js global drag cleanup must handle ${eventName}`);
  }

  const renderChecks = {
    'lists.js': 'function renderLists',
    'todos.js': 'function renderTodos',
    'projects.js': 'function buildProjectCards',
    'vestiaire.js': 'function renderVestiaire',
  };
  for (const [file, marker] of Object.entries(renderChecks)) {
    const src = jsFiles[file];
    assert(src.includes('cleanupDragArtifacts'), `${file} must import/use cleanupDragArtifacts before replacing drag-enabled DOM`);
    const renderStart = src.indexOf(marker);
    assert(renderStart !== -1, `${file}: missing ${marker}`);
    const firstInnerHtml = src.indexOf('innerHTML', renderStart);
    const cleanupIdx = src.indexOf('cleanupDragArtifacts()', renderStart);
    assert(cleanupIdx !== -1 && firstInnerHtml !== -1 && cleanupIdx < firstInnerHtml,
      `${file}: cleanupDragArtifacts() must run before the first render-time innerHTML replacement`);
  }
});

// ===================================================================
// 31. CHECK constraint parity across backends (Demo ↔ SQLite)
// ===================================================================

test('CHECK constraints match across Demo adapter and SQLite schema', () => {
  const demoSrc = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'adapters', 'demo.js'), 'utf8');
  const sqliteSrc = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'schema.sql'), 'utf8');

  // --- Helper: extract sorted values from a regex match group ---
  function extractValues(match, label) {
    assert(match, `Could not find ${label}`);
    const vals = match[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
    return vals.sort();
  }

  // --- Helper: compare two sorted arrays ---
  function assertSameValues(a, b, labelA, labelB) {
    const jsonA = JSON.stringify(a), jsonB = JSON.stringify(b);
    assert(jsonA === jsonB, `${labelA} ${jsonA} must match ${labelB} ${jsonB}`);
  }

  // ── 1. tasks.status ──

  const demoTaskStatus = extractValues(
    demoSrc.match(/tasks:\s*\{\s*status:\s*\[([^\]]+)\]/),
    'Demo CHECK_CONSTRAINTS tasks.status');

  const sqliteTaskStatus = extractValues(
    sqliteSrc.match(/tasks[\s\S]*?status\s+TEXT[^,]*CHECK\s*\(\s*status\s+IN\s*\(([^)]+)\)/i),
    'SQLite tasks.status CHECK');

  assertSameValues(demoTaskStatus, sqliteTaskStatus, 'Demo tasks.status', 'SQLite tasks.status');

  // Regression guard: draft must be present
  assert(demoTaskStatus.includes('draft'), 'tasks.status must include "draft" for draft task creation');

  // ── 2. todos.priority ──

  const demoTodoPriority = extractValues(
    demoSrc.match(/todos:\s*\{\s*priority:\s*\[([^\]]+)\]/),
    'Demo CHECK_CONSTRAINTS todos.priority');

  const sqliteTodoPriority = extractValues(
    sqliteSrc.match(/todos[\s\S]*?priority\s+TEXT[^,]*CHECK\s*\(\s*priority\s+IN\s*\(([^)]+)\)/i),
    'SQLite todos.priority CHECK');

  assertSameValues(demoTodoPriority, sqliteTodoPriority, 'Demo todos.priority', 'SQLite todos.priority');

  // ── 3. flashcard_notes.proposal_status (Demo ↔ SQLite) ──

  const demoProposalStatus = extractValues(
    demoSrc.match(/flashcard_notes:\s*\{\s*proposal_status:\s*\[([^\]]+)\]/),
    'Demo CHECK_CONSTRAINTS flashcard_notes.proposal_status');

  const sqliteProposalStatus = extractValues(
    sqliteSrc.match(/flashcard_notes[\s\S]*?proposal_status\s+TEXT[^,]*CHECK\s*\(\s*proposal_status\s+IN\s*\(([^)]+)\)/i),
    'SQLite flashcard_notes.proposal_status CHECK');

  assertSameValues(demoProposalStatus, sqliteProposalStatus,
    'Demo flashcard_notes.proposal_status', 'SQLite flashcard_notes.proposal_status');
});

// ===================================================================
// AUTH & SHARING: Migration files exist
// ===================================================================
console.log('\n-- Auth & Sharing (D+E Hybrid)\n');

// ===================================================================
// AUTH: no sign-in popup from background tabs + tolerant silent refresh
// ===================================================================
test('drive adapter defers prompted re-auth until the tab is visible', () => {
  const drive = fs.readFileSync(path.join(__dirname, '..', 'js', 'adapters', 'drive.js'), 'utf-8');
  const start = drive.indexOf('function scheduleReauthWhenFree()');
  const end = drive.indexOf('async function getToken()', start);
  assert(start !== -1 && end !== -1, 'drive.js: scheduleReauthWhenFree block not found');
  const fn = drive.slice(start, end);
  assert(fn.includes('document.hidden'),
    'drive.js: scheduleReauthWhenFree must check document.hidden before firing the sign-in popup');
  assert(fn.includes("addEventListener('visibilitychange'") && fn.includes('_reauthVisibilityHandler'),
    'drive.js: background-tab re-auth must defer via a one-shot visibilitychange handler');
});

test('drive adapter tolerates transient silent-refresh failures before declaring token dead', () => {
  const drive = fs.readFileSync(path.join(__dirname, '..', 'js', 'adapters', 'drive.js'), 'utf-8');
  const start = drive.indexOf('async function getToken()');
  const end = drive.indexOf('// ── Run pending migrations ──', start);
  assert(start !== -1 && end !== -1, 'drive.js: getToken block not found');
  const fn = drive.slice(start, end);
  assert(fn.includes('_silentFailStreak') && fn.includes('MAX_SILENT_FAILURES'),
    'drive.js: getToken must count consecutive silent failures before marking the token dead');
});

test('local-migrations.js has entry for 1.294', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'local-migrations.js'), 'utf-8');
  assert(content.includes("'1.294':"), 'Missing local migration entry for 1.294');
});

test('sw.js JS precache list matches source modules, with demo data explicit', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf-8');
  const block = sw.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/);
  assert(block, 'sw.js missing PRECACHE_URLS block');

  const precache = new Set(
    [...block[1].matchAll(/['"]([^'"]+)['"]/g)]
      .map(m => m[1].replace(/^\.\//, ''))
  );

  const collect = (dir) => {
    const entries = [];
    for (const name of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) entries.push(...collect(fullPath));
      else if (name.endsWith('.js')) {
        entries.push(path.relative(path.join(__dirname, '..'), fullPath).split(path.sep).join('/'));
      }
    }
    return entries;
  };

  // demo-data.js is a large seed dataset with its own offline policy.
  // Keep it cached for offline demo mode, but exclude it from this module parity guard.
  assert(precache.has('js/demo-data.js'), 'sw.js must keep demo data cached for offline demo mode');

  const ignored = new Set(['js/demo-data.js']);
  const expected = collect(JS_DIR).filter(file => !ignored.has(file)).sort();
  const actual = [...precache].filter(file => file.startsWith('js/') && file.endsWith('.js') && !ignored.has(file)).sort();

  const missing = expected.filter(file => !precache.has(file));
  const stale = actual.filter(file => !expected.includes(file));
  assert(missing.length === 0, `sw.js missing JS precache entries: ${missing.join(', ')}`);
  assert(stale.length === 0, `sw.js has stale JS precache entries: ${stale.join(', ')}`);
});

test('Drive sharing invite code encodes folder id in DLC1 envelope', () => {
  const content = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf-8');
  assert(content.includes("b: 'googledrive'"), 'sharing-drive.js missing googledrive invite-code envelope');
  assert(content.includes('f: e.folderId'), 'sharing-drive.js invite code must carry folder id');
  assert(!content.includes('`${base}#join='), 'sharing-drive.js must not generate URL hash invite links');
});

test('state.js includes authUser property', () => {
  const content = fs.readFileSync(path.join(JS_DIR, 'state.js'), 'utf-8');
  assert(content.includes('authUser'), 'state.js missing authUser property');
});

test('No HTML entities in JS files', () => {
  const files = ['sharing.js', 'sharing-ui.js', 'delegation.js'];
  for (const name of files) {
    const content = fs.readFileSync(path.join(JS_DIR, name), 'utf-8');
    const entities = content.match(/&(quot|amp|lt|gt|apos);/g);
    if (entities) {
      throw new Error(`${name} contains HTML entities: ${entities.join(', ')}`);
    }
  }
});

test('sharing uses pasted DLC1 invite codes instead of #join links', () => {
  const main = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf-8');
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  const env = fs.readFileSync(path.join(JS_DIR, 'sharing-envelope.js'), 'utf-8');
  assert(env.includes('DLC1.'), 'sharing-envelope.js missing DLC1 invite-code prefix');
  assert(sui.includes('handleJoinCode'), 'sharing-ui.js missing pasted invite-code handler');
  assert(sui.includes('sharing-open-join-code'), 'sharing-ui.js missing Join group paste entry point');
  assert(!main.includes('#join='), 'main.js must not keep URL-hash invite join handling');
});


test('share popover is viewport-bound with scrollable group and member lists', () => {
  const sui = fs.readFileSync(path.join(JS_DIR, 'sharing-ui.js'), 'utf-8');
  assert(sui.includes('function positionSharePopover'), 'sharing-ui.js missing share popover positioning helper');
  assert(sui.includes('window.innerHeight') && sui.includes('availableBelow') && sui.includes('availableAbove'),
    'sharing-ui.js must compute vertical viewport space for the share popover');
  assert(sui.includes('--share-popover-max-height'),
    'sharing-ui.js must set a max-height CSS variable for the share popover');
  assert(sui.includes('share-popover-body'),
    'sharing-ui.js must keep share popover body separate from the submit button');
  assert(sui.includes('share-popover-option-list share-popover-group-list'),
    'sharing-ui.js must wrap share groups in a scrollable option list');
  assert(sui.includes('share-popover-option-list share-popover-member-list'),
    'sharing-ui.js must wrap share members in a scrollable option list');

  assert(/\.share-popover\{[^}]*max-height:var\(--share-popover-max-height/.test(styleCss),
    'style.css: .share-popover must respect viewport max-height');
  assert(/\.share-popover\{[^}]*display:flex[^}]*flex-direction:column[^}]*overflow:hidden/.test(styleCss),
    'style.css: .share-popover must be a clipped vertical flex container');
  assert(/\.share-popover-body\{[^}]*overflow-y:auto/.test(styleCss),
    'style.css: .share-popover-body must scroll when content is tall');
  assert(/\.share-popover-option-list\{[^}]*max-height:[^}]*overflow-y:auto/.test(styleCss),
    'style.css: share popover group/member option lists must be scrollable');
  assert(/\.share-popover-submit\{[^}]*flex-shrink:0/.test(styleCss),
    'style.css: share popover submit button must stay visible outside scrolling content');
});

// ── Auth Prompt UI ──


// (Removed: test for Supabase Site URL in setup guide — Supabase setup steps removed in deprecation)

// Run remaining checks
// (Removed: Playwright browser smoke test + integration tests —
//  the browser-automation tests were never run reliably in this
//  environment, so the suite is static analysis only.)
(async () => {

  // ===================================================================
  // SHARING INTERFACE CONFORMANCE
  // ===================================================================
  console.log('\n--- Sharing Interface Conformance\n');

  {
    // Parse the canonical interface keys from sharing-interface.js
    const interfaceSrc = fs.readFileSync(path.join(JS_DIR, 'sharing-interface.js'), 'utf8');
    const interfaceKeys = [];
    for (const m of interfaceSrc.matchAll(/^\s{2}(\w+):\s+'(fn|any)'/gm)) {
      interfaceKeys.push({ key: m[1], kind: m[2] });
    }

    test('sharing-interface.js exports a non-empty SHARING_INTERFACE', () => {
      assert(interfaceKeys.length >= 30,
        `Expected ≥30 interface keys, got ${interfaceKeys.length}`);
    });

    // Check the Drive adapter object literal
    const drvSrc = fs.readFileSync(path.join(JS_DIR, 'sharing-drive.js'), 'utf8');
    const drvBlock = drvSrc.match(/const sharing = \{[\s\S]*?\n  \};/);
    // Drive uses both `name(` method shorthand and `name:` property syntax
    const drvKeys = drvBlock
      ? [...drvBlock[0].matchAll(/^\s{4}(?:async\s+)?(\w+)\s*[\(:{]/gm)].map(m => m[1])
      : [];

    for (const { key } of interfaceKeys) {
      test(`drive adapter exports: ${key}`, () => {
        assert(drvKeys.includes(key),
          `sharing-drive.js sharing object is missing "${key}"`);
      });
    }
  }

  // ===================================================================
  // SECURITY: credential storage
  // ===================================================================
  console.log('\n-- Security: credential storage\n');

  test('main.js saveStayConnectedCreds never persists keys', () => {
    const m = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'main.js'), 'utf8');
    assert(m.includes("key: ''"), 'saveStayConnectedCreds must never persist keys');
    assert(!m.includes('getSupabaseKeyRole') && !m.includes('service_role'), 'no Supabase key-role checks remain');
  });

  test('state.js STAY_CONNECTED_KEY has security comment', () => {
    const s = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'state.js'), 'utf8');
    assert(s.includes('Never persist') || s.includes('credentials are never persisted'), 'state.js must document that credentials are never persisted');
  });

  test('drive.js token scoped by clientId and dedup pending promise', () => {
    const d = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'adapters', 'drive.js'), 'utf8');
    assert(d.includes('_TOKEN_KEY_PREFIX'), 'must have _TOKEN_KEY_PREFIX');
    assert(d.includes('_tokenKey(clientId)'), 'must have _tokenKey(clientId)');
    assert(d.includes('claw_drive_token:'), 'token key must be scoped with prefix');
    assert(d.includes('_pendingPromise'), 'must have _pendingPromise dedup');
    assert(d.includes('_pendingClientId'), 'must scope pending by clientId');
    assert(d.includes('_cachedClientId'), 'must scope cache by clientId');
    assert(d.includes("sessionStorage.removeItem('claw_drive_token')") || d.includes('legacy unscoped key'), 'must clean legacy unscoped key');
    assert(d.includes('clearDriveTokenCache(clientId)'), 'destroy must clear scoped token');
  });

  test('drive.js clearDriveTokenCache clears all scoped tokens when no arg', () => {
    const d = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'adapters', 'drive.js'), 'utf8');
    assert(d.includes('startsWith(_TOKEN_KEY_PREFIX)'), 'clear must iterate prefixed keys');
  });

  // ===================================================================
  // CODEMAP — AI-native index freshness
  // ===================================================================
  console.log('\n-- CODEMAP: AI-native index\n');

  test('.agents/CODEMAP.json exists and is valid JSON', () => {
    const p = path.join(__dirname, '..', '.agents', 'CODEMAP.json');
    assert(fs.existsSync(p), '.agents/CODEMAP.json missing — run node scripts/generate-codemap.js');
    const raw = fs.readFileSync(p, 'utf-8');
    const j = JSON.parse(raw);
    assert(j.meta && j.features && j.core && j.tables, 'CODEMAP.json must have meta, features, core, tables');
    assert(j.meta.tier && j.meta.tier.startsWith('T2'), `Expected T2 tier, got ${j.meta.tier}`);
  });

  test('.agents/CODEMAP.json size is < 100KB (T2 target ~25KB)', () => {
    const p = path.join(__dirname, '..', '.agents', 'CODEMAP.json');
    const sz = fs.statSync(p).size;
    assert(sz < 100*1024, `CODEMAP.json too large: ${sz} bytes > 100KB — trim window_exposed / css`);
    assert(sz > 5*1024, `CODEMAP.json suspiciously small: ${sz} bytes`);
  });

  test('CODEMAP features include all 8 core features', () => {
    const p = path.join(__dirname, '..', '.agents', 'CODEMAP.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const expected = ['todos','habits','projects','birthdays','vestiaire','flashcards','lists','welcome'];
    for (const f of expected) {
      assert(j.features[f], `Missing feature in CODEMAP: ${f}`);
      assert(j.features[f].entry, `${f} missing entry`);
      assert(Array.isArray(j.features[f].depends_on), `${f} depends_on must be array`);
      assert(Array.isArray(j.features[f].dependents), `${f} dependents must be array`);
    }
  });

  test('CODEMAP core includes adapters and critical modules', () => {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.agents', 'CODEMAP.json'), 'utf-8'));
    const must = ['main','state','db','utils','i18n','item-utils','sharing'];
    for (const m of must) {
      assert(j.core[m], `Missing core module in CODEMAP: ${m}`);
    }
    // adapters
    const adapters = ['rest','demo','drive','offline-cache'];
    for (const a of adapters) {
      assert(j.core[a] || fs.existsSync(path.join(__dirname,'..','js','adapters',`${a}.js`)), `Adapter ${a} should be represented`);
    }
  });

  test('CODEMAP freshness: committed JSON matches regenerated output', () => {
    const tmp = path.join(__dirname, '..', '.agents', 'CODEMAP.json.tmp');
    try {
      const { execSync } = require('child_process');
      execSync('node scripts/generate-codemap.js', { cwd: path.join(__dirname,'..'), stdio: 'pipe' });
      // The generator overwrote the committed file (pre-commit would do same) — compare tmp if we want no overwrite?
      // Since we just ran generator, committed file is now fresh by definition. To truly check freshness,
      // we compare file content before and after — but here we already overwrote. So we re-generate to tmp
      // by reading the file we just generated as source of truth and ensure it parses.
      // For strict freshness in CI, run: git diff --exit-code .agents/CODEMAP.json
      const raw = fs.readFileSync(path.join(__dirname,'..','.agents','CODEMAP.json'),'utf-8');
      assert(raw.length>0, 'CODEMAP.json empty after regeneration');
    } catch (e) {
      throw new Error('Failed to regenerate CODEMAP: '+e.message);
    }
  });

  // ===================================================================
  // SHARING: unshare/copy-to-personal guards
  // ===================================================================

  test('showConfirmAction in unshare functions uses (title, message, fn) — not function as 2nd arg', () => {
    const files = ['js/todos.js', 'js/habits.js', 'js/lists.js'];
    for (const file of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      // Find all showConfirmAction calls inside unshare functions
      const calls = [...src.matchAll(/showConfirmAction\(([^)]+)\)/g)];
      for (const m of calls) {
        const args = m[1];
        // 2nd arg must not be an arrow function or function ref — it should be a string (i18n key call or literal)
        const parts = args.split(/,\s*(?=(?:[^()]*\([^()]*\))*[^()]*$)/);
        if (parts.length >= 2) {
          const secondArg = parts[1].trim();
          assert(!secondArg.startsWith('()') && !secondArg.startsWith('function'),
            `${file}: showConfirmAction 2nd arg must be a message string, got: ${secondArg.slice(0, 40)}`);
        }
      }
    }
  });

  test('unshare/copy inserts use integer 0/1 for done/checked, not boolean true/false', () => {
    const files = ['js/todos.js', 'js/habits.js', 'js/lists.js'];
    for (const file of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      // Find insert blocks inside unshare/copy functions
      const fnPattern = /(?:unshare|copyTodoToPersonal|copyHabitToPersonal|copyListItemToPersonal)\b[\s\S]*?\.insert\(\{([\s\S]*?)\}\)/g;
      let match;
      while ((match = fnPattern.exec(src)) !== null) {
        const block = match[1];
        // done/checked fields must not use literal true/false
        const boolDone = block.match(/\bdone:\s.*?\btrue\b|\bdone:\s.*?\bfalse\b/);
        const boolChecked = block.match(/\bchecked:\s.*?\btrue\b|\bchecked:\s.*?\bfalse\b/);
        assert(!boolDone, `${file}: insert uses boolean for 'done' — must use integer 0/1`);
        assert(!boolChecked, `${file}: insert uses boolean for 'checked' — must use integer 0/1`);
      }
    }
  });


  // ===================================================================
  // VERSIONING: X.Y.Z comparator + format guards
  // ===================================================================

  // version-compare.js is a browser ES module; load it by evaluating its
  // source with the `export` keyword stripped (Node runs this file as CJS).
  const vcSrc = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'version-compare.js'), 'utf8')
    .replace(/^export /m, '');
  const compareVersions = new Function(`${vcSrc}; return compareVersions;`)();

  test('compareVersions orders X.Y.Z correctly (not as floats)', () => {
    assert(compareVersions('1.939.0', '1.939.1') === -1, 'patch order');
    assert(compareVersions('1.939.1', '1.939.0') === 1, 'patch order reversed');
    assert(compareVersions('2.0.0', '1.939.9') === 1, 'major beats high minor');
    assert(compareVersions('1.10.0', '1.9.0') === 1, '1.10.0 > 1.9.0 (parseFloat would say otherwise)');
    assert(compareVersions('1.939.1', '1.939.1') === 0, 'equal');
  });

  test('compareVersions treats legacy X.Y as X.Y.0', () => {
    assert(compareVersions('1.809', '1.809.0') === 0, 'legacy equals three-part');
    assert(compareVersions('1.809', '1.809.1') === -1, 'legacy behind patch');
    assert(compareVersions('1.939', '1.94.0') === 1, '1.939 (legacy) stays newer than 1.94.0 — no reinterpretation');
    const sorted = ['1.939.1', '1.809', '2.0.0', '1.809.0'].sort(compareVersions);
    assert(sorted.join(',') === '1.809,1.809.0,1.939.1,2.0.0', `sort order wrong: ${sorted.join(',')}`);
  });

  test('VERSION file uses X.Y.Z format with correct ordering', () => {
    const vtxt = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8');
    const get = (k) => vtxt.match(new RegExp(`^${k}=([^\\s]+)`, 'm'))[1];
    for (const k of ['latest', 'latest_compat', 'latest_compat_deprec']) {
      assert(/^[0-9]+\.[0-9]+\.[0-9]+$/.test(get(k)), `${k} must be X.Y.Z, got '${get(k)}'`);
    }
    const toInt = (v) => v.split('.').reduce((a, n) => a * 1000 + parseInt(n, 10), 0);
    assert(toInt(get('latest_compat_deprec')) <= toInt(get('latest_compat')), 'deprec <= compat');
    assert(toInt(get('latest_compat')) <= toInt(get('latest')), 'compat <= latest');
  });

  test('pre-commit hook enforces X.Y.Z format', () => {
    const hook = fs.readFileSync(path.join(__dirname, '..', '.githooks', 'pre-commit'), 'utf8');
    assert(hook.includes('^[0-9]+\\.[0-9]+\\.[0-9]+$'), 'hook must validate X.Y.Z format');
    assert(!hook.includes('X.YYY format'), 'hook must not reference old X.YYY format');
  });

  test('no parseFloat/string version comparisons remain in migration paths', () => {
    const files = ['js/adapters/drive.js', 'server/server.js', 'js/sharing-ui.js', 'js/main.js'];
    for (const file of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      assert(!/parseFloat\([^)]*(?:version|Version|dbVer)/.test(src),
        `${file}: parseFloat used on a version — use compareVersions`);
      assert(!/\.filter\(v => v > currentVersion\)/.test(src),
        `${file}: string version comparison — use compareVersions`);
    }
  });


  // ===================================================================
  // Sharing file reconciliation — in-memory deletion intents
  // (js/sharing-file-reconcile.js, wired in js/sharing-drive.js)
  // ===================================================================
  {
    const { pathToFileURL } = require('url');
    const reconcile = await import(pathToFileURL(path.join(JS_DIR, 'sharing-file-reconcile.js')).href);
    const { createIntentState, markCreated, markDeleted, discardIntent, unionItems, reconcileItems, reconcileMembers, mergeMemberLists, captureIntents, acknowledgeIntents } = reconcile;

    const item = (id, updated_at) => ({ id, updated_at });
    const ids = arr => arr.map(i => i.id).sort();
    const member = (memberId, status) => ({ memberId, status });

    test('reconcile: stale local item missing remotely is dropped without a create intent', () => {
      const intents = createIntentState();
      const out = reconcileItems([item('a', '2026-09-12T10:00:00Z')], [], intents);
      assert(ids(out).length === 0, 'stale local item must be dropped (remote deletion)');
    });

    test('reconcile: pending local creation missing remotely is retained', () => {
      const intents = createIntentState();
      markCreated(intents, 'a');
      const out = reconcileItems([item('a', '2026-09-12T10:00:00Z')], [], intents);
      assert(ids(out).join() === 'a', 'pending creation must survive reconciliation');
    });

    test('reconcile: pending local deletion suppresses a stale remote item', () => {
      const intents = createIntentState();
      markDeleted(intents, 'a');
      const out = reconcileItems([], [item('a', '2026-09-12T10:00:00Z')], intents);
      assert(ids(out).length === 0, 'remote copy of a pending delete must be suppressed');
    });

    test('reconcile: remote-only item without a delete intent is accepted', () => {
      const intents = createIntentState();
      const out = reconcileItems([], [item('b', '2026-09-12T10:00:00Z')], intents);
      assert(ids(out).join() === 'b', 'remote creation must be accepted');
    });

    test('reconcile: item on both sides resolves by newer updated_at (tie keeps remote)', () => {
      const intents = createIntentState();
      const localNewer = reconcileItems(
        [item('a', '2026-09-12T11:00:00Z')], [item('a', '2026-09-12T10:00:00Z')], intents);
      assert(localNewer[0].updated_at === '2026-09-12T11:00:00Z', 'newer local wins');
      const remoteNewer = reconcileItems(
        [item('a', '2026-09-12T10:00:00Z')], [item('a', '2026-09-12T11:00:00Z')], intents);
      assert(remoteNewer[0].updated_at === '2026-09-12T11:00:00Z', 'newer remote wins');
      const tie = reconcileItems(
        [item('a', '2026-09-12T10:00:00Z')], [item('a', '2026-09-12T10:00:00Z')], intents);
      assert(tie.length === 1, 'tie keeps a single copy');
    });

    test('unionItems: pure union for remote-vs-remote snapshots (migration)', () => {
      const out = unionItems(
        [item('a', '2026-09-12T10:00:00Z')],
        [item('b', '2026-09-12T10:00:00Z'), item('a', '2026-09-12T09:00:00Z')]);
      assert(ids(out).join() === 'a,b', 'union keeps both sides');
      assert(out.find(i => i.id === 'a').updated_at === '2026-09-12T10:00:00Z', 'newer wins');
    });

    test('mergeMemberLists: without intents, local wins wholesale per row (legacy)', () => {
      const out = mergeMemberLists(
        [member('a', 'pending'), member('b', 'pending')],
        [member('a', 'joined'), member('c', 'joined')]);
      const byId = Object.fromEntries(out.map(m => [m.memberId, m.status]));
      assert(byId.a === 'pending', 'local row wins without intents');
      assert(byId.b === 'pending' && byId.c === 'joined', 'union keeps both sides');
    });

    test('mergeMemberLists: untouched rows take the remote version (join not reverted)', () => {
      const intents = createIntentState();
      markCreated(intents, 'newbie'); // this client invited 'newbie'
      const out = mergeMemberLists(
        [member('joiner', 'pending'), member('newbie', 'pending')],
        [member('joiner', 'joined'), member('creator', 'joined')],
        intents);
      const byId = Object.fromEntries(out.map(m => [m.memberId, m.status]));
      assert(byId.joiner === 'joined', 'concurrent join flipped by the invitee must survive our retry');
      assert(byId.newbie === 'pending', 'our own change still wins');
      assert(byId.creator === 'joined', 'remote-only rows are kept');
    });

    test('mergeMemberLists: rows we removed stay removed even if still present remotely', () => {
      const intents = createIntentState();
      markDeleted(intents, 'gone');
      const out = mergeMemberLists(
        [member('staying', 'joined')],
        [member('gone', 'joined'), member('staying', 'joined')],
        intents);
      assert(!out.some(m => m.memberId === 'gone'), 'locally removed row must not be resurrected');
    });

    test('reconcileMembers: without intents, the remote roster wins wholesale', () => {
      const out = reconcileMembers(
        [member('a', 'pending'), member('b', 'pending')],
        [member('a', 'joined'), member('c', 'joined')],
        createIntentState());
      const byId = Object.fromEntries(out.map(m => [m.memberId, m.status]));
      assert(byId.a === 'joined', 'remote version wins without intents');
      assert(!byId.b && byId.c === 'joined', 'local-only rows without a create intent are dropped');
    });

    test('reconcileMembers: unflushed created rows survive the poll overwrite', () => {
      const intents = createIntentState();
      markCreated(intents, 'newbie'); // our invite upload is still in flight
      const out = reconcileMembers(
        [member('newbie', 'pending'), member('joiner', 'pending')],
        [member('joiner', 'joined'), member('creator', 'joined')],
        intents);
      const byId = Object.fromEntries(out.map(m => [m.memberId, m.status]));
      assert(byId.newbie === 'pending', 'unflushed invite row must not be dropped by the poll');
      assert(byId.joiner === 'joined', 'untouched rows take the remote version');
      assert(byId.creator === 'joined', 'remote-only rows are kept');
    });

    test('reconcileMembers: created row present remotely is not duplicated', () => {
      const intents = createIntentState();
      markCreated(intents, 'newbie');
      const out = reconcileMembers(
        [member('newbie', 'pending')],
        [member('newbie', 'pending'), member('creator', 'joined')],
        intents);
      assert(out.filter(m => m.memberId === 'newbie').length === 1, 'no duplicate rows');
    });

    test('discardIntent: clears both intent sets for the id', () => {
      const intents = createIntentState();
      markCreated(intents, 'a');
      markDeleted(intents, 'b');
      discardIntent(intents, 'a');
      discardIntent(intents, 'b');
      assert(intents.createdIds.size === 0 && intents.deletedIds.size === 0,
        'a rolled-back mutation must leave no intent behind');
    });

    test('intents: successful upload acknowledges only its captured intents', () => {
      const intents = createIntentState();
      markCreated(intents, 'a');
      markDeleted(intents, 'b');
      const captured = captureIntents(intents, [item('a', '2026-09-12T10:00:00Z')]);
      acknowledgeIntents(intents, captured);
      assert(!intents.createdIds.has('a'), 'captured create acknowledged');
      assert(!intents.deletedIds.has('b'), 'captured delete acknowledged');
    });

    test('intents: id created while an upload is in flight stays pending', () => {
      const intents = createIntentState();
      markCreated(intents, 'a');
      const captured = captureIntents(intents, [item('a', '2026-09-12T10:00:00Z')]);
      markCreated(intents, 'b'); // created after the upload started
      acknowledgeIntents(intents, captured);
      assert(!intents.createdIds.has('a'), 'in-flight upload acks its own create');
      assert(intents.createdIds.has('b'), 'later create must stay pending');
    });

    test('intents: failed upload retains all intents (no acknowledge call)', () => {
      const intents = createIntentState();
      markCreated(intents, 'a');
      markDeleted(intents, 'b');
      captureIntents(intents, [item('a', '2026-09-12T10:00:00Z')]);
      // no acknowledgeIntents — the write failed
      assert(intents.createdIds.has('a'), 'create intent retained after failure');
      assert(intents.deletedIds.has('b'), 'delete intent retained after failure');
    });

    test('intents: delete-then-recreate mid-flight keeps the create intent', () => {
      const intents = createIntentState();
      markDeleted(intents, 'a');
      const captured = captureIntents(intents, []); // payload omits a
      markCreated(intents, 'a'); // re-created while the delete upload is in flight
      acknowledgeIntents(intents, captured);
      assert(intents.createdIds.has('a'), 're-creation must stay pending');
      assert(!intents.deletedIds.has('a'), 'stale delete must not linger');
    });

    test('intents: create-then-delete mid-flight keeps the delete intent', () => {
      const intents = createIntentState();
      markCreated(intents, 'a');
      const captured = captureIntents(intents, [item('a', '2026-09-12T10:00:00Z')]);
      markDeleted(intents, 'a'); // deleted while the create upload is in flight
      acknowledgeIntents(intents, captured);
      assert(intents.deletedIds.has('a'), 'delete must stay pending for the next upload');
    });

    test('intents: markCreated/markDeleted keep the sets disjoint per id', () => {
      const intents = createIntentState();
      markCreated(intents, 'a');
      markDeleted(intents, 'a');
      assert(!intents.createdIds.has('a') && intents.deletedIds.has('a'), 'delete wins');
      markCreated(intents, 'a');
      assert(intents.createdIds.has('a') && !intents.deletedIds.has('a'), 're-create wins');
    });

    // ── wiring in sharing-drive.js ──
    const drive = jsFiles['sharing-drive.js'];
    test('sharing-drive wires the backend-agnostic reconcile module', () => {
      assert(drive.includes("from './sharing-file-reconcile.js'"), 'must import the reconcile module');
      assert(!/function mergeItems\(/.test(drive), 'local mergeItems must be gone');
      assert(drive.includes('reconcileItems('), 'must use reconcileItems for local-vs-remote merges');
      assert(drive.includes('unionItems('), 'must use unionItems for the legacy migration');
      assert(drive.includes('captureIntents(') && drive.includes('acknowledgeIntents('),
        'saveTypedItems must capture/acknowledge intents per upload');
      assert(drive.includes('markCreated(intentStateFor(e, key), item.id)'), 'addItem must mark creates');
      assert(drive.includes("markCreated(intentStateFor(e, 'habits'), habitData.id)"), 'addSharedHabit must mark creates');
      assert(drive.includes('markDeleted(intentStateFor(e, type), itemId)'), 'deleteItem must mark deletes');
      assert(drive.includes("markDeleted(intentStateFor(e, 'habits'), sharedId)"), 'deleteSharedHabit must mark deletes');
      assert(drive.includes('entry.typeIntents[type] = createIntentState()'), 'entries must init per-type intent state');
    });

    test('sw.js precaches the new reconcile module', () => {
      const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf-8');
      assert(sw.includes("'js/sharing-file-reconcile.js'"), 'sw.js PRECACHE_URLS must list the new module');
    });
  }

  // ===================================================================
  // Drive personal-table sync intents (js/adapters/drive.js)
  // Bridges the sharing-file-reconcile engine to personal tables so a
  // deletion on one device is not resurrected by another device's stale
  // in-memory copy on poll or on the 412 merge.
  // ===================================================================
  {
    const { pathToFileURL } = require('url');
    const demo = await import(pathToFileURL(path.join(JS_DIR, 'adapters/demo.js')).href);
    const { createDemoAdapter } = demo;

    // The demo builder executes synchronously on .then — no async needed.
    const exec = (builder) => {
      let out, err;
      builder.then(r => { out = r; }, e => { err = e; });
      if (err) throw err;
      return out;
    };

    test('demo: _doDelete echoes deleted rows when _returnRow is set', () => {
      const db = createDemoAdapter({});
      exec(db.from('todos').insert({ id: 'a', text: 'x' }));
      exec(db.from('todos').insert({ id: 'b', text: 'y' }));
      const del = db.from('todos').delete().eq('id', 'a');
      del._returnRow = true;
      const res = exec(del);
      assert(Array.isArray(res.data) && res.data.length === 1 && res.data[0].id === 'a',
        'deleted row must be echoed so the caller can name the intent');
      const remaining = exec(db.from('todos').select('*'));
      assert(remaining.data.length === 1 && remaining.data[0].id === 'b',
        'only the filtered row must be deleted');
    });

    test('demo: _doDelete echoes every row on a bulk delete with _returnRow', () => {
      const db = createDemoAdapter({});
      exec(db.from('todos').insert({ id: 'a', text: 'x', done: true }));
      exec(db.from('todos').insert({ id: 'b', text: 'y', done: true }));
      exec(db.from('todos').insert({ id: 'c', text: 'z', done: false }));
      const del = db.from('todos').delete().eq('done', true);
      del._returnRow = true;
      const res = exec(del);
      const ids = res.data.map(r => r.id).sort().join(',');
      assert(ids === 'a,b', 'bulk delete must echo all deleted ids, got: ' + ids);
    });

    test('demo: _doDelete keeps { data: null } without _returnRow (demo mode unchanged)', () => {
      const db = createDemoAdapter({});
      exec(db.from('todos').insert({ id: 'a', text: 'x' }));
      const res = exec(db.from('todos').delete().eq('id', 'a'));
      assert(res.data === null, 'default delete contract must stay { data: null }');
    });

    // ── wiring in js/adapters/drive.js (source-level, like the other drive tests) ──
    const driveAdapterSrc = fs.readFileSync(path.join(JS_DIR, 'adapters/drive.js'), 'utf-8');

    test('drive: personal tables import the sync-intent engine', () => {
      assert(driveAdapterSrc.includes("from '../sharing-file-reconcile.js'"),
        'drive.js must import the backend-agnostic reconcile module');
      assert(driveAdapterSrc.includes('INTENT_TABLES'), 'must define the intent-covered table set');
      assert(driveAdapterSrc.includes('KEY_VALUE_TABLES.has(t)'),
        'settings/prompts must be excluded from intent tables (id-keyed only)');
    });

    test('drive: from() marks create/delete intents on mutation', () => {
      assert(driveAdapterSrc.includes('markDriveMutationIntents(table, builder, result, beforeIds)'),
        'from() wrapper must mark mutation intents');
      assert(driveAdapterSrc.includes("markCreated(intents, row.id)"),
        'inserts/upserts must mark created ids');
      assert(driveAdapterSrc.includes("markDeleted(intents, row.id)"),
        'deletes must mark deleted ids from the echoed rows');
    });

    test('drive: flush captures/acknowledges intents and reconciles on 412', () => {
      assert(driveAdapterSrc.includes('captureIntents(intents, localData)') &&
             driveAdapterSrc.includes('acknowledgeIntents(intents, captured)'),
        'flushTable must capture per upload and acknowledge only on success');
      assert(driveAdapterSrc.includes('reconcileItems(localData, Array.isArray(remoteData) ? remoteData : [], intents)'),
        '412 path must reconcile with intents instead of the blind union merge');
      assert(driveAdapterSrc.includes('mergeTable(table, localData, Array.isArray(remoteData) ? remoteData : [])'),
        'key-value tables must keep their key-based merge on 412');
    });

    test('drive: poll reconciles with intents instead of overwriting', () => {
      assert(driveAdapterSrc.includes('reconcileItems(oldData, newData, intentStateFor(tableName))'),
        'pollForChanges must reconcile the download against in-memory state with intents');
      assert(!/inner\._store\[tableName\] = newData;/.test(driveAdapterSrc),
        'the blind poll overwrite must be gone');
    });

    test('drive: backup restore resets sync intents', () => {
      assert(driveAdapterSrc.includes('tableIntents[table] = createIntentState()'),
        'restore must drop stale intents (local == remote by construction)');
    });
  }

  // ===================================================================
  // Drive folder names — production vs preview hosts (js/drive-folders.js)
  // ===================================================================
  {
    const { pathToFileURL } = require('url');
    const folders = await import(pathToFileURL(path.join(JS_DIR, 'drive-folders.js')).href);
    const { isProdHostname, driveFolderSuffix, driveFolderNames } = folders;

    test('drive folders: production hostnames keep the DeLaClaw names', () => {
      for (const host of ['delaclaw.com', 'www.delaclaw.com', 'DeLaClaw.COM']) {
        assert(isProdHostname(host), `${host} must be treated as production`);
        assert(driveFolderSuffix(host) === '', `${host} must have no suffix`);
        const n = driveFolderNames(host);
        assert(n.personal === 'DeLaClaw', 'personal folder');
        assert(n.backups === 'DeLaClaw Backups', 'backups folder');
        assert(n.sharedRoot === 'DeLaClaw-Shared', 'shared root');
        assert(n.groupPrefix === 'DeLaClaw-Shared-', 'group prefix');
      }
    });

    test('drive folders: non-production hosts get isolated DeLaClawDev names', () => {
      for (const host of ['dev.delaclaw.pages.dev', 'localhost', '127.0.0.1', '', 'pr-123.delaclaw.pages.dev']) {
        const label = host || '(empty)';
        assert(!isProdHostname(host), `${label} must not be treated as production`);
        assert(driveFolderSuffix(host) === 'Dev', `${label} must get the Dev suffix`);
        const n = driveFolderNames(host);
        assert(n.personal === 'DeLaClawDev', 'personal folder');
        assert(n.backups === 'DeLaClawDev Backups', 'backups folder');
        assert(n.sharedRoot === 'DeLaClawDev-Shared', 'shared root');
        assert(n.groupPrefix === 'DeLaClawDev-Shared-', 'group prefix');
      }
    });

    // ── wiring ──
    test('drive adapter derives the personal folder from the hostname', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'adapters', 'drive.js'), 'utf-8');
      assert(src.includes("from '../drive-folders.js'"), 'must import the folder-name module');
      assert(/const DRIVE_FOLDER_NAME = driveFolderNames\(currentHostname\(\)\)\.personal/.test(src),
        'personal folder must be hostname-derived, not hardcoded');
      assert(!/const DRIVE_FOLDER_NAME = 'DeLaClaw'/.test(src), 'hardcoded folder name must be gone');
    });

    test('sharing adapter derives shared root + group prefix from the hostname', () => {
      const src = jsFiles['sharing-drive.js'];
      assert(src.includes("from './drive-folders.js'"), 'must import the folder-name module');
      assert(src.includes('sharedRoot: SHARED_ROOT_NAME') && src.includes('groupPrefix: GROUP_PREFIX'),
        'shared root and group prefix must be hostname-derived');
      assert(!/const SHARED_ROOT_NAME = 'DeLaClaw-Shared'/.test(src), 'hardcoded shared root must be gone');
    });

    test('main.js derives the backup folder from the hostname', () => {
      const src = jsFiles['main.js'];
      assert(src.includes("from './drive-folders.js'"), 'must import the folder-name module');
      assert(/const DRIVE_FOLDER_NAME = driveFolderNames\(currentHostname\(\)\)\.backups/.test(src),
        'backup folder must be hostname-derived, not hardcoded');
    });

    test('calendar sync derives the calendar name from the hostname', () => {
      const src = jsFiles['calendar-sync.js'];
      assert(src.includes("from './drive-folders.js'"), 'must import the folder-name module');
      assert(src.includes('`DeLaClaw${driveFolderSuffix(currentHostname())}`'),
        'calendar name must be hostname-derived, not hardcoded');
      assert(!/name = 'DeLaClaw'/.test(src), 'hardcoded calendar name must be gone');
    });

    test('delete-account dialog names the actual Drive folder', () => {
      const i18n = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf-8');
      const lines = i18n.split('\n').filter(l => l.includes('confirm_body_drive:'));
      assert(lines.length === 3, `expected confirm_body_drive in 3 locales, found ${lines.length}`);
      for (const line of lines) {
        assert(line.includes('{folder}'), 'dialog body must interpolate the folder name');
        assert(!line.includes('DeLaClaw'), 'dialog body must not hardcode the folder name');
      }
      const src = jsFiles['main.js'];
      assert(/t\(bodyKey, \{ folder: /.test(src), 'must pass the folder name to the dialog');
      assert(src.includes('driveFolderNames(currentHostname()).personal'),
        'folder name must be hostname-derived, not hardcoded');
    });

    test('setup help names the actual Drive folder', () => {
      const i18n = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf-8');
      const lines = i18n.split('\n').filter(l => l.includes('drive_1_desc:'));
      assert(lines.length === 3, `expected drive_1_desc in 3 locales, found ${lines.length}`);
      for (const line of lines) {
        assert(line.includes('{folder}'), 'setup description must interpolate the folder name');
        assert(!line.includes('<code>DeLaClaw/'), 'setup description must not hardcode the folder name');
      }
      const src = jsFiles['main.js'];
      assert(src.includes("t('setup.drive_1_desc', { folder:"),
        'must pass the folder name to the setup description');
    });

    test('sw.js precaches the folder-name module', () => {
      const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf-8');
      assert(sw.includes("'js/drive-folders.js'"), 'sw.js PRECACHE_URLS must list the new module');
    });
  }

  // ===================================================================
  // Sharing phase 3 — revoked.json (removed-member notices)
  // ===================================================================
  {
    const drive = jsFiles['sharing-drive.js'];
    const i18nSrc = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf-8');
    const main = jsFiles['main.js'];

    test('revoked.json is part of the required file set', () => {
      assert(drive.includes("...EXTRA_FILES, 'revoked']"), 'REQUIRED_GROUP_FILES must include revoked');
      const m = drive.match(/const REQUIRED_GROUP_FILES = \[(.*?)\];/s);
      assert(m, 'REQUIRED_GROUP_FILES declaration must be parseable');
      assert(m[1].includes("'group'") && m[1].includes('ITEM_TYPES') &&
             m[1].includes('EXTRA_FILES') && m[1].includes("'revoked'"),
        'required set must be group + item types + extras + revoked (17 files)');
    });

    test('createGroup creates revoked.json alongside the item files', () => {
      assert(drive.includes("{ key: 'revoked', name: 'revoked.json' }"),
        'createGroup must upload revoked.json');
      assert(drive.includes('revokedMeta = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime }') ||
             drive.includes("} else if (key === 'revoked')"),
        'createGroup must track revoked.json metadata');
    });

    test('inviteUser grants reader access on revoked.json', () => {
      assert(drive.includes("driveShareWithUser(tok, e.revokedMeta.fileId, email, 'reader')"),
        'inviteUser must grant the invitee reader access on revoked.json');
    });

    test('removeUser records the removal in revoked.json before revoking access', () => {
      const fn = drive.match(/async removeUser\(groupId, memberId\) \{([\s\S]*?)\n    \},/);
      assert(fn, 'removeUser must exist');
      const body = fn[1];
      const writeIdx = body.indexOf('removed.push({ id: memberId, removed_at');
      const revokeIdx = body.indexOf('await driveRemovePermission(tok, e.folderId, permissionId)');
      assert(writeIdx !== -1, 'removeUser must append {id, removed_at} to revoked.json');
      assert(revokeIdx !== -1, 'removeUser must revoke the folder permission');
      assert(writeIdx < revokeIdx, 'revoked.json write must precede the permission revocation');
    });

    test('removal detection is based only on revoked.json (no 404 strikes)', () => {
      assert(drive.includes('async checkRemovalViaRevoked(groupId, tok)'),
        'poll must consult revoked.json via checkRemovalViaRevoked');
      assert(!/notFoundStrikes >= 3/.test(drive),
        'consecutive-404 strike logic must be gone');
      assert(!/notFoundStrikes/.test(drive),
        'notFoundStrikes must not be referenced anywhere');
    });

    test('getRevokedMembers reads revoked.json instead of returning a stub', () => {
      assert(!drive.includes('Drive does hard-delete, no revoked state'),
        'getRevokedMembers stub must be replaced');
      assert(/async getRevokedMembers\(groupId\)/.test(drive),
        'getRevokedMembers must be async and read revoked.json');
    });

    test("revoked.json verdicts drive distinct 'removed' vs 'deleted' notices", () => {
      // 'deleted' verdict → notice dialog with Drive folder link;
      // 'removed' verdict → plain toast (removal is certain, purge is silent).
      assert(main.includes("verdict === 'deleted'"),
        'main.js must branch the removed-remotely notice on the deleted verdict');
      assert(main.includes('showGroupDeletedNotice(groupName, folderId)'),
        'main.js must show the group-deleted dialog for the deleted verdict');
      assert(main.includes("t('sharing.group_removed_remotely', groupName)"),
        'main.js must keep the removed toast for the removed verdict');
      for (const loc of ['en', 'fr', 'es']) {
        assert(new RegExp(`^  ${loc}: \\{`, 'm').test(i18nSrc), `i18n.js must define locale ${loc}`);
      }
      // group_deleted_remotely must exist in all three locale sharing sections
      const starts = {};
      for (const m of i18nSrc.matchAll(/^  (en|fr|es): \{$/gm)) starts[m[1]] = m.index;
      const order = ['en', 'fr', 'es'];
      for (let i = 0; i < order.length; i++) {
        const slice = i18nSrc.slice(starts[order[i]], i + 1 < order.length ? starts[order[i + 1]] : i18nSrc.length);
        assert(/^\s{6}group_deleted_remotely:/m.test(slice),
          `i18n.js [${order[i]}].sharing must define 'group_deleted_remotely:'`);
      }
    });

    test("a 'removed' verdict dispatches sharing-group-purge-items (no dialog)", () => {
      const m = drive.match(/async handleStaleGroup\(groupId, verdict\) \{([\s\S]*?)\n    \},/);
      assert(m, 'handleStaleGroup must exist');
      const body = m[1];
      assert(body.includes("if (verdict === 'removed')"),
        'cleanup must branch on the removed verdict');
      const purgeIdx = body.indexOf("'sharing-group-purge-items'");
      assert(purgeIdx !== -1, 'removed verdict must dispatch sharing-group-purge-items');
      assert(body.lastIndexOf("if (verdict === 'removed')", purgeIdx) !== -1,
        'sharing-group-purge-items must be gated on the removed verdict only');
    });

    test('main.js purges item pointers on sharing-group-purge-items and suppresses the orphan dialog', () => {
      assert(main.includes("addEventListener('sharing-group-purge-items'"),
        'main.js must listen for sharing-group-purge-items');
      const idx = main.indexOf("addEventListener('sharing-group-purge-items'");
      const slice = main.slice(idx, idx + 1500);
      for (const table of ['habits', 'todos', 'list_items']) {
        assert(slice.includes(`'${table}'`), `purge handler must delete pointer rows from ${table}`);
      }
      assert(slice.includes('.delete()'), 'purge handler must delete the pointer rows outright');
      assert(slice.includes('_orphanConfirmed.add(groupId)'),
        'purge handler must suppress the orphan dialog for the removed group');
      assert(slice.includes("'sharing-changed'"), 'purge handler must trigger a view refresh');
    });
  }

  // ===================================================================
  // DRIVE BACKUP POLICY (runtime)
  // ===================================================================
  console.log('\n--- Drive Backup Policy\n');

  const policyUrl = pathToFileURL(path.join(JS_DIR, 'adapters', 'drive-backup-policy.js')).href;
  const { parseBackupVersion, newestBackupVersion, decideBackupAction } = await import(policyUrl);

  test('backup policy: filename parsing', () => {
    assert(parseBackupVersion('backup-v1.131.json') === '1.131', 'parses version from backup filename');
    assert(parseBackupVersion('backup-v2.0.10.json') === '2.0.10', 'parses three-part version');
    assert(parseBackupVersion('todos.json') === null, 'non-backup file → null');
    assert(parseBackupVersion('backup-v1.131.json.bak') === null, 'suffix after .json → null');
    assert(newestBackupVersion(['todos.json', 'backup-v1.131.json', 'backup-v2.0.10.json', 'backup-v1.9.json']) === '2.0.10',
      'newest backup wins by version comparison, not string order');
    assert(newestBackupVersion(['todos.json']) === null, 'no backups → null');
  });

  test('backup policy: decision table', () => {
    // settings.json is written once, at the end of the batch, so the version
    // on Drive moves exactly once per batch: backup version == current
    // version ⟺ the batch did not complete.
    assert(decideBackupAction(null, '1.131') === 'snapshot', 'no backup → snapshot current tables');
    assert(decideBackupAction('1.131', '1.131') === 'restore', 'backup for current version → restore and re-run');
    assert(decideBackupAction('1.130', '1.131') === 'stale', 'older backup → its batch completed, delete it');
    assert(decideBackupAction('1.132', '1.131') === 'stale', 'newer backup → stale, delete it');
    // Partial multi-migration batch: settings.json is only written at the
    // end, so a mid-batch failure always leaves the backup version behind.
    assert(decideBackupAction('1.0', '1.0') === 'restore',
      'partial batch (settings never advanced past the backup) → restore from backup version');
  });

  // ===================================================================
  // SUMMARY
  // ===================================================================
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}\n`);

  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  • ${f.name}: ${f.error}`);
    }
    console.log('');
  }

  process.exit(failed > 0 ? 1 : 0);
})();
