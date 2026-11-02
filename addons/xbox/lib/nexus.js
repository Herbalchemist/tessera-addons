// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Games made with Xodus Nexus, a community launcher (MIT) that runs Microsoft Store PC games on
// Linux. This add-on never bundles or installs it and does not talk to Microsoft. Tessera itself
// keeps Xbox games behind the PIN; this only finds them.
//
// Pure helpers, so they can be tried without Tessera:
//   findGames(dirs)         the games Nexus has made desktop entries for ("Create shortcut")
//   fromSteamOptions(opts)  the same, from a Steam shortcut Nexus made ("Add to Steam")
//   running(procRoot)       is Nexus open? (a second start only hands over to it and exits)
//
// What Nexus writes was read from its source (src/main/game-shortcuts.ts, Nexus 0.4.2) and has
// not been checked against a real install. If Nexus changes the format these find nothing.

const fs = require('fs');
const path = require('path');

const GAME_ID_RE = /^[a-f0-9]{16}$/;
const MAX_ENTRIES = 3000;
const MAX_ENTRY_BYTES = 128 * 1024;
const MAX_SCRIPT_BYTES = 4096;

// A .desktop value escapes backslash, newline, return and tab (\\ \n \r \t) and space (\s).
const fileUnescape = (v) => v.replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === 's' ? ' ' : c));

// Split a command line into words. Inside double quotes a backslash escapes " ` $ and \.
// With desktop = true, %% stands for a literal % (the Exec= rule); Steam launch options have no such rule.
function splitCommand(s, desktop = true) {
  const words = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    let w = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"`$\\'.includes(s[i + 1])) { w += s[i + 1]; i += 2; } else { w += s[i]; i++; }
      }
      if (s[i] !== '"') return null; // an unclosed quote: not something Nexus wrote
      i++;
    } else {
      while (i < s.length && s[i] !== ' ' && s[i] !== '\t') { w += s[i]; i++; }
    }
    words.push(desktop ? w.replace(/%%/g, '%') : w);
  }
  return words;
}

// The first [Desktop Entry] group as { key: value } (first occurrence of a key wins).
function parseEntry(text) {
  const kv = {};
  let inEntry = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) inEntry = line.trim() === '[Desktop Entry]';
    else if (inEntry) {
      const m = /^([A-Za-z0-9-]+)=(.*)$/.exec(line.replace(/\r$/, ''));
      if (m && kv[m[1]] === undefined) kv[m[1]] = m[2];
    }
  }
  return kv;
}

const isScriptOk = (file) => {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SCRIPT_BYTES) return false;
    return fs.readFileSync(file, 'utf8').includes('X-Xodus-Nexus-Profile=');
  } catch { return false; }
};

// Games Nexus made desktop entries for. An entry counts only if it carries Nexus's own markers,
// its command is exactly "/bin/sh <abs>/launch-game <id>" with the same id, and that script is
// the small file Nexus writes. Anything else in the folder is left alone.
function findGames(dirs) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.desktop')).slice(0, MAX_ENTRIES); } catch { continue; }
    for (const n of names) {
      const file = path.join(dir, n);
      let text;
      try {
        if (fs.statSync(file).size > MAX_ENTRY_BYTES) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      const kv = parseEntry(text);
      const id = kv['X-Xodus-Nexus-Game'];
      if (kv.Type !== 'Application' || !kv['X-Xodus-Nexus-Profile'] || !id || !GAME_ID_RE.test(id) || seen.has(id)) continue;
      if (kv.NoDisplay === 'true' || kv.Hidden === 'true') continue; // Nexus's window-identity entries
      const words = splitCommand(fileUnescape(kv.Exec || ''));
      if (!words || words.length !== 3 || words[0] !== '/bin/sh' || words[2] !== id) continue;
      const script = words[1];
      if (!path.isAbsolute(script) || path.basename(script) !== 'launch-game' || !isScriptOk(script)) continue;
      seen.add(id);
      out.push({ id, title: fileUnescape(kv.Name || ''), script, file: '/bin/sh', args: [script, id] });
    }
  }
  return out;
}

// A Steam shortcut Nexus made: its LaunchOptions are  "<dir>/launch-game" "<id>"  for a game and
// "<dir>/launch-nexus"  for the launcher itself.
function fromSteamOptions(options) {
  if (typeof options !== 'string' || options.length > 4096) return null;
  const w = splitCommand(options, false);
  if (!w) return null;
  if (w.length === 2 && GAME_ID_RE.test(w[1]) && path.isAbsolute(w[0]) && path.basename(w[0]) === 'launch-game') return { kind: 'game', id: w[1] };
  if (w.length === 1 && path.isAbsolute(w[0]) && path.basename(w[0]) === 'launch-nexus') return { kind: 'launcher' };
  return null;
}


// Is a Nexus process of this user running? Nexus allows one copy per profile; starting a game
// while it is open only hands the request over and exits at once, so Tessera would think the game
// had ended. Matches the program name of the process (the AppImage or its electron binary).
function running(procRoot = '/proc', uid = typeof process.getuid === 'function' ? process.getuid() : null) {
  let pids;
  try { pids = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n)); } catch { return false; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      if (uid !== null && fs.statSync(path.join(procRoot, pid)).uid !== uid) continue;
      const argv = fs.readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8').split('\0');
      if (/xodus[-_ ]?nexus/i.test(path.basename(argv[0] || ''))) return true;
    } catch { /* the process ended while we looked */ }
  }
  return false;
}

module.exports = { findGames, fromSteamOptions, running, splitCommand, fileUnescape, parseEntry };
