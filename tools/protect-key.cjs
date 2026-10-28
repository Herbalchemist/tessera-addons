#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Puts a passphrase on the signing key, so a copy on a lost flash drive is useless without it.
//
//   node tools/protect-key.cjs /path/to/tessera-2026.pem
//
// Writes tessera-2026.protected.pem next to it (AES-256, the passphrase stretched with scrypt by
// OpenSSL's PKCS#8 encryption), checks it opens and is the same key, and leaves the original alone:
// delete the unprotected one yourself once your copies of the protected one are in place.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { askSecretSync } = require('./lib/ask-secret');

if (process.env.CI || process.env.GITHUB_ACTIONS) { console.error('For your own computer only.'); process.exit(2); }
const src = process.argv[2];
if (!src) { console.error('usage: node tools/protect-key.cjs /path/to/private-key.pem'); process.exit(2); }
const pem = fs.readFileSync(src);
if (/ENCRYPTED/.test(pem.toString('latin1'))) { console.error('That key already has a passphrase.'); process.exit(1); }
const key = crypto.createPrivateKey(pem);
const a = askSecretSync('New passphrase (12+ characters; a few random words is good): ');
if (a.length < 12) { console.error('Use at least 12 characters.'); process.exit(1); }
const b = askSecretSync('Same passphrase again: ');
if (a !== b) { console.error("They don't match. Nothing written."); process.exit(1); }
const out = path.join(path.dirname(src), path.basename(src, '.pem') + '.protected.pem');
if (fs.existsSync(out)) { console.error(`${out} already exists. Nothing written.`); process.exit(1); }
const enc = key.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: a });
fs.writeFileSync(out, enc, { mode: 0o600 });
const back = crypto.createPrivateKey({ key: fs.readFileSync(out), format: 'pem', passphrase: a });
const same = crypto.createPublicKey(back).export({ type: 'spki', format: 'pem' }) === crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
if (!same) { fs.rmSync(out); console.error('Check failed; nothing kept.'); process.exit(1); }
console.log(`Wrote ${out} (checked: it opens with that passphrase and is the same key).`);
console.log('Next: copy it to your backup places, then delete the unprotected original.');
