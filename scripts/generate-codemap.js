#!/usr/bin/env node
/**
 * DeLaClaw CODEMAP generator — T2 enriched (~10KB)
 * Scans js/*.js + js/adapters/*.js, builds dependency graph for AI agents.
 * Output: .agents/CODEMAP.json + .agents/CODEMAP.md
 * Run: bun scripts/generate-codemap.js or node scripts/generate-codemap.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const ADAPTER_DIR = path.join(JS_DIR, 'adapters');
const OUT_DIR = path.join(ROOT, '.agents');
const OUT_JSON = path.join(OUT_DIR, 'CODEMAP.json');
const OUT_MD = path.join(OUT_DIR, 'CODEMAP.md');
const VERSION_FILE = path.join(ROOT, 'VERSION');

const EXCLUDE = new Set(['version.js', 'demo-data.js','demo-chooser.js']); // demo-chooser is core but keep; demo-data excluded from size

// Known shared components from AGENTS.md 1.1
const SHARED_CSS = [
  'view-tab','page-empty-state','modal','settings-data-btn','bucket-card',
  'usage-stats-container','app-header','search-wrap','btn','project-card',
  'card-header','card-body','empty-state','toast','pill'
];

// Known tables (16 core + sharing + visits)
const KNOWN_TABLES = [
  'projects','tasks','todos','habits','habit_completions','flashcards',
  'flashcard_notes','texts','text_line_progress','birthdays','vestiaire',
  'lists','list_items','settings','prompts','nvidia_usage',
  'sharing_groups','sharing_members','sharing_items','joined_groups','daily_visits'
];

const FEATURE_NAMES = ['todos','habits','projects','birthdays','vestiaire','flashcards','lists','welcome'];

function read(p){ try { return fs.readFileSync(p,'utf-8'); } catch { return ''; } }

function parseFile(filePath) {
  const txt = read(filePath);
  const name = path.basename(filePath);
  if (!txt) return null;

  const imports = [];
  const importRe = /from\s+['"]\.(?:\/)?(?:adapters\/)?([^'"]+)\.js['"]/g;
  let m;
  while ((m = importRe.exec(txt)) !== null) {
    // normalize: remove .js if present, keep full path
    let imp = m[1].replace(/\.js$/,'');
    // 'supabase' adapter is 'adapters/supabase' vs 'supabase' — normalize to adapter name
    if (imp.startsWith('adapters/')) imp = imp.replace('adapters/','');
    imports.push(imp);
  }
  // also catch '../migrations/...'
  const import2 = /from\s+['"]\.\.\/([^'"]+)['"]/g;
  while ((m = import2.exec(txt)) !== null) imports.push(m[1]);

  const tables = [...new Set([...txt.matchAll(/from\(['"]([a-z_]+)['"]\)/g)].map(x=>x[1]))].filter(t=>KNOWN_TABLES.includes(t) || /^[a-z_]+$/.test(t));
  const stateKeys = [...new Set([...txt.matchAll(/state\.([A-Za-z0-9_]+)/g)].map(x=>x[1]))];
  const guards = [];
  if (/\bguard\s*\(/.test(txt)) guards.push('guard');
  if (/_pending[A-Za-z0-9_]*|pendingSet|_pendingTodo|_pendingHabit|_pendingTask/.test(txt)) guards.push('pendingSet');

  const escCount = (txt.match(/\besc\s*\(/g) || []).length;
  const i18nCalls = [...txt.matchAll(/\bt\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(x=>x[1]);
  const i18nCount = new Set(i18nCalls).size;
  const i18nPrefix = (() => {
    if (!i18nCalls.length) return null;
    const prefixes = i18nCalls.map(k=>k.split('.')[0]).filter(Boolean);
    const freq = {};
    prefixes.forEach(p=>freq[p]=(freq[p]||0)+1);
    const top = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0];
    return top ? `${top[0]}.` : null;
  })();

  const windowExposed = [...new Set([...txt.matchAll(/window\.([A-Za-z0-9_]+)\s*=/g)].map(x=>x[1]))];

  const usedCss = SHARED_CSS.filter(c => txt.includes(c));

  const loc = txt.split('\n').length;

  return {
    file: path.relative(ROOT, filePath),
    name,
    loc,
    imports: [...new Set(imports)].sort(),
    tables: [...new Set(tables)].sort(),
    state: stateKeys.sort().slice(0,20),
    guards: [...new Set(guards)],
    escCount,
    i18nCount,
    i18nPrefix,
    windowExposed: windowExposed.slice(0,15),
    sharedCss: usedCss
  };
}

// Scan
const allFiles = [];
for (const f of fs.readdirSync(JS_DIR).filter(f=>f.endsWith('.js'))) {
  if (EXCLUDE.has(f) && f !== 'demo-chooser.js') {
    if (f === 'demo-data.js') continue;
  }
  const p = path.join(JS_DIR, f);
  const parsed = parseFile(p);
  if (parsed) allFiles.push(parsed);
}
for (const f of fs.readdirSync(ADAPTER_DIR).filter(f=>f.endsWith('.js'))) {
  const p = path.join(ADAPTER_DIR, f);
  const parsed = parseFile(p);
  if (parsed) {
    parsed.file = path.relative(ROOT, p);
    parsed.adapter = true;
    allFiles.push(parsed);
  }
}

// Build lookup for reverse deps
const byImportName = {};
allFiles.forEach(f=>{
  const base = f.name.replace('.js','');
  byImportName[base]=f;
  // also adapters/supabase -> supabase
  byImportName[f.file.replace('.js','').replace('js/','')]=f;
});

const dependentsMap = {};
allFiles.forEach(f=>{ dependentsMap[f.name]=[]; });
allFiles.forEach(f=>{
  f.imports.forEach(imp=>{
    // imp could be 'state', 'utils', 'adapters/supabase' normalized to 'supabase', 'rest', etc.
    const key = imp.split('/').pop().replace('.js','');
    // find file matching key
    const target = allFiles.find(t=> t.name.replace('.js','')===key || t.file.endsWith(`${key}.js`));
    if (target) {
      if (!dependentsMap[target.name]) dependentsMap[target.name]=[];
      if (!dependentsMap[target.name].includes(f.name)) dependentsMap[target.name].push(f.name);
    }
  });
});

// Separate features vs core
const features = {};
const core = {};
allFiles.forEach(f=>{
  const base = f.name.replace('.js','');
  const entry = {
    entry: f.file,
    loc: f.loc,
    tables: f.tables,
    state: f.state.slice(0,8),
    depends_on: f.imports,
    dependents: (dependentsMap[f.name]||[]).sort(),
    ui_components: f.sharedCss,
    i18n_prefix: f.i18nPrefix,
    guards: f.guards,
    esc_count: f.escCount,
    i18n_count: f.i18nCount,
    window_exposed: f.windowExposed.slice(0,8)
  };
  if (FEATURE_NAMES.includes(base)) {
    features[base]=entry;
  } else {
    core[base]=entry;
  }
});

// Tables usage
const tables = {};
KNOWN_TABLES.forEach(t=>{
  const usedBy = allFiles.filter(f=>f.tables.includes(t)).map(f=>f.name.replace('.js','')).sort();
  if (usedBy.length || ['projects','tasks','todos','habits','habit_completions','flashcards','flashcard_notes','texts','text_line_progress','birthdays','vestiaire','lists','list_items','settings','prompts'].includes(t)) {
    tables[t]= { used_by: usedBy };
  }
});

// Version
let version = '0.000';
try {
  const vtxt = read(VERSION_FILE);
  const mm = vtxt.match(/^latest=([0-9]+\.[0-9]+)/m);
  if (mm) version = mm[1];
} catch {}

const out = {
  meta: {
    version,
    generated_at: new Date().toISOString(),
    loc_total: allFiles.reduce((a,b)=>a+b.loc,0),
    files_scanned: allFiles.length,
    tier: 'T2-enriched',
    note: 'Generated by scripts/generate-codemap.js — do not hand-edit. Read before editing any feature.'
  },
  features,
  core,
  tables,
  css_registry: SHARED_CSS
};

// Ensure dir
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive:true });
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
console.log(`✅ ${path.relative(ROOT, OUT_JSON)} — ${(fs.statSync(OUT_JSON).size/1024).toFixed(1)} KB, ${out.meta.files_scanned} files`);

 // Markdown
let md = `# DeLaClaw CODEMAP — T2 enriched

> Generated ${out.meta.generated_at} from ${out.meta.files_scanned} modules (v${version}). Total LOC ${out.meta.loc_total}. Do not hand-edit.
> Source: \`scripts/generate-codemap.js\`

## How to use (AI agents)

1. Before editing a feature, read its entry here: \`${path.basename(OUT_JSON)}\` → features[feature]
2. Check \`depends_on\` to reuse, \`dependents\` to assess blast radius, \`tables\` + \`state\` for data impact, \`ui_components\` for style reuse.
3. \`welcome.js\` aggregates all others — changes to any feature likely need welcome check.
4. Guards: if modifying interactive element, ensure \`guard()\` or \`pendingSet\` pattern per AGENTS.md 1.2.

## Features (8)

| Feature | LOC | Tables | State | Depends | Dependents | UI | Guards | esc | i18n |
|---------|-----|--------|-------|---------|------------|----|--------|-----|------|
`;

Object.entries(features).sort().forEach(([k,v])=>{
  md+=`| ${k} | ${v.loc} | ${v.tables.join(',')||'-'} | ${v.state.join(',')} | ${v.depends_on.join(',')} | ${v.dependents.join(',')||'-'} | ${v.ui_components.join(',')||'-'} | ${v.guards.join(',')||'-'} | ${v.esc_count} | ${v.i18n_count} |\n`;
});

md+=`\n## Core modules (${Object.keys(core).length})

| Module | LOC | Tables | Depends | Dependents | Risks |
|--------|-----|--------|---------|------------|-------|
`;
Object.entries(core).sort((a,b)=>b[1].loc-a[1].loc).forEach(([k,v])=>{
  const risks = [];
  if (v.esc_count>0) risks.push(`esc:${v.esc_count}`);
  if (v.guards.length) risks.push(v.guards.join('+'));
  if (v.window_exposed.length) risks.push(`window:${v.window_exposed.length}`);
  md+=`| ${k} | ${v.loc} | ${v.tables.join(',')||'-'} | ${v.depends_on.slice(0,4).join(',')} | ${v.dependents.slice(0,4).join(',')||'-'} | ${risks.join(',')||'-'} |\n`;
});

md+=`\n## Tables → used by

| Table | Used by |
|-------|---------|
`;
Object.entries(tables).sort().forEach(([t,v])=>{
  md+=`| ${t} | ${v.used_by.join(', ')||'-'} |\n`;
});

md+=`\n## Adapters

All business logic talks to \`db.js\` proxy. Implementations in \`js/adapters/\` must expose \`from(table).select/insert/update/delete\`.

- supabase.js: PostgREST + Realtime + auth
- rest.js: Bun+SQLite REST
- demo.js: in-memory (seeded)
- drive.js: in-memory + Drive JSON persistence
- offline-cache.js: wraps any adapter, IndexedDB

## CSS registry (reusable)

- ${SHARED_CSS.join(', ')}

## Freshness

- Pre-commit: regenerates JSON+MD, fails if not staged
- Test: \`bun tests/tests.js\` asserts JSON is up-to-date (soon)
`;

fs.writeFileSync(OUT_MD, md);
console.log(`✅ ${path.relative(ROOT, OUT_MD)} — ${(fs.statSync(OUT_MD).size/1024).toFixed(1)} KB`);
