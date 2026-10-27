// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Xbox and Game Pass for Tessera: which ways of playing them this machine can really do, what each
// one still needs, and a one-press start for the ones that need nothing else.
//
// It only looks (processor, memory, graphics, IOMMU groups, drives, installed programs); it changes
// nothing on the machine. Games added to Steam by Xodus Nexus are found by Tessera's own scan
// (Settings > Find games), so nothing here has to list them.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const routes = require('./lib/xbox-routes');

const CLOUD_URL = 'https://www.xbox.com/play';
const XODUS_URL = 'https://github.com/domsvoboda/xodus-nexus';
const STATUS = { ready: 'Ready', setup: 'Needs setup', no: 'Not possible here' };
const SPEED = { full: 'full speed', 'near-full': 'close to full speed', network: 'streamed over the internet' };

// lsblk without blocking Tessera while it runs.
const lsblk = () => new Promise((resolve) => {
  execFile('lsblk', ['-J', '-o', 'PATH,FSTYPE,LABEL,SIZE'], { timeout: 4000, encoding: 'utf8' }, (err, out) => resolve(err ? null : out));
});

async function look() {
  const caps = routes.probe({ lsblk: await lsblk() });
  // Tessera's own browser is Chromium-based, so it counts as one (see the note on the cloud route).
  if (!caps.tools.browser) caps.tools.browser = 'tessera';
  return { caps, rec: routes.recommend(caps) };
}

function summary(caps, rec) {
  const gb = Math.round(caps.memoryMiB / 1024);
  const byId = Object.fromEntries(rec.routes.map((r) => [r.id, r.title]));
  return [
    `${[caps.machine.vendor, caps.machine.product].filter(Boolean).join(' ') || 'This machine'}${caps.handheld ? ' (a handheld)' : ''}: ${caps.cpu.cores} cores, ${gb} GB, ${caps.gpus.length || 'no'} graphics chip${caps.gpus.length === 1 ? '' : 's'}.`,
    rec.easiest ? `Easiest to start: ${byId[rec.easiest]}.` : '',
    rec.fastest && rec.fastest !== rec.easiest ? `Fastest: ${byId[rec.fastest]}.` : '',
  ].filter(Boolean).join('\n');
}

function routeView(r) {
  const lines = [r.why];
  if (r.detail && r.detail.plan) {
    const p = r.detail.plan;
    lines.push(`Suggested split: Windows gets ${p.vcpuThreads.length} threads and ${p.ramMiB / 1024} GB while it runs; the desktop keeps ${p.hostThreads.length} threads and the rest. Graphics chip for Windows: ${r.detail.gpu}.`);
  }
  if (r.note) lines.push(r.note);
  if (r.id === 'cloud') lines.push('Tessera\'s browser is Chromium-based, but it hasn\'t been tried with Xbox Cloud Gaming yet. If xbox.com/play refuses it, install Chrome or Edge from Apps.');
  const items = r.needs.map((n) => ({ label: n, sub: 'still needed' }));
  if (r.id === 'cloud' && r.status !== 'no') items.unshift({ label: 'Play in Tessera\'s browser', sub: 'xbox.com/play', action: 'cloud' });
  if (r.id === 'linux-xbox' && r.status !== 'no') items.push({ label: 'About Xodus Nexus', sub: 'its page, in Tessera\'s browser', action: 'xodus' });
  if (!items.length) items.push({ label: r.status === 'no' ? 'Not something this machine can do' : 'Nothing else is needed' });
  const head = r.status === 'no' ? `${r.title}: ${STATUS.no}.` : `${r.title}: ${STATUS[r.status]}, ${SPEED[r.speed]}.`;
  return { body: `${head}\n\n${lines.join('\n\n')}`, items };
}

module.exports = {
  activate(tessera) {
    let last = null;
    tessera.addPanel({
      title: 'Xbox and Game Pass',
      async render() {
        last = await look();
        const { caps, rec } = last;
        const items = rec.routes.map((r) => ({ label: r.title, sub: STATUS[r.status], action: `route:${r.id}` }));
        if (rec.routes.some((r) => r.id === 'cloud' && r.status !== 'no')) items.push({ label: 'Play Xbox Cloud Gaming now', sub: 'in Tessera\'s browser', action: 'cloud' });
        items.push({ label: 'Save a report', sub: 'for a bug report', action: 'report' });
        return { body: summary(caps, rec), items };
      },
      async action(name) {
        if (name === 'cloud') return { openUrl: CLOUD_URL };
        if (name === 'xodus') return { openUrl: XODUS_URL };
        if (!last) last = await look();
        if (name === 'report') {
          const file = path.join(tessera.dataDir, `xbox-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
          fs.writeFileSync(file, JSON.stringify({ tessera: tessera.tesseraVersion, caps: last.caps, recommendation: last.rec }, null, 2));
          return { message: `Report saved: ${file}` };
        }
        const m = /^route:([a-z-]+)$/.exec(name);
        const r = m && last.rec.routes.find((x) => x.id === m[1]);
        return r ? routeView(r) : { message: 'That isn\'t there any more.' };
      },
    });
    tessera.log('ready');
  },
};
