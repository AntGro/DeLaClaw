#!/usr/bin/env node
// ===================================================================
// package.mjs — copy-and-stamp packaging for the DeLaClaw extension.
//
// One source (extension/src), two loadable outputs (extension/dist/
// prod and dev). This is a copy-and-stamp script, NOT a build step:
// no bundling, no transpiling. The stamped outputs are generated —
// never hand-edit them; re-run this script.
//
// What stamping does per variant:
//   manifest.json — name, key, version (repo VERSION), _execute_action
//                   shortcut (Ctrl+Shift+Y Prod / Ctrl+Shift+U Dev)
//   variant.js    — name, fixed Drive folder, app URL, extension ID,
//                   known schema version (latest DRIVE_MIGRATIONS key)
//   icons/        — downscaled from icons/icon-512.png (Prod) and
//                   icons/icon-512-dev.png (Dev)
//   popup.css     — theme variables copied from the app's style.css
//                   (:root + [data-theme="light"]); no second copy
//   *.js copies  — js/frequency-rule.js, js/calendar-pure.js and
//                   migrations/version-compare.js are copied verbatim
//                   (the app's pure modules; reused, never reimplemented)
//
// Run from the repo root:  node extension/package.mjs
// Then load extension/dist/prod (or dev) unpacked in Chrome.
// ===================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compareVersions } from '../migrations/version-compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension', 'src');
const DIST = path.join(ROOT, 'extension', 'dist');

// Pinned public keys. The private keys live outside the repo (goal
// workspace, auth-spike/keys/); these public keys pin the extension IDs
// whose redirect URIs are registered on the web OAuth client. Never
// change a key once its redirect URI is registered.
const VARIANTS = {
  prod: {
    name: 'DeLaClaw',
    folder: 'DeLaClaw',
    appUrl: 'https://delaclaw.com',
    expectedId: 'cnpaghkipnignlonpoblbpoceheompap',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAom/jQHucNBGArxrhp16uA8etz3NIUzUjbRK8XFjnE4OdkfH/3n3jHqxlNBrxr5BxZeOiGRMoRTvYAJsw9EwZL8466CHKxBApbrb1+X5OaXcSJ6wUppsHIggjs3geQNs/d5dEa0D3c30QFEajwB+ac/IP0q7BEsymaSrc2gqDorn86Y334MDYgrsI87XtqdPbvolwJDzMsFZTUdrdKTJdsfB91IfFKNtCZzdjOic9NdC3aotxr7guqJUfqPc/HtzGvUI0R7ietEPzjQZllay9VC6+17vWytElLsdekhhMeJs6UgXwVNphT6sobP3+bS1AIsAEHZLTRfCE2oI8qEw8rwIDAQAB',
    shortcut: 'Ctrl+Shift+Y',
    shortcutMac: 'Command+Shift+Y',
    iconSrc: 'icons/icon-512.png',
    isDev: false,
  },
  dev: {
    name: 'DeLaClaw Dev',
    folder: 'DeLaClawDev',
    appUrl: 'https://dev.delaclaw.pages.dev',
    expectedId: 'kpogipeoagoggadlphkmehgfgippgjfl',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsHP3MZC87Q2vz5d20FlJBgTg2Lu0J4oljMZPAqPHamb7FDzAV/0TL3TPISPoIMH31NeypU99nRTB8bk69MWbVRsa8DKnlKi7o7Zu9d/u7S3vlpbbbhLqpeBzxHHyfyCaXaAALtU1vF+Z/JT6gQ9USeGe9Vevr8Yc4L6Ug34FFOLxWGDshbeYkXvAqFMGOfhTABradGk9AZ7RRxLidDR552/FUWarF0Jg3QUjQ+dm654ll+Wz/RuuVvfwXZ6t5XtaHzVH14S+YCUUD/6IHdNcSfR4wt3pBO+UcTDFl44xqr5OSI4PLLBmsGpFxusLAEzkmxAqmSRiiLbE/Krl0PF7QQIDAQAB',
    shortcut: 'Ctrl+Shift+U',
    shortcutMac: 'Command+Shift+U',
    iconSrc: 'icons/icon-512-dev.png',
    isDev: true,
  },
};

// Chrome's extension-ID derivation: first 128 bits of the SHA-256 of
// the DER public key, hex nibbles 0-f mapped to letters a-p.
export function extensionIdFromKey(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

function readVersion() {
  const text = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8');
  const m = text.match(/^latest=(.+)$/m);
  if (!m) throw new Error('Could not read latest= from VERSION');
  return m[1].trim();
}

function readKnownSchemaVersion() {
  const src = fs.readFileSync(path.join(ROOT, 'migrations', 'drive-migrations.js'), 'utf8');
  const keys = [...src.matchAll(/'([0-9][0-9.]*?)':/g)].map((m) => m[1]);
  if (keys.length === 0) throw new Error('No DRIVE_MIGRATIONS keys found');
  return keys.sort(compareVersions).pop();
}

function extractCssBlock(css, selector) {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`, 's');
  const m = css.match(re);
  if (!m) throw new Error(`CSS block not found in style.css: ${selector}`);
  return m[0];
}

function downscaleIcons(srcPng, outDir) {
  const script = `
from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert('RGBA')
for s in (16, 32, 48, 128):
    im.resize((s, s), Image.LANCZOS).save(f'{sys.argv[2]}/icon-{s}.png')
`;
  execFileSync('python3', ['-c', script, srcPng, outDir], { stdio: 'inherit' });
}

function main() {
  const version = readVersion();
  const knownSchemaVersion = readKnownSchemaVersion();
  const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const themeVars = [
    extractCssBlock(styleCss, ':root'),
    extractCssBlock(styleCss, '[data-theme="light"]'),
  ].join('\n');

  const srcFiles = fs.readdirSync(SRC).filter((f) => !f.startsWith('.'));
  const copiedModules = [
    ['js/frequency-rule.js', 'frequency-rule.js'],
    ['js/calendar-pure.js', 'calendar-pure.js'],
    ['migrations/version-compare.js', 'version-compare.js'],
  ];

  for (const [variantKey, v] of Object.entries(VARIANTS)) {
    const outDir = path.join(DIST, variantKey);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });

    // Extension ID check: the key must derive the registered ID, or
    // the redirect URI on the OAuth client would not match.
    const derivedId = extensionIdFromKey(v.key);
    if (derivedId !== v.expectedId) {
      throw new Error(`Key for ${variantKey} derives ID ${derivedId}, expected ${v.expectedId}`);
    }

    for (const f of srcFiles) {
      const src = path.join(SRC, f);
      const dest = path.join(outDir, f);
      if (f === 'manifest.json') {
        const manifest = JSON.parse(fs.readFileSync(src, 'utf8'));
        manifest.name = v.name;
        manifest.key = v.key;
        manifest.version = version;
        manifest.commands._execute_action.suggested_key = {
          default: v.shortcut,
          mac: v.shortcutMac,
        };
        fs.writeFileSync(dest, `${JSON.stringify(manifest, null, 2)}\n`);
      } else if (f === 'variant.js') {
        let text = fs.readFileSync(src, 'utf8');
        text = text
          .replace('__NAME__', v.name)
          .replace('__FOLDER__', v.folder)
          .replace('__APP_URL__', v.appUrl)
          .replace('__EXTENSION_ID__', v.expectedId)
          .replace('__IS_DEV__', String(v.isDev))
          .replace('__KNOWN_SCHEMA_VERSION__', knownSchemaVersion);
        fs.writeFileSync(dest, text);
      } else if (f === 'popup.css') {
        const text = fs.readFileSync(src, 'utf8');
        if (!text.includes('/* __THEME_VARS__ */')) throw new Error('popup.css lost its __THEME_VARS__ placeholder');
        fs.writeFileSync(dest, text.replace('/* __THEME_VARS__ */', themeVars));
      } else {
        fs.copyFileSync(src, dest);
      }
    }

    for (const [from, to] of copiedModules) {
      fs.copyFileSync(path.join(ROOT, from), path.join(outDir, to));
    }

    downscaleIcons(path.join(ROOT, v.iconSrc), path.join(outDir, 'icons'));

    // Validation of the stamped output.
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    if (manifest.oauth2) throw new Error(`${variantKey}: stamped manifest must not carry an oauth2 block`);
    if (manifest.version !== version) throw new Error(`${variantKey}: manifest version ${manifest.version} != ${version}`);
    const expectedPerms = ['identity', 'contextMenus', 'storage', 'activeTab'];
    if (JSON.stringify([...manifest.permissions].sort()) !== JSON.stringify([...expectedPerms].sort())) {
      throw new Error(`${variantKey}: permissions ${manifest.permissions} != ${expectedPerms}`);
    }
    console.log(`  ${variantKey}: ${v.name} — id ${v.expectedId}, folder ${v.folder}, version ${version}, schema ${knownSchemaVersion}`);
  }

  console.log(`Packaged ${version} (schema ${knownSchemaVersion}) → extension/dist/{prod,dev}`);
}

main();
