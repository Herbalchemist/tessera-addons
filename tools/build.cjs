#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Packs every add-on in addons/ into dist/<id>-<version>.tar.gz and writes catalog.json, the list
// Tessera's Settings > Add-ons > Get add-ons reads.
//
//   node tools/build.cjs                 pack, and write catalog.json
//   node tools/build.cjs --check         pack, and fail if catalog.json would change
//
// Packages are deterministic (sorted names, fixed owner and time), so the same folder always gives
// the same bytes. GitHub's release workflow runs this, uploads the packages, and commits
// catalog.json; you don't need to run it by hand except to try a package yourself.

const fs = require('fs');
const path = require('path');
const P = require('./lib/addon-package');

const ROOT = path.resolve(__dirname, '..');
const REPO = process.env.TESSERA_ADDONS_REPO || 'Herbalchemist/tessera-addons';
const releaseTag = (id, version) => `${id}-v${version}`;
const packageName = (id, version) => `${id}-${version}.tar.gz`;
const packageUrl = (id, version) => `https://github.com/${REPO}/releases/download/${releaseTag(id, version)}/${packageName(id, version)}`;

// What an add-on folder is, from the file at its top.
function describeAddon(dir) {
  const id = path.basename(dir);
  const kind = Object.keys(P.KINDS).find((k) => fs.existsSync(path.join(dir, P.KINDS[k])));
  if (!kind) throw new Error(`${id}: no addon.json, manifest.json or theme.json at its top`);
  if (!P.ID_RE.test(id)) throw new Error(`${id}: folder names are lowercase letters, digits, . _ -`);
  const m = JSON.parse(fs.readFileSync(path.join(dir, P.KINDS[kind]), 'utf8'));
  if (kind !== 'theme' && m.id !== undefined && m.id !== id) throw new Error(`${id}: ${P.KINDS[kind]} says its id is "${m.id}"`);
  if (typeof m.name !== 'string' || !m.name.trim()) throw new Error(`${id}: needs a "name"`);
  if (typeof m.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/.test(m.version)) throw new Error(`${id}: needs a "version" like "1.0.0"`);
  return { id, kind, name: m.name.trim(), version: m.version, author: m.author || '', description: m.description || '', requires: m.requires || '' };
}

function addonDirs() {
  const base = path.join(ROOT, 'addons');
  return fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(base, e.name)).sort();
}

function build({ out = path.join(ROOT, 'dist') } = {}) {
  fs.mkdirSync(out, { recursive: true });
  const addons = [];
  for (const dir of addonDirs()) {
    const a = describeAddon(dir);
    const gz = P.writePackage(P.folderFiles(dir));
    P.readPackage(gz); // the package must pass Tessera's own unpacking rules
    const file = path.join(out, packageName(a.id, a.version));
    fs.writeFileSync(file, gz);
    addons.push({
      id: a.id, kind: a.kind, name: a.name, version: a.version, author: a.author, description: a.description,
      ...(a.requires ? { requires: a.requires } : {}),
      url: packageUrl(a.id, a.version), sha256: P.sha256(gz), size: gz.length,
      file, tag: releaseTag(a.id, a.version),
    });
  }
  const catalog = { version: 1, addons: addons.map(({ file, tag, ...entry }) => entry) };
  const parsed = P.parseCatalog(JSON.stringify(catalog)); // exactly what Tessera will make of it
  if (parsed.skipped.length) throw new Error(`Tessera would skip: ${JSON.stringify(parsed.skipped)}`);
  return { addons, catalog };
}

if (require.main === module) {
  const { addons, catalog } = build();
  const text = JSON.stringify(catalog, null, 2) + '\n';
  const file = path.join(ROOT, 'catalog.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const a of addons) console.log(`${a.tag}  ${a.size} bytes  sha256 ${a.sha256}`);
  if (process.argv.includes('--check')) {
    if (before !== text) { console.error('catalog.json is out of date: run node tools/build.cjs'); process.exit(1); }
    console.log('catalog.json is up to date');
  } else {
    fs.writeFileSync(file, text);
    console.log(before === text ? 'catalog.json unchanged' : 'catalog.json written');
  }
}

module.exports = { build, describeAddon, addonDirs, releaseTag, packageName, packageUrl };
