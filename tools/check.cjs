#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Checks the repository (GitHub runs this on every push):
//   - tools/lib/ matches Tessera's own addon-package.js and addon-verify.js (pass the launcher folder
//     of a Tessera checkout), so packages are made and signatures read exactly as Tessera does;
//   - every add-on folder describes itself properly and packs under Tessera's unpacking rules;
//   - which add-ons are Official (signed) and which are not yet.
//
//   node tools/check.cjs [path/to/tessera/system_files/usr/lib/tessera/launcher]

const fs = require('fs');
const path = require('path');
const V = require('./lib/addon-verify');
const { build } = require('./build.cjs');

let problems = 0;
const gh = Boolean(process.env.GITHUB_ACTIONS);
const warn = (msg) => console.log(gh ? `::warning::${msg}` : `warning: ${msg}`);
const fail = (msg) => { problems++; console.log(gh ? `::error::${msg}` : `error: ${msg}`); };

const launcher = process.argv[2];
if (launcher) {
  for (const f of ['addon-package.js', 'addon-verify.js']) {
    const ours = fs.readFileSync(path.join(__dirname, 'lib', f), 'utf8');
    let theirs = null;
    try { theirs = fs.readFileSync(path.join(launcher, f), 'utf8'); } catch { fail(`${f} is missing from ${launcher}`); continue; }
    if (ours !== theirs) fail(`tools/lib/${f} differs from Tessera's: copy it over from ${path.join(launcher, f)}`);
    else console.log(`tools/lib/${f} matches Tessera's`);
  }
}

let built;
try { built = build({ out: fs.mkdtempSync(path.join(require('os').tmpdir(), 'addons-check-')) }); } catch (e) { fail(e.message); }
for (const a of (built && built.addons) || []) {
  const dir = path.join(__dirname, '..', 'addons', a.id);
  if (a.kind === 'shard') {
    const v = V.verifyAddon(dir);
    if (v.official) console.log(`${a.id} ${a.version}: Official (${v.reason})`);
    else if (fs.existsSync(path.join(dir, 'addon.sig'))) warn(`${a.id} ${a.version}: addon.sig no longer matches its files (${v.reason}). Sign it again, offline: node tools/sign.cjs addons/${a.id} /path/to/key.pem`);
    else warn(`${a.id} ${a.version}: not signed yet, so Tessera shows it as unverified. Sign it offline: node tools/sign.cjs addons/${a.id} /path/to/key.pem`);
  } else console.log(`${a.id} ${a.version}: ${a.kind}, ${a.size} bytes`);
}
if (problems) { console.log(`${problems} problem(s)`); process.exit(1); }
console.log('All good.');
