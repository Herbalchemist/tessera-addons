// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Reads a passphrase from the terminal without showing it (no echo), synchronously. Used by the
// key tools only, on your own computer.
const fs = require('fs');
const { execFileSync } = require('child_process');

function askSecretSync(prompt) {
  if (process.env.TESSERA_KEY_PASSPHRASE) return process.env.TESSERA_KEY_PASSPHRASE; // for scripts; avoid typing it in history
  if (!process.stdin.isTTY) { console.error('Run this in a terminal (it needs to ask for the passphrase).'); process.exit(2); }
  process.stderr.write(prompt);
  const tty = process.platform === 'win32' ? null : '/dev/tty';
  const stty = (args) => { if (tty) try { execFileSync('stty', args, { stdio: [fs.openSync(tty, 'r'), 'ignore', 'ignore'] }); } catch { /* no stty: it will show */ } };
  stty(['-echo']);
  let line = '';
  try {
    const buf = Buffer.alloc(1);
    for (;;) {
      let n = 0;
      try { n = fs.readSync(0, buf, 0, 1, null); } catch (e) { if (e.code === 'EAGAIN') continue; throw e; }
      if (!n) break;
      const ch = buf.toString('utf8');
      if (ch === '\n' || ch === '\r') break;
      if (ch === '\u0003') { stty(['echo']); process.stderr.write('\n'); process.exit(130); }
      line += ch;
    }
  } finally { stty(['echo']); process.stderr.write('\n'); }
  return line;
}
module.exports = { askSecretSync };
