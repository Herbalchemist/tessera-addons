#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Security standards shared by Tessera's repositories (see SECURITY.md, "Our standards"), checked
// on every push and pull request. Fails with the rule and the place.
//   node tools/security-check.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = { code: ['tools/', 'addons/'], secretPatternOk: [] };
const problems = [];
const fail = (rule, where, what) => problems.push(`${rule}: ${where}${what ? ` (${what})` : ''}`);
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const valuesOnly = (s) => s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''").replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, '``').replace(/`[^`]*`/g, (t) => (t.match(/\$\{[^}]*\}/g) || []).join(' '));
const isText = (f) => !/\.(png|jpe?g|gif|webp|ico|icns|mp4|otf|ttf|woff2?|gz|tgz|zip|iso|img)$/i.test(f);

// No secrets in the repository
const SECRET_FILE = /(^|\/)(\.env(\..*)?|id_rsa|id_ecdsa|id_ed25519|.*\.(pem|key|p12|pfx|keystore|jks))$/i;
for (const f of tracked) if (SECRET_FILE.test(f)) fail('No secret files in Git', f);
const SECRET_TEXT = /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|gh[osu]_[A-Za-z0-9]{30,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}/;
for (const f of tracked.filter(isText)) {
  if (f === 'tools/security-check.cjs' || CONFIG.secretPatternOk.includes(f)) continue;
  let t; try { t = read(f); } catch { continue; }
  const m = SECRET_TEXT.exec(t);
  if (m) fail('No keys or tokens in files', f, m[0].slice(0, 24) + '…');
}
const ignore = read('.gitignore').split('\n').map((l) => l.trim());
for (const p of ['.env', '.env.*', '*.key', '*.pem', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*']) if (!ignore.includes(p)) fail('.gitignore covers secret files', '.gitignore', `missing ${p}`);

// The code people run
const code = tracked.filter((f) => /\.(js|cjs|mjs)$/.test(f) && CONFIG.code.some((d) => f.startsWith(d)) && !/(^|\/)test\//.test(f) && !f.includes('node_modules/') && f !== 'tools/security-check.cjs');
for (const f of code) {
  read(f).split('\n').forEach((line, i) => {
    const at = `${f}:${i + 1}`;
    const c = line.replace(/\/\/.*$/, '');
    if (/shell\s*:\s*true/.test(c)) fail('No shell for commands', at);
    if (/(child_process|require\('child_process'\))\.exec(Sync)?\(|\bexecSync\(/.test(c) || /[^.\w]exec\(\s*['"`]/.test(c)) fail('No shell for commands', at, 'use execFile or spawn');
    if (/\beval\s*\(|new Function\s*\(/.test(c)) fail('No eval', at);
    if (/nodeIntegration\s*:\s*true|contextIsolation\s*:\s*false|sandbox\s*:\s*false|webSecurity\s*:\s*false|allowRunningInsecureContent\s*:\s*true|webviewTag\s*:\s*true/.test(c)) fail('Electron protections on', at, c.trim().slice(0, 60));
    if (/openDevTools\(|remote-debugging|--inspect/.test(c)) fail('No debugging in production', at);
    if (/(console\.\w+|\w*[lL]og\w*)\([^)]*\b(password|passphrase|secret|token|privateKey)\b/i.test(valuesOnly(c))) fail('No secrets in logs', at, c.trim().slice(0, 70));
  });
}
// Electron windows: sandboxed, isolated, no Node, developer tools off in released builds
for (const f of CONFIG.electronMain || []) {
  const t = read(f);
  for (const m of t.matchAll(/webPreferences\s*:\s*\{[^}]*\}/g)) {
    const line = t.slice(0, m.index).split('\n').length;
    for (const need of [/sandbox\s*:\s*true/, /contextIsolation\s*:\s*true/, /nodeIntegration\s*:\s*false/, CONFIG.devTools]) if (!need.test(m[0])) fail('Electron protections on', `${f}:${line}`, `webPreferences without ${need.source}`);
  }
  if (!/e\.senderFrame === win\.webContents\.mainFrame/.test(t)) fail('Requests checked for their sender', f);
}
for (const f of CONFIG.pages || []) {
  const csp = (/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(read(f)) || [])[1] || '';
  if (!/default-src 'none'/.test(csp) || !/script-src 'self'(;|$)/.test(csp) || /unsafe-inline|unsafe-eval|\*/.test(csp)) fail('Strict page policy', f, csp || 'no Content-Security-Policy');
}
// HTML only from fixed text: string literals, or marked "// safe-html: <why>" on the line before
for (const f of CONFIG.renderer || []) {
  const lines = read(f).split('\n');
  lines.forEach((line, i) => {
    const m = /\.(innerHTML|outerHTML)\s*\+?=\s*(.*)$/.exec(line);
    if (!m) return;
    const literal = /^(('[^'\\]*'|"[^"\\]*")\s*\+?\s*)+;?\s*$/.test(m[2].trim());
    if (!literal && !/\/\/ safe-html: \S/.test(lines[i - 1] || '')) fail('No HTML from outside text', `${f}:${i + 1}`, m[2].trim().slice(0, 60));
  });
  if (/insertAdjacentHTML|document\.write|\.srcdoc\s*=/.test(lines.join('\n'))) fail('No HTML from outside text', f);
}
// Actions pinned to a commit
for (const f of tracked.filter((x) => x.startsWith('.github/workflows/'))) {
  read(f).split('\n').forEach((line, i) => {
    const m = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line);
    if (m && !m[1].startsWith('./') && !/@[0-9a-f]{40}$/.test(m[1])) fail('Actions pinned to a commit', `${f}:${i + 1}`, m[1]);
  });
}

if (problems.length) {
  console.error(`Security standards: ${problems.length} problem(s)\n` + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log('Security standards: all checks pass');
