#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Signs an add-on as Official, on your own computer, with the project's private key.
//
//   node tools/sign.cjs addons/xbox /path/to/tessera-2026.pem
//
// A key protected with a passphrase (tools/protect-key.cjs) asks for it here; it is never echoed.
//
// It writes addons/<id>/addon.sig: an Ed25519 signature over every file in the folder (the same
// digest Tessera checks, tools/lib/addon-verify.js), then checks it against the public key Tessera
// ships. Any later change to any file makes the signature stop matching, so sign last, and bump the
// add-on's version in the same commit (signing changes the package).
//
// The private key never goes into this repository, a GitHub secret, or CI. This refuses to run in CI.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const V = require('./lib/addon-verify');

if (process.env.CI || process.env.GITHUB_ACTIONS) {
  console.error('sign.cjs is for your own computer only: the signing key must never be in CI.');
  process.exit(2);
}
const [dirArg, keyArg, keyId = 'tessera-2026'] = process.argv.slice(2);
if (!dirArg || !keyArg) {
  console.error('usage: node tools/sign.cjs addons/<id> /path/to/private-key.pem [keyId]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
const keyFile = path.resolve(keyArg);
if (keyFile.startsWith(path.resolve(__dirname, '..') + path.sep)) {
  console.error('The private key is inside this repository folder. Move it out first, so it can never be committed.');
  process.exit(2);
}
if (!V.PUBLIC_KEYS[keyId]) {
  console.error(`Tessera doesn't know a key called "${keyId}" (it knows: ${Object.keys(V.PUBLIC_KEYS).join(', ')}).`);
  process.exit(2);
}
const pem = fs.readFileSync(keyFile);
const key = loadKey(pem);
const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
if (pub.trim() !== V.PUBLIC_KEYS[keyId].trim()) {
  console.error(`That private key doesn't belong to "${keyId}".`);
  process.exit(1);
}
const hash = V.computeAddonHash(dir);
const sig = crypto.sign(null, Buffer.from(hash, 'hex'), key).toString('base64');
fs.writeFileSync(path.join(dir, 'addon.sig'), JSON.stringify({ alg: 'ed25519', keyId, sig }, null, 2) + '\n');
const v = V.verifyAddon(dir);
if (!v.official) { console.error(`Signed, but it doesn't check out: ${v.reason}`); process.exit(1); }
console.log(`${path.basename(dir)}: Official (${v.reason}). Bump its version, then commit addon.sig with it.`);

function loadKey(pem) {
  if (!/ENCRYPTED/.test(pem.toString('latin1'))) {
    console.error('Note: this key has no passphrase. Protect it with: node tools/protect-key.cjs ' + keyArg);
    return crypto.createPrivateKey(pem);
  }
  const passphrase = require('./lib/ask-secret').askSecretSync('Passphrase for the signing key: ');
  try { return crypto.createPrivateKey({ key: pem, format: 'pem', passphrase }); }
  catch { console.error("That passphrase doesn't open the key."); process.exit(1); }
}
