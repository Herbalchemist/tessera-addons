'use strict';
// Files written the way Xodus Nexus 0.4.2 writes them, for the Xbox tests (not a test itself).
const fs = require('node:fs');
const path = require('node:path');

// ---- what Nexus writes (the same escaping rules as its source)
const desktopValue = (v) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
const desktopArgument = (v) => desktopValue(`"${v.replace(/%/g, '%%').replace(/["`$\\]/g, '\\$&')}"`);
const steamArgument = (v) => '"' + v.replace(/["`$\\]/g, '\\$&') + '"';
const shellQuote = (v) => `'${v.replace(/'/g, `'"'"'`)}'`;

function nexusInstall(home, { userData, profile = 'a1b2c3d4e5f6', games = [], desktop = true, applications = true }) {
  fs.mkdirSync(path.join(userData, 'shortcuts'), { recursive: true });
  const marker = `X-Xodus-Nexus-Profile=${profile}`;
  const script = path.join(userData, 'shortcuts', 'launch-game');
  const body = (game) => `#!/bin/sh\n# ${marker}\nunset APPIMAGE APPDIR ARGV0 OWD\nexec ${shellQuote('/opt/Xodus-Nexus.AppImage')} --nexus-profile ${shellQuote(userData)}${game ? ' --launch-game' : ''} "$@"\n`;
  fs.writeFileSync(script, body(true), { mode: 0o700 });
  const launcherScript = path.join(userData, 'shortcuts', 'launch-nexus');
  fs.writeFileSync(launcherScript, body(false), { mode: 0o700 });
  const apps = path.join(home, '.local/share/applications');
  const desk = path.join(home, 'Desktop');
  for (const g of games) {
    const entry = `[Desktop Entry]\nType=Application\nVersion=1.0\nName=${desktopValue(g.title)}\nComment=Play with Xodus Nexus\nExec=/bin/sh ${desktopArgument(script)} ${desktopArgument(g.id)}\nIcon=/x.png\nTerminal=false\nCategories=Game;\nStartupNotify=false\n${marker}\nX-Xodus-Nexus-Game=${g.id}\n`;
    if (applications) { fs.mkdirSync(apps, { recursive: true }); fs.writeFileSync(path.join(apps, `${g.title.replace(/[^A-Za-z0-9 ]/g, '')}.desktop`), entry); }
    if (desktop) { fs.mkdirSync(desk, { recursive: true }); fs.writeFileSync(path.join(desk, `${g.title.replace(/[^A-Za-z0-9 ]/g, '')}.desktop`), entry, { mode: 0o755 }); }
    // the invisible window-identity entry Nexus also writes
    fs.mkdirSync(apps, { recursive: true });
    fs.writeFileSync(path.join(apps, `xodus-nexus-game-${profile}-${g.id}.desktop`), entry.replace('Terminal=false', 'NoDisplay=true\nTerminal=false'));
  }
  return { script, launcherScript, marker };
}

// ---- a Steam shortcuts.vdf
function enc(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') parts.push(Buffer.concat([Buffer.from([1]), Buffer.from(k + '\0' + v + '\0')]));
    else if (typeof v === 'number') { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(Buffer.concat([Buffer.from([2]), Buffer.from(k + '\0'), b])); }
    else parts.push(Buffer.concat([Buffer.from([0]), Buffer.from(k + '\0'), enc(v)]));
  }
  return Buffer.concat([...parts, Buffer.from([8])]);
}
function writeShortcuts(home, entries) {
  const dir = path.join(home, '.local/share/Steam/userdata/4242/config');
  fs.mkdirSync(dir, { recursive: true });
  const map = Object.fromEntries(entries.map((e, i) => [String(i), e]));
  fs.writeFileSync(path.join(dir, 'shortcuts.vdf'), Buffer.concat([Buffer.from([0]), Buffer.from('shortcuts\0'), enc(map), Buffer.from([8])]));
}
const steamEntry = (name, script, id, appid) => ({
  appid, AppName: name, Exe: steamArgument('/bin/sh'), StartDir: steamArgument(path.dirname(script)), icon: '',
  LaunchOptions: steamArgument(script) + (id ? ' ' + steamArgument(id) : ''), IsHidden: 0, tags: { 0: 'Xodus Nexus' },
});

const ID1 = '0123456789abcdef', ID2 = 'fedcba9876543210', ID3 = '00000000000000aa';
module.exports = { desktopValue, desktopArgument, steamArgument, shellQuote, nexusInstall, enc, writeShortcuts, steamEntry, ID1, ID2, ID3 };
