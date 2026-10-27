// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Tells an "Official" add-on (signed by the Tessera project) apart from everything else.
// Nothing here says an add-on is SAFE to run — only that it is, or is not, the exact bytes the
// project actually signed. An add-on is code with the same reach as Tessera itself (main.js
// decides whether, and under what settings, that code actually gets loaded); this module only
// answers one question: is this really official?

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The project's public key(s). Only Herbalchemist holds the matching private key, kept
// offline — nothing in a user-writable add-on folder can forge a signature against it. To
// rotate keys later: add a new keyId here and keep the old one so add-ons signed before the
// rotation still verify.
const PUBLIC_KEYS = {
  'tessera-2026': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUU0NUB6oqPMPLe1rkBnsaJAY7ttP6N3yDL6fl0ezuuY=
-----END PUBLIC KEY-----
`,
};

const SIG_FILE = 'addon.sig';
const MAX_FILES = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB per file
const MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 32 MB per add-on

// Every file in the folder (not just the manifest), sorted, hashed together — so moving,
// renaming or editing anything at all inside changes the result. The signature file itself is
// excluded (it can't sign itself). Symlinks are never followed, so nothing outside the folder
// can sneak into what gets hashed.
function listFiles(dir, base, out, depth) {
  if (depth > 8) throw new Error('too deep');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) { listFiles(full, rel, out, depth + 1); continue; }
    if (!e.isFile()) continue;
    if (rel === SIG_FILE) continue;
    out.push({ full, rel });
    if (out.length > MAX_FILES) throw new Error('too many files');
  }
}

// A stable digest of everything in the folder: same inputs, same hash, on any machine.
function computeAddonHash(dir) {
  const files = [];
  listFiles(dir, '', files, 0);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = crypto.createHash('sha256');
  let total = 0;
  for (const f of files) {
    const st = fs.statSync(f.full);
    if (st.size > MAX_FILE_BYTES) throw new Error(`${f.rel} is too large to hash`);
    total += st.size;
    if (total > MAX_TOTAL_BYTES) throw new Error('add-on is too large to hash');
    const data = fs.readFileSync(f.full);
    h.update(f.rel, 'utf8'); h.update('\0'); h.update(String(data.length)); h.update('\0'); h.update(data);
  }
  return h.digest('hex');
}

// { official, reason } — reason is always set, even when official is true, so the UI can show
// exactly why: "signed by tessera-2026", "no addon.sig", "signature does not match these
// files", "signed with an unknown key". Never throws: anything unreadable or malformed just
// means "not official", not a crash — the add-on can still run if the owner's settings allow
// unverified ones, it simply won't carry the badge.
function verifyAddon(dir) {
  let hash;
  try { hash = computeAddonHash(dir); }
  catch (e) { return { official: false, reason: `couldn't read it (${e.message})` }; }
  let sig;
  try { sig = JSON.parse(fs.readFileSync(path.join(dir, SIG_FILE), 'utf8')); }
  catch { return { official: false, reason: 'no addon.sig' }; }
  if (!sig || typeof sig !== 'object' || sig.alg !== 'ed25519' || typeof sig.keyId !== 'string' || typeof sig.sig !== 'string')
    return { official: false, reason: 'addon.sig is not in the shape Tessera expects' };
  const pub = PUBLIC_KEYS[sig.keyId];
  if (!pub) return { official: false, reason: `signed with an unknown key (${sig.keyId})` };
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(hash, 'hex'), pub, Buffer.from(sig.sig, 'base64')); }
  catch { ok = false; }
  return ok
    ? { official: true, reason: `signed by ${sig.keyId}` }
    : { official: false, reason: 'signature does not match these files' };
}

module.exports = { computeAddonHash, verifyAddon, PUBLIC_KEYS };
