// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Games added to Steam by hand ("non-Steam games") live in userdata/<id>/config/shortcuts.vdf,
// a binary file. Xodus Nexus's "Add to Steam" puts its games there. A copy of Tessera's own
// steam-shortcuts.js (a shard can't load Tessera's files), so the ids match the ones Tessera uses.
//
// Pure functions: parse(buffer) gives the entries, steamLaunchId(entry) the number that
// `steam://rungameid/<number>` takes.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 6;

// Binary VDF: a map is a list of (type byte, NUL-terminated key, value) ended by 0x08.
// Types: 0 map, 1 string, 2 int32, 3 float, 4 pointer, 5 wide string, 6 color, 7 uint64, 10 int64.
function parseBinaryVdf(buf) {
  let pos = 0;
  const cstr = () => {
    const end = buf.indexOf(0, pos);
    if (end < 0) throw new Error('unterminated string');
    const s = buf.toString('utf8', pos, end);
    pos = end + 1;
    return s;
  };
  const need = (n) => { if (pos + n > buf.length) throw new Error('truncated'); };
  const map = (depth) => {
    if (depth > MAX_DEPTH) throw new Error('too deep');
    const out = {};
    let count = 0;
    while (pos < buf.length) {
      const t = buf[pos++];
      if (t === 0x08) return out;
      if (++count > MAX_ENTRIES) throw new Error('too many entries');
      const key = cstr();
      switch (t) {
        case 0: out[key] = map(depth + 1); break;
        case 1: out[key] = cstr(); break;
        case 2: need(4); out[key] = buf.readInt32LE(pos); pos += 4; break;
        case 3: need(4); out[key] = buf.readFloatLE(pos); pos += 4; break;
        case 4: case 6: need(4); out[key] = buf.readUInt32LE(pos); pos += 4; break;
        case 7: need(8); out[key] = buf.readBigUInt64LE(pos); pos += 8; break;
        case 10: need(8); out[key] = buf.readBigInt64LE(pos); pos += 8; break;
        default: throw new Error(`unknown type ${t}`);
      }
    }
    return out; // a file that ends without the closing 0x08 still gives what was read
  };
  return map(0);
}

let crcTable = null;
function crc32(str) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  const b = Buffer.from(str, 'utf8');
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Keys differ in case between Steam versions ("AppName" / "appname"); look them up loosely.
const pick = (o, name) => {
  const k = Object.keys(o).find((x) => x.toLowerCase() === name);
  return k === undefined ? undefined : o[k];
};

// The short id of a shortcut: stored in the file, or worked out from the program and name the
// way Steam does (CRC-32 of both, top bit set).
function shortId(entry) {
  if (Number.isInteger(entry.appid)) return entry.appid >>> 0;
  return (crc32(`${entry.exe}${entry.name}`) | 0x80000000) >>> 0;
}
// What steam://rungameid/ wants for a shortcut: the short id in the top half, 0x02000000 below.
function steamLaunchId(entry) {
  return ((BigInt(shortId(entry)) << 32n) | 0x02000000n).toString();
}

function parse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > MAX_BYTES) return [];
  let root;
  try { root = parseBinaryVdf(buf); } catch { return []; }
  const list = pick(root, 'shortcuts');
  if (!list || typeof list !== 'object') return [];
  const out = [];
  for (const v of Object.values(list)) {
    if (!v || typeof v !== 'object') continue;
    const name = pick(v, 'appname');
    const exe = pick(v, 'exe');
    if (typeof name !== 'string' || !name || typeof exe !== 'string') continue;
    const appid = pick(v, 'appid');
    const hidden = pick(v, 'ishidden');
    const options = pick(v, 'launchoptions');
    const entry = { name, exe, options: typeof options === 'string' ? options : '', appid: Number.isInteger(appid) ? appid : null, hidden: hidden === 1 };
    entry.launchId = steamLaunchId(entry);
    out.push(entry);
  }
  return out;
}

// Every shortcuts.vdf of every Steam user, for the usual Steam folders (native and Flatpak).
function shortcutFiles(home, realpath = (p) => { try { return fs.realpathSync(p); } catch { return null; } }) {
  const bases = ['.local/share/Steam', '.steam/steam', '.steam/root',
    '.var/app/com.valvesoftware.Steam/.local/share/Steam', '.var/app/com.valvesoftware.Steam/.steam/steam'];
  const seenBase = new Set();
  const files = [];
  for (const b of bases) {
    const rp = realpath(path.join(home, b));
    if (!rp || seenBase.has(rp)) continue;
    seenBase.add(rp);
    let users = [];
    try { users = fs.readdirSync(path.join(rp, 'userdata')); } catch { continue; }
    for (const u of users) {
      if (!/^\d+$/.test(u)) continue;
      const f = path.join(rp, 'userdata', u, 'config', 'shortcuts.vdf');
      try { if (fs.statSync(f).isFile()) files.push(f); } catch { /* none for this user */ }
    }
  }
  return files;
}

function read(home) {
  const out = [];
  const seen = new Set();
  for (const f of shortcutFiles(home)) {
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    for (const e of parse(buf)) {
      if (seen.has(e.launchId)) continue;
      seen.add(e.launchId);
      out.push(e);
    }
  }
  return out;
}

module.exports = { parse, parseBinaryVdf, crc32, shortId, steamLaunchId, shortcutFiles, read };
