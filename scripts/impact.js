#!/usr/bin/env node
/**
 * impact.js — AI-native impact analyzer for DeLaClaw
 * Reads staged diff (or worktree) + .agents/CODEMAP.json to suggest
 * the Checked: trailer and blast radius.
 *
 * Usage:
 *   node scripts/impact.js              # full report (worktree)
 *   node scripts/impact.js --staged     # staged files only
 *   node scripts/impact.js --format=checked  # just the Checked: line
 *   node scripts/impact.js --json       # machine-readable
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CODEMAP_PATH = path.join(ROOT, '.agents', 'CODEMAP.json');

function sh(cmd) {
  try { return execSync(cmd, { cwd: ROOT, encoding: 'utf-8' }).trim(); }
  catch { return ''; }
}

function getChangedFiles(staged) {
  const flag = staged ? '--cached' : '';
  const out = sh(`git diff --name-only ${flag} --diff-filter=ACMRT`.trim());
  let files = out.split('\n').filter(Boolean);

  if (!staged) {
    // include unstaged + untracked for pre-push / ad-hoc analysis
    const unstaged = sh('git diff --name-only --diff-filter=ACMRT');
    const untracked = sh('git ls-files --others --exclude-standard');
    files = [...new Set([...files, ...unstaged.split('\n').filter(Boolean), ...untracked.split('\n').filter(Boolean)])];
  }
  // Always deduplicate
  return [...new Set(files)].filter(f => !f.startsWith('.agents/') || f.endsWith('.json') || f.endsWith('.md')); // keep codemap but filter noise later
}

function loadCodemap() {
  try {
    const raw = fs.readFileSync(CODEMAP_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function analyze() {
  const args = process.argv.slice(2);
  const staged = args.includes('--staged');
  const formatChecked = args.includes('--format=checked') || args.includes('--format=trailer');
  const jsonOut = args.includes('--json');

  const changed = getChangedFiles(staged);
  const codemap = loadCodemap();

  // Heuristics
  const touches = (prefix) => changed.some(f => f.startsWith(prefix));
  const touchesFile = (name) => changed.includes(name) || changed.some(f => f.endsWith('/'+name) || f === name);
  const touchesAny = (list) => list.some(p => changed.some(f => f.includes(p)));

  // Get diff content for finer checks
  const diffContent = sh(`git diff ${staged ? '--cached' : ''} --unified=0 -- js/ 2>/dev/null | head -n 5000`);

  const hasI18nChange = touches('js/') && /t\s*\(|i18n/.test(diffContent) || touchesFile('js/i18n.js');
  const hasEscOrInnerHTML = /innerHTML|outerHTML|insertAdjacentHTML|\besc\s*\(/.test(diffContent);
  const hasSchemaChange = touches('migrations/') || touches('sql/') || touchesFile('server/schema.sql') || touches('server/');
  const hasAdapterChange = touches('js/adapters/');

  // Feature detection via codemap
  const changedFeatures = new Set();
  const impactedFeatures = new Set();
  const tablesTouched = new Set();
  const dependentsAll = new Set();

  if (codemap) {
    // Map basename to codemap entry
    const fileToEntry = {};
    [...Object.entries(codemap.features), ...Object.entries(codemap.core)].forEach(([k,v])=>{
      fileToEntry[v.entry] = { key:k, entry:v, isFeature: !!codemap.features[k] };
    });

    for (const f of changed) {
      // direct match
      if (fileToEntry[f]) {
        if (fileToEntry[f].isFeature) changedFeatures.add(fileToEntry[f].key);
        // collect tables
        (fileToEntry[f].entry.tables || []).forEach(t=>tablesTouched.add(t));
        (fileToEntry[f].entry.dependents || []).forEach(d=>{
          dependentsAll.add(d);
          // if dependent is welcome
          if (d.replace('.js','') === 'welcome') impactedFeatures.add('welcome-aggregator');
        });
      } else {
        // Heuristic: if file is js/foo.js and foo is feature
        const base = path.basename(f).replace('.js','');
        if (codemap.features[base]) {
          changedFeatures.add(base);
          (codemap.features[base].tables||[]).forEach(t=>tablesTouched.add(t));
          (codemap.features[base].dependents||[]).forEach(d=>dependentsAll.add(d));
        }
        // If file is core like utils.js, find which features depend on it
        const coreKey = base;
        if (codemap.core[coreKey]) {
          (codemap.core[coreKey].dependents||[]).forEach(dep=>{
            dependentsAll.add(dep);
            const depBase = dep.replace('.js','');
            if (codemap.features[depBase]) impactedFeatures.add(depBase);
          });
        }
      }
    }

    // Also if main.js changed, all features potentially impacted
    if (changed.includes('js/main.js') || changed.includes('main.js')) {
      Object.keys(codemap.features).forEach(f=>impactedFeatures.add(f));
    }
  }

  // Checked trailer logic (conservative)
  const checked = {
    versioning: hasSchemaChange ? '[x]' : '[~]',
    i18n: hasI18nChange || touchesFile('js/i18n.js') ? '[x]' : '[~]',
    docs: touches('docs-site/') ? '[x]' : '[~]',
    readme: touchesFile('README.md') ? '[x]' : '[~]',
    checklist: touchesFile('COMMIT_CHECKLIST.md') || touchesFile('AGENTS.md') ? '[x]' : '[~]',
    tests: touches('tests/') || touchesAny(['js/todos.js','js/habits.js','js/projects.js','js/flashcards.js','js/birthdays.js','js/vestiaire.js','js/lists.js']) ? '[x]' : '[~]',
    welcome: (() => {
      if (changedFeatures.size===0 && impactedFeatures.size===0) return '[~]';
      // welcome is impacted if any feature changed, or welcome.js itself, or main.js, or any dependent is welcome
      if (changed.some(f=>f.includes('welcome')) || dependentsAll.has('welcome.js') || changed.includes('js/main.js')) return '[x]';
      if (changedFeatures.size>0) return '[x]'; // because welcome aggregates
      return '[~]';
    })(),
    prompts: touchesAny(['prompts','js/habits.js','js/todos.js','js/flashcards.js','js/projects.js']) ? '[x]' : '[~]',
    xss: hasEscOrInnerHTML || touches('js/') ? '[x]' : '[~]'
  };

  // Special: if only docs changed, set many to [~]
  const onlyDocs = changed.length>0 && changed.every(f=> f.startsWith('docs-site/') || f=== 'README.md' || f.startsWith('.agents/'));
  if (onlyDocs) {
    checked.versioning='[~]'; checked.i18n='[~]'; checked.tests='[~]'; checked.welcome='[~]'; checked.prompts='[~]'; checked.xss='[~]';
  }

  const trailer = `Checked: versioning ${checked.versioning}, i18n ${checked.i18n}, docs ${checked.docs}, readme ${checked.readme}, checklist ${checked.checklist}, tests ${checked.tests}, welcome ${checked.welcome}, prompts ${checked.prompts}, xss ${checked.xss}`;

  const result = {
    changedFiles: changed,
    changedFeatures: [...changedFeatures],
    impacted: [...impactedFeatures],
    dependents: [...dependentsAll],
    tables: [...tablesTouched],
    checks: checked,
    trailer,
    suggestion: {
      welcomeImpact: checked.welcome==='[x]' ? 'verify renderWelcome()/refreshWelcome() — Welcome aggregates ' + ([...changedFeatures].join(', ')||'features') : 'no welcome impact',
      xssNote: checked.xss==='[x]' ? 'ensure esc() around user fields in changed templates' : 'no xss-relevant change',
      i18nNote: checked.i18n==='[x]' ? 'add EN/FR/ES keys via t() in js/i18n.js' : ''
    }
  };

  if (formatChecked) {
    console.log(trailer);
    return;
  }
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable report
  console.log(`\n[impact] DeLaClaw — ${staged ? 'staged' : 'worktree'} (${changed.length} files)\n`);
  console.log(changed.map(f=>`  - ${f}`).join('\n') || '  (no changes)');
  console.log('');
  if (changedFeatures.size) console.log(`Features changed: ${[...changedFeatures].join(', ')}`);
  if (impactedFeatures.size) console.log(`Impacted via dependents: ${[...impactedFeatures].join(', ')}`);
  if (dependentsAll.size) console.log(`Direct dependents: ${[...dependentsAll].join(', ')}`);
  if (tablesTouched.size) console.log(`Tables: ${[...tablesTouched].join(', ')}`);
  console.log('');
  console.log(trailer);
  console.log('');
  if (codemap && changedFeatures.size) {
    console.log('Blast radius (from CODEMAP):');
    for (const feat of changedFeatures) {
      const entry = codemap.features[feat];
      if (!entry) continue;
      console.log(`  ${feat}: depends_on [${entry.depends_on.slice(0,4).join(', ')}] -> dependents [${entry.dependents.join(', ')||'-'}] / ui [${entry.ui_components.slice(0,3).join(', ')}]`);
    }
  }
  console.log(`\n[hint] ${result.suggestion.welcomeImpact}`);
  if (result.suggestion.xssNote) console.log(`[hint] XSS: ${result.suggestion.xssNote}`);
  if (result.suggestion.i18nNote) console.log(`[hint] i18n: ${result.suggestion.i18nNote}`);
  console.log('');
}

analyze();
