// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The Xbox add-on's Xodus Nexus part: reading Nexus's files, and offering its games to Tessera
// marked as Xbox games (only to a Tessera that keeps them behind the PIN). The files are written
// the way Nexus 0.4.2's source writes them; no real Nexus, Steam or game is involved.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const N = require('../addons/xbox/lib/nexus');
const { desktopArgument, steamArgument, nexusInstall, writeShortcuts, steamEntry, ID1, ID2, ID3 } = require('./nexus-fixtures');

const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-')); made.push(d); return d; };

test('finds the games Nexus made entries for, from both folders, once each', () => {
  const home = mk();
  // a folder name with a space, a quote, a dollar sign and a percent sign: all must survive the escaping
  const userData = path.join(home, '.config', 'Xodus "Nexus" $x 100%');
  const { script } = nexusInstall(home, { userData, games: [{ id: ID1, title: 'Gears of War: E-Day' }, { id: ID2, title: 'Hades' }] });
  const found = N.findGames([path.join(home, '.local/share/applications'), path.join(home, 'Desktop')]);
  assert.deepStrictEqual(found.map((g) => g.id).sort(), [ID1, ID2].sort()); // not four: window-identity entries and the Desktop copies are not extra
  const g = found.find((x) => x.id === ID1);
  assert.strictEqual(g.title, 'Gears of War: E-Day');
  assert.strictEqual(g.file, '/bin/sh');
  assert.deepStrictEqual(g.args, [script, ID1]);
});

test('ignores look-alikes: wrong id, unrelated game, missing or foreign script, no markers', () => {
  const home = mk();
  const userData = path.join(home, 'nx');
  const { script, marker } = nexusInstall(home, { userData, games: [{ id: ID1, title: 'Real' }] });
  const apps = path.join(home, '.local/share/applications');
  const entry = (extra, exec) => `[Desktop Entry]\nType=Application\nName=Fake\nExec=${exec}\nCategories=Game;\n${extra}\n`;
  fs.writeFileSync(path.join(apps, 'idmismatch.desktop'), entry(`${marker}\nX-Xodus-Nexus-Game=${ID2}`, `/bin/sh ${desktopArgument(script)} ${desktopArgument(ID3)}`));
  fs.writeFileSync(path.join(apps, 'nomarker.desktop'), entry('', `/bin/sh ${desktopArgument(script)} ${desktopArgument(ID3)}`));
  fs.writeFileSync(path.join(apps, 'othergame.desktop'), entry('', '/usr/bin/supertuxkart'));
  fs.writeFileSync(path.join(apps, 'badid.desktop'), entry(`${marker}\nX-Xodus-Nexus-Game=not-an-id`, `/bin/sh ${desktopArgument(script)} not-an-id`));
  fs.writeFileSync(path.join(apps, 'missing.desktop'), entry(`${marker}\nX-Xodus-Nexus-Game=${ID3}`, `/bin/sh ${desktopArgument('/nope/shortcuts/launch-game')} ${desktopArgument(ID3)}`));
  const evil = path.join(home, 'evil', 'launch-game'); fs.mkdirSync(path.dirname(evil), { recursive: true }); fs.writeFileSync(evil, '#!/bin/sh\nrm -rf ~\n');
  fs.writeFileSync(path.join(apps, 'foreign.desktop'), entry(`${marker}\nX-Xodus-Nexus-Game=${ID3}`, `/bin/sh ${desktopArgument(evil)} ${desktopArgument(ID3)}`));
  const wrongProgram = entry(`${marker}\nX-Xodus-Nexus-Game=${ID3}`, `/bin/bash ${desktopArgument(script)} ${desktopArgument(ID3)}`);
  fs.writeFileSync(path.join(apps, 'wrongprogram.desktop'), wrongProgram);
  const found = N.findGames([apps]);
  assert.deepStrictEqual(found.map((g) => g.id), [ID1]);
});

test('Steam options: a game, the launcher itself, and things that are neither', () => {
  const script = '/home/u/.config/Xodus Nexus/shortcuts/launch-game';
  assert.deepStrictEqual(N.fromSteamOptions(steamArgument(script) + ' ' + steamArgument(ID1)), { kind: 'game', id: ID1 });
  assert.deepStrictEqual(N.fromSteamOptions(steamArgument('/h/shortcuts/launch-nexus')), { kind: 'launcher' });
  assert.strictEqual(N.fromSteamOptions(steamArgument(script) + ' ' + steamArgument('zz')), null);
  assert.strictEqual(N.fromSteamOptions(steamArgument('/h/other-script') + ' ' + steamArgument(ID1)), null);
  assert.strictEqual(N.fromSteamOptions('"unclosed'), null);
  assert.strictEqual(N.fromSteamOptions(''), null);
  assert.strictEqual(N.fromSteamOptions(undefined), null);
  const odd = '/h/100%% $x "q"/shortcuts/launch-game'; // %% is literal in Steam options
  assert.deepStrictEqual(N.fromSteamOptions(steamArgument(odd) + ' ' + steamArgument(ID1)), { kind: 'game', id: ID1 });
});

test('running(): finds a Nexus process, ignores look-alike arguments and other users', () => {
  const proc = mk();
  const add = (pid, argv) => { fs.mkdirSync(path.join(proc, String(pid)), { recursive: true }); fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0'); };
  add(101, ['/usr/bin/firefox', '--new-tab']);
  add(102, ['nano', '/home/u/xodus-nexus-notes.txt']);
  add(103, ['/usr/bin/bash']);
  fs.writeFileSync(path.join(proc, 'cpuinfo'), 'x');
  assert.strictEqual(N.running(proc, process.getuid()), false);
  add(104, ['/tmp/.mount_XodusABC/xodus-nexus', '--type=zygote']);
  assert.strictEqual(N.running(proc, process.getuid()), true);
  assert.strictEqual(N.running(proc, process.getuid() + 1), false); // someone else's process does not count
  assert.strictEqual(N.running(path.join(proc, 'nope')), false);
  const proc2 = mk(); fs.mkdirSync(path.join(proc2, '7')); fs.writeFileSync(path.join(proc2, '7', 'cmdline'), '/home/u/Apps/Xodus-Nexus-0.4.2-x86_64.AppImage\0--launch-game\0');
  assert.strictEqual(N.running(proc2, process.getuid()), true);
});

test('findGames: a script not named launch-game, and a hidden window-identity entry, are ignored', () => {
  const home = mk();
  const userData = path.join(home, 'nx');
  const { script, marker } = nexusInstall(home, { userData, games: [] });
  const apps = path.join(home, '.local/share/applications'); fs.mkdirSync(apps, { recursive: true });
  const other = path.join(userData, 'shortcuts', 'other-script');
  fs.copyFileSync(script, other); // right contents, wrong name
  const entry = (extra, sc) => `[Desktop Entry]\nType=Application\nName=X\nExec=/bin/sh ${desktopArgument(sc)} ${desktopArgument(ID1)}\n${marker}\nX-Xodus-Nexus-Game=${ID1}\n${extra}`;
  fs.writeFileSync(path.join(apps, 'badname.desktop'), entry('', other));
  fs.writeFileSync(path.join(apps, 'hidden.desktop'), entry('NoDisplay=true\n', script));
  assert.deepStrictEqual(N.findGames([apps]), []);
  fs.writeFileSync(path.join(apps, 'visible.desktop'), entry('', script));
  assert.deepStrictEqual(N.findGames([apps]).map((g) => g.id), [ID1]);
});

// ------------------------------------------------------------ the shard, as Tessera runs it
function activate(features, home) {
  const sources = [];
  const panels = [];
  const oldHome = process.env.HOME;
  const shardPath = require.resolve('../addons/xbox/index.js');
  delete require.cache[shardPath];
  const shard = require(shardPath);
  shard.activate(Object.freeze({
    apiVersion: 1, id: 'xbox', tesseraVersion: '0.41.0', dataDir: mk(), features,
    log: () => {}, addPanel: (p) => { panels.push(p); return true; }, addLibrarySource: (s) => { sources.push(s); return true; },
  }));
  const scan = () => {
    process.env.HOME = home;
    const got = [];
    try { for (const s of sources) s.scan((c) => got.push({ ...c, source: s.name })); } finally { process.env.HOME = oldHome; }
    return got;
  };
  return { shard, sources, panels, scan };
}

function nexusHome() {
  const home = mk();
  const userData = path.join(home, '.config', 'Xodus Nexus');
  const install = nexusInstall(home, { userData, games: [{ id: ID1, title: 'Gears of War E-Day' }, { id: ID2, title: 'Hades' }] });
  writeShortcuts(home, [
    steamEntry('Gears of War E-Day', install.script, ID1, -1111111), // also has a desktop entry: offered once
    steamEntry('Doom Eternal', install.script, ID3, -2222222),       // Steam shortcut only
    steamEntry('Xodus Nexus', install.launcherScript, null, -3333333), // the launcher itself: never a game
    { appid: -4444444, AppName: 'Some Other Game', Exe: '"/usr/bin/other"', LaunchOptions: '' }, // Tessera's own scan offers it
  ]);
  return { home, install };
}

test('nexusGames: desktop entries and Steam-only games, once each; the launcher and other shortcuts never', () => {
  const { home, install } = nexusHome();
  const { shard } = activate(['xbox-pin'], home);
  const steam = { file: '/usr/bin/steam', pre: [] };
  const games = shard.nexusGames(home, steam);
  assert.deepStrictEqual(games.map((g) => g.title).sort(), ['Doom Eternal', 'Gears of War E-Day', 'Hades']);
  const gears = games.find((g) => g.title === 'Gears of War E-Day');
  assert.deepStrictEqual([gears.file, gears.args], ['/bin/sh', [install.script, ID1]]);
  const doom = games.find((g) => g.title === 'Doom Eternal');
  assert.strictEqual(doom.file, '/usr/bin/steam');
  assert.deepStrictEqual(doom.args.slice(0, 1), ['-silent']);
  assert.match(doom.args[1], /^steam:\/\/rungameid\/\d+$/);
  // Steam's Flatpak, and no Steam at all
  assert.deepStrictEqual(shard.nexusGames(home, { file: '/usr/bin/flatpak', pre: ['run', 'com.valvesoftware.Steam'] }).find((g) => g.title === 'Doom Eternal').args.slice(0, 3), ['run', 'com.valvesoftware.Steam', '-silent']);
  assert.deepStrictEqual(shard.nexusGames(home, null).map((g) => g.title).sort(), ['Gears of War E-Day', 'Hades']);
});

test('a Tessera that keeps Xbox games behind the PIN gets them, marked xbox: true', () => {
  const { home } = nexusHome();
  const { sources, scan } = activate(['xbox-pin'], home);
  assert.strictEqual(sources.length, 1);
  const got = scan();
  assert.ok(got.length >= 2);
  assert.ok(got.every((g) => g.xbox === true && g.kind === 'game' && g.source === 'Xbox (Nexus)'));
  assert.ok(got.some((g) => g.title === 'Hades'));
  assert.ok(!got.some((g) => g.title === 'Xodus Nexus' || g.title === 'Some Other Game'));
});

test('an older Tessera (no xbox-pin) gets no games, and the page says to update', async () => {
  const { home } = nexusHome();
  for (const features of [undefined, [], ['something-else']]) {
    const { sources, panels } = activate(features, home);
    assert.strictEqual(sources.length, 0);
    const v = await panels[0].render();
    assert.ok(v.items.some((i) => /Update Tessera/.test(i.sub || '')));
  }
});

test('the page counts the Nexus games, and the counts fit what Tessera shows', async () => {
  const { panels } = activate(['xbox-pin'], mk());
  const v = await panels[0].render();
  const row = v.items.find((i) => i.label === 'Xbox games from Xodus Nexus');
  assert.match(row.sub, /^\d+ found\. Add them in Settings > Find games, once Settings > PIN > Allow Xbox games is on\.$/);
  for (const it of v.items) { assert.ok(it.label.length <= 80); if (it.sub) assert.ok(it.sub.length <= 240); }
});
