// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The Xbox add-on as Tessera runs it: activate() with a stand-in for Tessera's add-on API (version 1),
// then its page and actions. The look it takes is of whatever machine runs the test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbox-shard-'));
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function start() {
  const panels = [];
  const logs = [];
  const shard = require('../addons/xbox/index.js');
  shard.activate(Object.freeze({
    apiVersion: 1, id: 'xbox', tesseraVersion: '0.25.0', dataDir,
    log: (...a) => logs.push(a.join(' ')),
    addPanel: (p) => { panels.push(p); return true; },
    addLibrarySource: () => true,
  }));
  return { panels, logs };
}

// What Tessera keeps of a view (shards.js cleanView): short strings, and actions with simple names.
const ACTION_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const fitsTessera = (v) => {
  assert.ok(v && typeof v === 'object');
  if (v.body !== undefined) assert.ok(typeof v.body === 'string' && v.body.length <= 1500, `body is ${v.body.length} long`);
  for (const it of v.items || []) {
    assert.ok(typeof it.label === 'string' && it.label.length <= 80, it.label);
    if (it.sub) assert.ok(it.sub.length <= 240);
    if (it.action) assert.match(it.action, ACTION_RE);
  }
};

test('activate adds one page and says so in the log', () => {
  const { panels, logs } = start();
  assert.strictEqual(panels.length, 1);
  assert.strictEqual(panels[0].title, 'Xbox PC Games Setup');
  assert.deepStrictEqual(logs, ['ready']);
});

test('the page lists every route, then the shortcuts, all within what Tessera shows', async () => {
  const [p] = start().panels;
  const v = await p.render();
  fitsTessera(v);
  const routes = v.items.filter((i) => i.action.startsWith('route:')).map((i) => i.action.slice(6)).sort();
  assert.deepStrictEqual(routes, ['cloud', 'dual-boot', 'linux-xbox', 'stream', 'vm-gpu']);
  assert.ok(v.items.some((i) => i.action === 'cloud'), "Tessera's browser counts, so cloud gaming is offered");
  assert.match(v.body, /Easiest to start/);
});

test('each route opens a page of its own; links open in the browser; a report is saved', async () => {
  const [p] = start().panels;
  const v = await p.render();
  for (const it of v.items.filter((i) => i.action.startsWith('route:'))) {
    const d = await p.action(it.action);
    fitsTessera(d);
    assert.ok(d.items.length > 0);
  }
  const cloud = await p.action('route:cloud');
  assert.match(cloud.body, /hasn't been tried with Xbox Cloud Gaming yet/);
  assert.deepStrictEqual(await p.action('cloud'), { openUrl: 'https://www.xbox.com/play' });
  assert.match((await p.action('xodus')).openUrl, /^https:\/\/github\.com\//);
  const r = await p.action('report');
  const file = /Report saved: (.+)$/.exec(r.message)[1];
  assert.ok(file.startsWith(dataDir));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.caps && saved.recommendation && saved.tessera === '0.25.0');
  assert.deepStrictEqual(await p.action('route:nope'), { message: "That isn't there any more." });
});

test('a route that can\'t work here never says nothing else is needed', async () => {
  const [p] = start().panels;
  const v = await p.render();
  for (const it of v.items.filter((i) => i.action.startsWith('route:'))) {
    if (it.sub !== 'Not possible here') continue;
    const d = await p.action(it.action);
    assert.ok(!d.items.some((x) => x.label === 'Nothing else is needed'), it.label);
    assert.doesNotMatch(d.body, /full speed|streamed/);
  }
});
