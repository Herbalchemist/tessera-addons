// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Add-on packages and the add-on catalog.
//
// The catalog (catalog.json in the tessera-addons repository) lists what can be installed from
// Settings > Add-ons > Get add-ons. Each entry points at a package: a .tar.gz of the add-on's
// folder (addon.json, manifest.json or theme.json at its top), plus the package's SHA-256.
//
// Nothing in a package is trusted: only plain files and folders are unpacked (no links, devices or
// anything else), names are limited to letters, digits and . _ - (no "..", nothing hidden, nothing
// absolute), and sizes are capped. A package that breaks any rule is refused whole. Whether a
// shard is Official is decided afterwards, by its signature (addon-verify.js), never by the
// catalog.
//
// Pure functions, no Electron: also used by the tessera-addons repository's packing tool.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const KINDS = { shard: 'addon.json', widget: 'manifest.json', theme: 'theme.json' };
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const LIMITS = { files: 500, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, packageBytes: 32 * 1024 * 1024, depth: 8 };
const CATALOG_MAX_BYTES = 256 * 1024;

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// catalog.json -> { addons: [...] }. Entries that don't follow the rules are left out (and listed in
// `skipped`), so one bad entry never hides the rest.
function parseCatalog(input) {
  let d = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    if (input.length > CATALOG_MAX_BYTES) throw new Error('The add-on list is too big.');
    try { d = JSON.parse(String(input)); } catch { throw new Error("The add-on list isn't valid."); }
  }
  if (!d || typeof d !== 'object' || d.version !== 1 || !Array.isArray(d.addons)) throw new Error("The add-on list isn't in a format this Tessera knows.");
  const addons = [];
  const skipped = [];
  const seen = new Set();
  for (const a of d.addons.slice(0, 500)) {
    const id = a && typeof a.id === 'string' ? a.id : '';
    const why = (() => {
      if (!ID_RE.test(id)) return 'bad id';
      if (seen.has(id)) return 'listed twice';
      if (!Object.prototype.hasOwnProperty.call(KINDS, a.kind)) return 'unknown kind';
      if (!text(a.name, 60)) return 'no name';
      if (typeof a.version !== 'string' || !VERSION_RE.test(a.version)) return 'bad version';
      if (typeof a.url !== 'string' || a.url.length > 500) return 'bad url';
      try { const u = new URL(a.url); if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'bad url'; } catch { return 'bad url'; }
      if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) return 'bad sha256';
      if (!Number.isInteger(a.size) || a.size <= 0 || a.size > LIMITS.packageBytes) return 'bad size';
      return null;
    })();
    if (why) { skipped.push({ id: id.slice(0, 64), why }); continue; }
    seen.add(id);
    addons.push({
      id, kind: a.kind, name: text(a.name, 60), version: a.version,
      author: text(a.author, 60), description: text(a.description, 300),
      url: a.url, sha256: a.sha256, size: a.size,
      requires: text(a.requires, 120), // e.g. "Tessera 0.25 or newer"; shown, not enforced
    });
  }
  return { addons, skipped };
}

// ---------------------------------------------------------------- tar (ustar), read side

function field(buf, off, len) {
  const end = buf.indexOf(0, off);
  return buf.toString('utf8', off, end >= 0 && end < off + len ? end : off + len);
}
function octal(buf, off, len) {
  const s = field(buf, off, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new Error('bad number in the package');
  return s ? parseInt(s, 8) : 0;
}

// A package's entries: [{ name, dir: true } | { name, data: Buffer }], in the archive's order.
function readPackage(gz, limits = LIMITS) {
  if (!Buffer.isBuffer(gz) || gz.length > limits.packageBytes) throw new Error('The package is too big.');
  let tar;
  try { tar = zlib.gunzipSync(gz, { maxOutputLength: limits.totalBytes + 1024 * 1024 }); } catch { throw new Error("The package couldn't be unpacked."); }
  const out = [];
  const names = new Set();
  let total = 0;
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const h = tar.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) break; // end of archive
    // header checksum: the header's bytes summed with the checksum field read as spaces
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (octal(h, 148, 8) !== sum) throw new Error('The package is damaged.');
    const type = String.fromCharCode(h[156] || 48);
    const prefix = field(h, 345, 155);
    let name = (prefix ? `${prefix}/` : '') + field(h, 0, 100);
    const size = octal(h, 124, 12);
    pos += 512;
    const data = tar.subarray(pos, pos + size);
    if (data.length !== size) throw new Error('The package is cut short.');
    pos += Math.ceil(size / 512) * 512;
    name = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (name === '' || name === '.') continue; // the archive's own top folder entry
    const parts = name.split('/');
    if (parts.length > limits.depth || !parts.every((p) => NAME_RE.test(p) && p !== '.' && p !== '..' && !p.startsWith('.'))) throw new Error(`The package has a name Tessera won't unpack: ${name.slice(0, 80)}`);
    if (names.has(name)) throw new Error('The package lists a file twice.');
    names.add(name);
    if (type === '5') { out.push({ name, dir: true }); continue; }
    if (type !== '0') throw new Error('The package holds something other than plain files and folders.');
    if (size > limits.fileBytes) throw new Error(`${name.slice(0, 80)} is too big.`);
    total += size;
    if (total > limits.totalBytes) throw new Error('The package is too big once unpacked.');
    if (out.length >= limits.files) throw new Error('The package has too many files.');
    out.push({ name, data: Buffer.from(data) });
  }
  // A file and a folder (or a file "inside" a file) with clashing names can't both exist.
  for (const n of names) {
    const parts = n.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const e = out.find((x) => x.name === parent);
      if (e && !e.dir) throw new Error('The package has a file where a folder should be.');
    }
  }
  return out;
}

// ---------------------------------------------------------------- tar (ustar), write side
// Deterministic: sorted names, fixed owner and time, so the same folder always gives the same bytes
// (and the same SHA-256). Used by the packing tool and by tests.

function header(name, size, type) {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    if (cut <= 0) throw new Error(`name too long: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(type === '5' ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii'); // mtime 0
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

// files: [{ name, data }] (folders are implied). Returns the .tar.gz bytes.
function writePackage(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const entries = [...[...dirs].map((name) => ({ name, dir: true })), ...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks = [];
  for (const e of entries) {
    if (e.dir) { chunks.push(header(e.name + '/', 0, '5')); continue; }
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
    chunks.push(header(e.name, data.length, '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

// Every file under a folder, as writePackage wants them. Hidden files and links are left out.
function folderFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push({ name: r, data: fs.readFileSync(path.join(d, e.name)) });
    }
  };
  walk(dir, '');
  return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Checks a downloaded package against its catalog entry and unpacks it into <root>/<id>, replacing
// what was there only once the new copy is complete. Returns { dir, replaced }.
function installPackage(gz, entry, root, { staging } = {}) {
  if (!Buffer.isBuffer(gz) || gz.length !== entry.size) throw new Error("The download isn't the size the add-on list says.");
  if (sha256(gz) !== entry.sha256) throw new Error("The download doesn't match the add-on list (its SHA-256 differs).");
  const files = readPackage(gz);
  const top = KINDS[entry.kind];
  const main = files.find((f) => f.name === top && !f.dir);
  if (!main) throw new Error(`The package has no ${top} at its top.`);
  if (entry.kind === 'shard' || entry.kind === 'widget') {
    let m;
    try { m = JSON.parse(main.data.toString('utf8')); } catch { throw new Error(`${top} isn't valid.`); }
    if (m && typeof m.id === 'string' && m.id !== entry.id) throw new Error(`${top} is for "${m.id.slice(0, 64)}", not "${entry.id}".`);
  }
  if (!ID_RE.test(entry.id)) throw new Error('Bad add-on id.');
  fs.mkdirSync(root, { recursive: true });
  const stageRoot = staging || path.join(root, '..', '.tessera-incoming');
  fs.mkdirSync(stageRoot, { recursive: true });
  const stage = fs.mkdtempSync(path.join(stageRoot, `${entry.id}-`));
  try {
    for (const f of files) {
      const p = path.join(stage, ...f.name.split('/'));
      if (f.dir) { fs.mkdirSync(p, { recursive: true, mode: 0o755 }); continue; }
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o755 });
      fs.writeFileSync(p, f.data, { mode: 0o644, flag: 'wx' });
    }
    const dest = path.join(root, entry.id);
    let replaced = false;
    let old = null;
    if (fs.existsSync(dest)) {
      old = path.join(stageRoot, `${entry.id}-old-${process.pid}-${Date.now()}`);
      fs.renameSync(dest, old);
      replaced = true;
    }
    try {
      fs.renameSync(stage, dest);
    } catch (e) {
      if (old) fs.renameSync(old, dest); // put the old copy back
      throw e;
    }
    if (old) fs.rmSync(old, { recursive: true, force: true });
    return { dir: dest, replaced };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    try { fs.rmdirSync(stageRoot); } catch { /* not empty, or gone */ }
  }
}

module.exports = { KINDS, ID_RE, LIMITS, parseCatalog, readPackage, writePackage, folderFiles, installPackage, sha256 };
