// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Which ways of playing Xbox PC games this machine can really do.
//
// Reads /proc and /sys and looks for programs; it changes nothing. The pieces are plain
// functions so they can be tried against made-up machines:
//   probe(opts)     what this machine has (processor, memory, graphics chips, tools)
//   recommend(caps) the routes, in the order worth trying, with plain-words reasons
//   vmPlan(caps)    how a Windows VM could split the processor and memory with the desktop
//
// Run it by hand:  bin/probe.js in this add-on's folder (add --json for a report to attach to a bug report)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GIB = 1024; // MiB

const rd = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
const ls = (root, rel) => { try { return fs.readdirSync(path.join(root, rel)); } catch { return []; } };
const hex = (s) => { const n = parseInt(String(s).trim(), 16); return Number.isFinite(n) ? n : null; };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const isExec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

// ------------------------------------------------------------------ the machine

function parseCpuList(s) {
  const out = [];
  for (const part of String(s || '').trim().split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b >= a && b - a < 4096) for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}

function probeCpu(root) {
  const txt = rd(root, 'proc/cpuinfo') || '';
  const blocks = txt.split(/\n\s*\n/).filter((b) => /^processor\s*:/m.test(b));
  const flags = new Set();
  const cores = new Set();
  let model = '';
  for (const b of blocks) {
    const f = /^flags\s*:\s*(.*)$/m.exec(b);
    if (f) for (const x of f[1].split(/\s+/)) flags.add(x);
    if (!model) { const m = /^model name\s*:\s*(.*)$/m.exec(b); if (m) model = m[1].trim(); }
    const pid = /^physical id\s*:\s*(\d+)/m.exec(b);
    const cid = /^core id\s*:\s*(\d+)/m.exec(b);
    if (pid && cid) cores.add(`${pid[1]}:${cid[1]}`);
  }
  const threads = blocks.length;
  // Which threads share a core (SMT siblings). A VM should get whole cores, not half of one.
  const seen = new Set();
  const siblings = [];
  for (let i = 0; i < threads; i++) {
    const list = parseCpuList(rd(root, `sys/devices/system/cpu/cpu${i}/topology/thread_siblings_list`));
    const group = list.length ? list : [i];
    const key = group.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    siblings.push(group);
  }
  siblings.sort((a, b) => a[0] - b[0]);
  return {
    model, threads, cores: cores.size || siblings.length || threads, siblings,
    virt: flags.has('vmx') ? 'vmx' : flags.has('svm') ? 'svm' : null,
  };
}

const VENDORS = { 0x1002: 'AMD', 0x10de: 'NVIDIA', 0x8086: 'Intel' };
const PCI = 'sys/bus/pci/devices';

// Graphics chips, and whether each could be handed to a VM on its own.
// A chip can only be passed through together with everything else in its IOMMU group, so the
// group must hold nothing but the chip, its sound/USB-C functions and bridges.
function probeGpus(root) {
  const out = [];
  for (const addr of ls(root, PCI)) {
    const cls = hex(rd(root, `${PCI}/${addr}/class`));
    if (cls === null || (cls >> 16) !== 0x03) continue;
    const vendorId = hex(rd(root, `${PCI}/${addr}/vendor`));
    const deviceId = hex(rd(root, `${PCI}/${addr}/device`));
    const boot = (rd(root, `${PCI}/${addr}/boot_vga`) || '').trim() === '1';
    let group = null;
    let driver = null;
    try { group = path.basename(fs.readlinkSync(path.join(root, PCI, addr, 'iommu_group'))); } catch { /* no IOMMU */ }
    try { driver = path.basename(fs.readlinkSync(path.join(root, PCI, addr, 'driver'))); } catch { /* unbound */ }
    const slot = addr.slice(0, addr.lastIndexOf('.'));
    const together = []; // functions that travel with the chip (sound, USB-C)
    const blockers = []; // anything else in the group
    if (group !== null) {
      for (const peer of ls(root, `sys/kernel/iommu_groups/${group}/devices`)) {
        if (peer === addr) continue;
        const pc = hex(rd(root, `${PCI}/${peer}/class`));
        const hi = pc === null ? null : pc >> 16;
        const sameSlot = peer.slice(0, peer.lastIndexOf('.')) === slot;
        if (hi === 0x06) continue; // bridges are fine
        if (sameSlot && (hi === 0x04 || hi === 0x0c || hi === 0x03)) together.push(peer);
        else blockers.push(peer);
      }
    }
    out.push({
      addr, vendor: VENDORS[vendorId] || `0x${(vendorId ?? 0).toString(16)}`, device: (deviceId ?? 0).toString(16).padStart(4, '0'),
      boot, driver, group, together, blockers,
      passable: !boot && group !== null && blockers.length === 0,
    });
  }
  return out;
}

function probeMemoryMiB(root) {
  const m = /^MemTotal:\s*(\d+)\s*kB/m.exec(rd(root, 'proc/meminfo') || '');
  return m ? Math.floor(Number(m[1]) / 1024) : 0;
}

const PATH_DIRS = ['usr/bin', 'usr/local/bin', 'bin', 'usr/sbin', 'sbin'];
function findBin(root, name) {
  for (const d of PATH_DIRS) { const p = path.join(root, d, name); if (isExec(p)) return `/${d}/${name}`; }
  return null;
}
function hasFlatpak(root, home, id) {
  return [`var/lib/flatpak/app/${id}`].some((r) => exists(path.join(root, r))) ||
    [`.local/share/flatpak/app/${id}`, `.var/app/${id}`].some((r) => exists(path.join(home, r)));
}

// Xodus Nexus ships as an AppImage plus a menu entry. Look for either, shallowly.
function findXodus(root, home) {
  const dirs = [path.join(home, '.local/share/applications'), path.join(root, 'usr/share/applications'),
    path.join(home, '.local/share/flatpak/exports/share/applications'), path.join(root, 'var/lib/flatpak/exports/share/applications')];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    if (names.some((n) => /xodus/i.test(n) && n.endsWith('.desktop'))) return true;
  }
  for (const d of ['Applications', 'Downloads', 'Tessera/Apps', '.local/bin', 'bin']) {
    let names = [];
    try { names = fs.readdirSync(path.join(home, d)); } catch { continue; }
    if (names.some((n) => /xodus/i.test(n) && /appimage$/i.test(n))) return true;
  }
  return false;
}

function probeTools(root, home) {
  const t = {};
  for (const n of ['steam', 'qemu-system-x86_64', 'virsh', 'virt-manager', 'podman', 'docker', 'sunshine', 'looking-glass-client', 'efibootmgr'])
    t[n] = findBin(root, n);
  t.moonlight = findBin(root, 'moonlight') || (hasFlatpak(root, home, 'com.moonlight_stream.Moonlight') ? 'flatpak' : null);
  const browser = ['google-chrome-stable', 'google-chrome', 'microsoft-edge-stable', 'microsoft-edge', 'chromium', 'chromium-browser']
    .map((n) => findBin(root, n)).find(Boolean) ||
    (['com.google.Chrome', 'com.microsoft.Edge', 'org.chromium.Chromium'].some((id) => hasFlatpak(root, home, id)) ? 'flatpak' : null);
  t.browser = browser || null;
  t.xodus = findXodus(root, home);
  return t;
}

// lsblk -J output (or null): drives that look like Windows (NTFS, or BitLocker-locked).
function windowsDrives(lsblkJson) {
  let data;
  try { data = JSON.parse(lsblkJson); } catch { return []; }
  const out = [];
  const walk = (list) => {
    for (const d of Array.isArray(list) ? list : []) {
      if (d && /^(ntfs|bitlocker)$/i.test(d.fstype || '')) out.push({ path: String(d.path || ''), label: d.label || null, fstype: String(d.fstype).toLowerCase(), size: d.size || null });
      if (d && d.children) walk(d.children);
    }
  };
  walk(data && data.blockdevices);
  return out;
}

const HANDHELD = /Jupiter|Galileo|ROG Ally|RC71|RC72|RC73|Legion Go|83E1|83L3|83N0|Claw|AYANEO|AYA NEO|ONEXPLAYER|ONEXFLY|GPD|Win ?(Max|Mini)|MSI Claw/i;

function probe(opts = {}) {
  const root = opts.root || '/';
  const home = opts.home || os.homedir();
  const cpu = probeCpu(root);
  const gpus = probeGpus(root);
  let lsblk = opts.lsblk;
  if (lsblk === undefined && root === '/') {
    try { lsblk = execFileSync('lsblk', ['-J', '-o', 'PATH,FSTYPE,LABEL,SIZE'], { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { lsblk = null; }
  }
  const dmi = {
    vendor: (rd(root, 'sys/class/dmi/id/sys_vendor') || '').trim(),
    product: (rd(root, 'sys/class/dmi/id/product_name') || '').trim(),
  };
  const cmdline = rd(root, 'proc/cmdline') || '';
  return {
    arch: opts.arch || process.arch,
    machine: dmi,
    handheld: HANDHELD.test(`${dmi.vendor} ${dmi.product}`),
    cpu,
    memoryMiB: probeMemoryMiB(root),
    kvm: exists(path.join(root, 'dev/kvm')),
    iommu: { groups: ls(root, 'sys/kernel/iommu_groups').length, onCmdline: /\b(intel_iommu=on|amd_iommu=on)\b/.test(cmdline) },
    gpus,
    tools: probeTools(root, home),
    windowsDrives: lsblk ? windowsDrives(lsblk) : [],
  };
}

// ------------------------------------------------------------ sharing with a VM

// How a Windows VM that owns a graphics chip could share the processor and memory.
// The VM gets a share (default 75%) of the memory and of the cores; the desktop keeps the rest,
// but never less than 6 GB or one core. Only whole cores are handed over (a core and its SMT
// sibling go together). Returns null if too little would be left for either side.
// The memory is meant to be set aside when the VM starts, never at boot, so nothing is held
// while Windows is off.
const VM_SHARE = 0.75;
const HOST_MIN_MIB = 6 * GIB;

function vmPlan(c, share = VM_SHARE) {
  const f = Number.isFinite(Number(share)) ? Math.min(0.9, Math.max(0.25, Number(share))) : VM_SHARE;
  const cores = c.cpu.siblings.slice();
  if (cores.length < 4) return null;                    // 3 cores for the VM is the least that makes sense
  const vmCount = Math.max(3, Math.min(cores.length - 1, Math.round(cores.length * f)));
  const hostCores = cores.slice(0, cores.length - vmCount);
  const vmCores = cores.slice(cores.length - vmCount);
  const total = c.memoryMiB;
  const ramMiB = Math.floor(Math.min(total * f, total - HOST_MIN_MIB) / GIB) * GIB;
  if (ramMiB < 8 * GIB) return null;
  const gpu = c.gpus.find((g) => g.passable);
  return {
    share: f,
    vcpuThreads: vmCores.flat().sort((a, b) => a - b),
    hostThreads: hostCores.flat().sort((a, b) => a - b),
    ramMiB,
    hugepages2M: ramMiB / 2,
    gpu: gpu ? { addr: gpu.addr, alsoPass: gpu.together, vendor: gpu.vendor, device: gpu.device } : null,
  };
}

// What an installer should do with the Windows-VM part on this machine:
//   blocked: it cannot work here (say why; nothing is harmed, it simply has nothing to run on)
//   warn:    it could work but this is a handheld; explain the cost and let the person decide
//   yes:     offer it normally
function vmOffer(c) {
  const vm = recommend(c).routes.find((r) => r.id === 'vm-gpu');
  if (vm.status === 'no') return { offer: 'blocked', reason: vm.why };
  if (c.handheld) {
    return { offer: 'warn', reason: 'This is a handheld. A Windows VM takes a large share of its memory and processor while it runs, drains the battery fast, and needs a second graphics chip (for example an external dock). Xbox Cloud Gaming or the Linux route are usually the better fit.' };
  }
  return { offer: 'yes', reason: null };
}

// ------------------------------------------------------------------- the routes

const STATUS_RANK = { ready: 0, setup: 1, no: 2 };
const SPEED_RANK = { full: 0, 'near-full': 1, network: 2 };

function recommend(c) {
  const routes = [];
  const add = (r) => routes.push(r);

  // 1. Xbox PC games run on Linux itself (Proton): no Windows, no VM, so no overhead and no
  //    special hardware. Young community project, so only some games work.
  {
    const r = { id: 'linux-xbox', title: 'Xbox PC games on Linux (no Windows)', speed: 'full', effort: 1, needs: [], note: null };
    if (c.arch !== 'x64') { r.status = 'no'; r.why = 'The Xbox runtime for Linux is only built for 64-bit Intel/AMD processors.'; }
    else if (c.tools.xodus) { r.status = 'ready'; r.effort = 0; r.why = 'Installed. Runs at full speed on any graphics chip Tessera supports.'; }
    else if (c.tools.steam) { r.status = 'setup'; r.why = 'Runs Xbox PC games you own through Proton at full speed, on any graphics chip Tessera supports.'; r.needs.push('Install Xodus Nexus and sign in with your Microsoft account'); }
    else { r.status = 'setup'; r.why = 'Needs the Steam client (the normal one, not the Flatpak) for its runtime.'; r.needs.push('Install Steam, then Xodus Nexus'); r.effort = 2; }
    r.note = 'A young community project: only some games work, you need your own licence, and Microsoft may object to it.';
    add(r);
  }

  // 2. Xbox Cloud Gaming in a browser: any machine that can play video.
  {
    const r = { id: 'cloud', title: 'Xbox Cloud Gaming in a browser', speed: 'network', effort: 1, needs: [], note: null };
    r.status = c.tools.browser ? 'ready' : 'setup';
    r.why = 'Works on every machine that can show video. Nothing is installed on your drives.';
    if (!c.tools.browser) { r.needs.push('A Chrome-based browser (Chrome, Edge or Chromium)'); }
    r.note = 'Needs internet and your own subscription that includes cloud gaming. Not every game is offered.';
    add(r);
  }

  // 3. Stream from a Windows PC or an Xbox elsewhere in the home.
  {
    const r = { id: 'stream', title: 'Stream from a Windows PC or Xbox at home', speed: 'network', effort: 2, needs: ['A Windows PC or Xbox on the same network, switched on'], note: null };
    // Whether that other device exists and is on cannot be known from here, so this is never "ready".
    r.status = 'setup';
    r.why = 'The other device does the heavy work, this one shows the picture. No special hardware needed here.';
    if (!c.tools.moonlight && !c.tools.steam) r.needs.push('Moonlight, or Steam (Remote Play)');
    add(r);
  }

  // 4. A Windows VM that owns a graphics chip.
  {
    const r = { id: 'vm-gpu', title: 'Windows VM with its own graphics chip', speed: 'near-full', effort: 3, needs: [], hard: [], fixable: [], note: null };
    const plan = vmPlan(c);
    const display = c.gpus.length;
    const cand = c.gpus.find((g) => g.passable);
    if (c.arch !== 'x64') r.hard.push('Needs a 64-bit Intel/AMD processor.');
    if (display === 0) r.hard.push('No graphics chip was found.');
    else if (display < 2) r.hard.push(c.handheld
      ? 'This device has one graphics chip, and the desktop needs it. (Handhelds can\'t do this.)'
      : 'Only one graphics chip: the desktop needs it, so none is left for Windows. (A second card or the processor\'s built-in graphics would do.)');
    else if (c.iommu.groups > 0 && !cand) r.hard.push('No spare graphics chip can be handed over on its own: it shares a hardware group with other parts.');
    if (!plan) r.hard.push('Not enough memory or processor cores to share with Windows (about 16 GB and 4 cores at least).');
    if (!c.cpu.virt) r.fixable.push('Switch on Intel VT-x / AMD-V (called SVM) in the firmware setup.');
    else if (!c.kvm) r.fixable.push('Virtualization is not available to Linux (/dev/kvm is missing).');
    if (c.iommu.groups === 0) r.fixable.push('Switch on IOMMU (VT-d / AMD-Vi) in the firmware setup, then add the kernel flag.');
    if (!(c.tools['qemu-system-x86_64'] && c.tools.virsh)) r.fixable.push('Install the virtualization tools (QEMU and libvirt).');
    if (r.hard.length) { r.status = 'no'; r.why = r.hard[0]; }
    else {
      r.status = 'setup';
      r.why = 'Windows gets a graphics chip of its own and runs close to full speed, shown in a window or streamed back to this desktop.';
      r.needs.push(...r.fixable, 'Your own Windows licence and installation');
      if (cand) r.detail = { gpu: `${cand.vendor} ${cand.device} at ${cand.addr}`, plan };
    }
    r.note = 'Games whose anti-cheat refuses to run in a VM will not start, however good the hardware.';
    delete r.hard; delete r.fixable;
    add(r);
  }

  // 5. Windows on a drive of its own, chosen at start-up.
  {
    const found = c.windowsDrives;
    const r = { id: 'dual-boot', title: 'Windows on its own drive (restart to switch)', speed: 'full', effort: found.length ? 2 : 3, needs: [], note: null };
    r.status = c.arch === 'x64' ? 'setup' : 'no';
    r.why = found.length
      ? `Full speed with nothing in between. Found ${found.length} Windows-style drive${found.length === 1 ? '' : 's'}.`
      : 'Full speed with nothing in between, but you restart to switch.';
    if (!found.length) r.needs.push('Windows installed on a drive of its own');
    r.note = 'Windows may take over the boot menu when it updates. Install it on a different drive from Tessera.';
    add(r);
  }

  routes.sort((a, b) =>
    STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.effort - b.effort || SPEED_RANK[a.speed] - SPEED_RANK[b.speed]);
  const usable = routes.filter((r) => r.status !== 'no');
  const fastest = [...usable].sort((a, b) => SPEED_RANK[a.speed] - SPEED_RANK[b.speed] || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.effort - b.effort)[0] || null;
  return { routes, easiest: usable[0] ? usable[0].id : null, fastest: fastest ? fastest.id : null };
}

// -------------------------------------------------------------------------- CLI

function describe(c, rec) {
  const gb = (m) => `${Math.round(m / 1024)} GB`;
  const lines = [];
  lines.push('Ways to play Xbox PC games on this machine');
  lines.push('');
  lines.push(`Machine: ${[c.machine.vendor, c.machine.product].filter(Boolean).join(' ') || 'unknown'}${c.handheld ? ' (handheld)' : ''}`);
  lines.push(`Processor: ${c.cpu.model || 'unknown'}, ${c.cpu.cores} cores / ${c.cpu.threads} threads; virtualization ${c.cpu.virt ? 'on' : 'off or missing'}${c.kvm ? '' : ' (no /dev/kvm)'}`);
  lines.push(`Memory: ${gb(c.memoryMiB)}`);
  lines.push(`Graphics: ${c.gpus.length ? c.gpus.map((g) => `${g.vendor} ${g.device}${g.boot ? ' (runs the screen)' : ''}${g.passable ? ' (could go to a VM)' : ''}`).join(', ') : 'none found'}`);
  lines.push(`IOMMU: ${c.iommu.groups ? `on (${c.iommu.groups} groups)` : 'off'}`);
  lines.push('');
  const label = { ready: 'ready', setup: 'needs setup', no: 'not possible here' };
  rec.routes.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title} - ${label[r.status]}`);
    lines.push(`   ${r.why}`);
    for (const n of r.needs) lines.push(`   - ${n}`);
    if (r.detail && r.detail.plan) {
      const p = r.detail.plan;
      lines.push(`   Suggested split: Windows gets threads ${p.vcpuThreads.join(',')} and ${p.ramMiB / 1024} GB; the desktop keeps threads ${p.hostThreads.join(',')} and the rest.`);
      lines.push(`   Graphics chip for Windows: ${r.detail.gpu}`);
    }
    if (r.note) lines.push(`   Note: ${r.note}`);
    lines.push('');
  });
  const byId = Object.fromEntries(rec.routes.map((r) => [r.id, r.title]));
  if (rec.easiest) lines.push(`Easiest to start: ${byId[rec.easiest]}`);
  if (rec.fastest) lines.push(`Fastest: ${byId[rec.fastest]}`);
  return lines.join('\n');
}

module.exports = { probe, recommend, vmPlan, vmOffer, describe, parseCpuList, windowsDrives };

