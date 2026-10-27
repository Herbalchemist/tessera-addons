#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The same look the add-on's page takes, for a terminal (Desktop Mode). It changes nothing.
//   node bin/probe.js          readable summary
//   node bin/probe.js --json   the raw report (attach it to a bug report)
// Without Node installed, Tessera's own Electron runs it:
//   ELECTRON_RUN_AS_NODE=1 /usr/lib/tessera/launcher/node_modules/electron/dist/electron bin/probe.js
const routes = require('../lib/xbox-routes');

const caps = routes.probe();
const rec = routes.recommend(caps);
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ caps, recommendation: rec }, null, 2) + '\n');
else process.stdout.write(routes.describe(caps, rec) + '\n');
