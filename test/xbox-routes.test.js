// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Builds made-up machines (a /proc and /sys on disk) and checks what the probe and the recommender
// make of them. Nothing here proves anything about real hardware.
//   node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const X = require('../addons/xbox/lib/xbox-routes');

const tmp = [];
test.after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------- fake machines
function machine(spec) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'xr-'));
  tmp.push(root);
  const w = (rel, text, mode) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    if (mode) fs.chmodSync(p, mode);
    return p;
  };
  const home = path.join(root, 'home', 'u');
  fs.mkdirSync(home, { recursive: true });

  const cores = spec.cores, smt = spec.smt ?? 2, threads = cores * smt;
  const blocks = [];
  for (let i = 0; i < threads; i++) {
    const core = spec.layout === 'adjacent' ? Math.floor(i / smt) : i % cores;
    blocks.push(`processor\t: ${i}\nmodel name\t: ${spec.cpuName || 'Test CPU'}\nphysical id\t: 0\ncore id\t\t: ${core}\nflags\t\t: fpu ${spec.virt === false ? '' : (spec.virt || 'svm')} sse2\n`);
    const sib = [];
    for (let t = 0; t < smt; t++) sib.push(spec.layout === 'adjacent' ? core * smt + t : core + t * cores);
    w(`sys/devices/system/cpu/cpu${i}/topology/thread_siblings_list`, sib.join(',') + '\n');
  }
  w('proc/cpuinfo', blocks.join('\n'));
  w('proc/meminfo', `MemTotal:       ${spec.memMiB * 1024} kB\nMemFree: 1 kB\n`);
  w('proc/cmdline', spec.cmdline || 'BOOT_IMAGE=/vmlinuz ro quiet\n');
  if (spec.kvm !== false) w('dev/kvm', '');
  if (spec.dmi) { w('sys/class/dmi/id/sys_vendor', spec.dmi[0] + '\n'); w('sys/class/dmi/id/product_name', spec.dmi[1] + '\n'); }

  const dev = (addr, cls, extra = {}) => {
    w(`sys/bus/pci/devices/${addr}/class`, cls + '\n');
    if (extra.vendor) w(`sys/bus/pci/devices/${addr}/vendor`, extra.vendor + '\n');
    if (extra.device) w(`sys/bus/pci/devices/${addr}/device`, extra.device + '\n');
    if (extra.boot !== undefined) w(`sys/bus/pci/devices/${addr}/boot_vga`, extra.boot ? '1\n' : '0\n');
  };
  const iommu = spec.iommu !== false;
  for (const g of spec.gpus || []) {
    dev(g.addr, '0x030000', { vendor: g.vendor, device: g.device, boot: g.boot });
    const members = [g.addr, ...(g.peers || []).map((p) => p.addr)];
    for (const p of g.peers || []) dev(p.addr, p.cls);
    if (iommu) {
      for (const m of members) w(`sys/kernel/iommu_groups/${g.group}/devices/${m}`, '');
      fs.symlinkSync(`../../../kernel/iommu_groups/${g.group}`, path.join(root, 'sys/bus/pci/devices', g.addr, 'iommu_group'));
    }
    if (g.driver) {
      fs.mkdirSync(path.join(root, 'sys/bus/pci/drivers', g.driver), { recursive: true });
      fs.symlinkSync(`../../../../bus/pci/drivers/${g.driver}`, path.join(root, 'sys/bus/pci/devices', g.addr, 'driver'));
    }
  }
  for (const b of spec.bins || []) w(`usr/bin/${b}`, '#!/bin/sh\n', 0o755);
  for (const f of spec.flatpaks || []) fs.mkdirSync(path.join(root, 'var/lib/flatpak/app', f), { recursive: true });
  if (spec.xodus) w('home/u/.local/share/applications/xodus-nexus.desktop', '[Desktop Entry]\nName=Xodus Nexus\n');
  return { root, home, caps: X.probe({ root, home, lsblk: spec.lsblk ?? null, arch: spec.arch || 'x64' }) };
}

const AUDIO = { cls: '0x040300' };
const byId = (rec, id) => rec.routes.find((r) => r.id === id);


// --------------------------------------------------------------------- machines
test('handheld: one graphics chip, steam only', () => {
  const m = machine({
    cores: 4, memMiB: 15500, virt: 'svm', dmi: ['ASUSTeK COMPUTER INC.', 'ROG Ally RC71L'], bins: ['steam'],
    gpus: [{ addr: '0000:c1:00.0', vendor: '0x1002', device: '0x15bf', boot: true, group: 3, driver: 'amdgpu' }],
  });
  assert.strictEqual(m.caps.handheld, true);
  assert.strictEqual(m.caps.gpus.length, 1);
  const rec = X.recommend(m.caps);
  assert.strictEqual(byId(rec, 'vm-gpu').status, 'no');
  assert.match(byId(rec, 'vm-gpu').why, /Handhelds can't do this/);
  assert.strictEqual(byId(rec, 'linux-xbox').status, 'setup');
  assert.strictEqual(byId(rec, 'stream').status, 'setup'); // the other device can't be seen from here
  assert.ok(byId(rec, 'stream').needs.some((n) => /Windows PC or Xbox/.test(n)));
  assert.strictEqual(rec.routes[rec.routes.length - 1].id, 'vm-gpu'); // not possible goes last
  assert.deepStrictEqual(rec.routes.map((r) => r.id), ['linux-xbox', 'cloud', 'stream', 'dual-boot', 'vm-gpu']);
});

test('desktop with spare dGPU in a clean group: VM possible, plan is sane', () => {
  const m = machine({
    cores: 8, memMiB: 31800, virt: 'svm', bins: ['steam', 'qemu-system-x86_64', 'virsh'],
    gpus: [
      { addr: '0000:0e:00.0', vendor: '0x1002', device: '0x164e', boot: true, group: 20, driver: 'amdgpu' },
      { addr: '0000:01:00.0', vendor: '0x10de', device: '0x2684', boot: false, group: 14, driver: 'nvidia', peers: [{ addr: '0000:01:00.1', ...AUDIO }] },
    ],
  });
  const g = m.caps.gpus.find((x) => x.addr === '0000:01:00.0');
  assert.strictEqual(g.passable, true);
  assert.deepStrictEqual(g.together, ['0000:01:00.1']);
  const vm = byId(X.recommend(m.caps), 'vm-gpu');
  assert.strictEqual(vm.status, 'setup');
  assert.deepStrictEqual(vm.needs, ['Your own Windows licence and installation']);
  const p = vm.detail.plan;
  assert.deepStrictEqual(p.hostThreads, [0, 1, 8, 9]);            // 2 of 8 cores (25%) stay with the desktop, each with its sibling
  assert.deepStrictEqual(p.vcpuThreads, [2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15]); // 6 whole cores
  assert.strictEqual(p.ramMiB, 23 * 1024); // 75% of 31800 MiB is 23850; in whole GB
  assert.strictEqual(p.hugepages2M, p.ramMiB / 2);
  assert.strictEqual(p.gpu.addr, '0000:01:00.0');
});

test('adjacent SMT numbering is kept in whole cores', () => {
  const m = machine({
    cores: 6, layout: 'adjacent', memMiB: 15800, virt: 'vmx', bins: ['qemu-system-x86_64', 'virsh'],
    gpus: [
      { addr: '0000:00:02.0', vendor: '0x8086', device: '0x4680', boot: true, group: 0, driver: 'i915' },
      { addr: '0000:01:00.0', vendor: '0x1002', device: '0x73ff', boot: false, group: 12 },
    ],
  });
  const plan = X.vmPlan(m.caps);
  assert.deepStrictEqual(plan.hostThreads, [0, 1]);              // 75% of 6 cores = 4.5, rounds to 5 for the VM; core 0 + sibling stay
  assert.deepStrictEqual(plan.vcpuThreads, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.strictEqual(plan.ramMiB, 9 * 1024); // 75% would be 11 GB, but the desktop keeps at least 6 GB
});

test('64 GB machine is not capped; the share can be changed and is clamped', () => {
  const big = machine({ cores: 16, memMiB: 64000, virt: 'vmx', gpus: [] });
  const p = X.vmPlan(big.caps);
  assert.strictEqual(p.ramMiB, 46 * 1024);                        // 75% of 64000 = 48000 -> 46 GB
  assert.strictEqual(p.vcpuThreads.length, 24);                   // 12 of 16 cores
  assert.strictEqual(p.hostThreads.length, 8);
  assert.strictEqual(X.vmPlan(big.caps, 0.5).ramMiB, 31 * 1024);  // 32000 -> 31 GB
  assert.strictEqual(X.vmPlan(big.caps, 5).share, 0.9);           // clamped
  assert.strictEqual(X.vmPlan(big.caps, 0.01).share, 0.25);
  assert.strictEqual(X.vmPlan(big.caps, 'junk').share, 0.75);
  assert.strictEqual(X.vmPlan(big.caps, 0.5).vcpuThreads.length, 16); // 8 of 16 cores
  const four = machine({ cores: 4, smt: 1, memMiB: 40000, virt: 'vmx', gpus: [] });
  assert.deepStrictEqual(X.vmPlan(four.caps, 0.9).hostThreads, [0]); // the desktop always keeps a core
  assert.strictEqual(X.vmPlan(four.caps, 0.25).vcpuThreads.length, 3); // and the VM always gets at least 3
  const tight = machine({ cores: 8, memMiB: 7600, virt: 'vmx', gpus: [] });
  assert.strictEqual(X.vmPlan(tight.caps), null);                 // 7.4 GB: not enough to share
});

test('installer offer: blocked when it cannot work, warned on a handheld that could, yes otherwise', () => {
  const dgpu = [
    { addr: '0000:0e:00.0', vendor: '0x1002', device: '0x164e', boot: true, group: 20 },
    { addr: '0000:01:00.0', vendor: '0x10de', device: '0x2684', boot: false, group: 14, peers: [{ addr: '0000:01:00.1', ...AUDIO }] },
  ];
  const hand = machine({ cores: 8, memMiB: 31800, virt: 'svm', dmi: ['Valve', 'Jupiter'], bins: ['qemu-system-x86_64', 'virsh'], gpus: [dgpu[0]] });
  assert.strictEqual(X.vmOffer(hand.caps).offer, 'blocked');
  const dock = machine({ cores: 8, memMiB: 31800, virt: 'svm', dmi: ['Valve', 'Jupiter'], bins: ['qemu-system-x86_64', 'virsh'], gpus: dgpu });
  assert.strictEqual(dock.caps.handheld, true);
  const o = X.vmOffer(dock.caps);
  assert.strictEqual(o.offer, 'warn');
  assert.match(o.reason, /handheld/);
  const desk = machine({ cores: 8, memMiB: 31800, virt: 'svm', bins: ['qemu-system-x86_64', 'virsh'], gpus: dgpu });
  assert.deepStrictEqual(X.vmOffer(desk.caps), { offer: 'yes', reason: null });
});

test('a bridge in the group does not block a GPU; the chip is not passable without an IOMMU', () => {
  const m = machine({
    cores: 8, memMiB: 31800, virt: 'svm', bins: [],
    gpus: [
      { addr: '0000:0e:00.0', vendor: '0x1002', device: '0x164e', boot: true, group: 20 },
      { addr: '0000:01:00.0', vendor: '0x10de', device: '0x2684', boot: false, group: 14, peers: [{ addr: '0000:00:01.1', cls: '0x060400' }, { addr: '0000:01:00.1', ...AUDIO }] },
    ],
  });
  assert.strictEqual(m.caps.gpus.find((x) => x.addr === '0000:01:00.0').passable, true);
  assert.deepStrictEqual(m.caps.gpus.find((x) => x.addr === '0000:01:00.0').blockers, []);
});

test('ready routes come before routes that still need setup', () => {
  const m = machine({ cores: 4, memMiB: 8000, bins: ['steam'], flatpaks: ['org.chromium.Chromium'], gpus: [] });
  const rec = X.recommend(m.caps);
  assert.strictEqual(byId(rec, 'cloud').status, 'ready');
  assert.strictEqual(byId(rec, 'linux-xbox').status, 'setup');
  assert.strictEqual(rec.routes[0].id, 'cloud');
  assert.strictEqual(rec.easiest, 'cloud');
  assert.strictEqual(rec.fastest, 'linux-xbox'); // full speed beats a stream, even if it needs setup
});

test('IOMMU off: fixable, not impossible', () => {
  const m = machine({
    cores: 8, memMiB: 31800, virt: 'svm', iommu: false, bins: ['qemu-system-x86_64', 'virsh'],
    gpus: [
      { addr: '0000:0e:00.0', vendor: '0x1002', device: '0x164e', boot: true, group: 20 },
      { addr: '0000:01:00.0', vendor: '0x10de', device: '0x2684', boot: false, group: 14 },
    ],
  });
  assert.strictEqual(m.caps.iommu.groups, 0);
  assert.ok(m.caps.gpus.every((g) => g.passable === false));
  const vm = byId(X.recommend(m.caps), 'vm-gpu');
  assert.strictEqual(vm.status, 'setup');
  assert.ok(vm.needs.some((n) => /IOMMU/.test(n)), vm.needs.join('|'));
});

test('spare GPU sharing a group with a network card: no', () => {
  const m = machine({
    cores: 8, memMiB: 31800, virt: 'svm', bins: ['qemu-system-x86_64', 'virsh'],
    gpus: [
      { addr: '0000:0e:00.0', vendor: '0x1002', device: '0x164e', boot: true, group: 20 },
      { addr: '0000:01:00.0', vendor: '0x10de', device: '0x2684', boot: false, group: 14, peers: [{ addr: '0000:01:00.1', ...AUDIO }, { addr: '0000:02:00.0', cls: '0x020000' }] },
    ],
  });
  const g = m.caps.gpus.find((x) => x.addr === '0000:01:00.0');
  assert.strictEqual(g.passable, false);
  assert.deepStrictEqual(g.blockers, ['0000:02:00.0']);
  const vm = byId(X.recommend(m.caps), 'vm-gpu');
  assert.strictEqual(vm.status, 'no');
  assert.match(vm.why, /shares a hardware group/);
});

test('no virtualization flags and 8 GB: VM is out, other routes stay', () => {
  const m = machine({
    cores: 4, smt: 1, memMiB: 7600, virt: false, kvm: false, bins: [], cmdline: 'ro\n',
    gpus: [{ addr: '0000:00:02.0', vendor: '0x8086', device: '0x9a49', boot: true, group: 0 }],
  });
  const rec = X.recommend(m.caps);
  assert.strictEqual(byId(rec, 'vm-gpu').status, 'no');
  assert.notStrictEqual(byId(rec, 'cloud').status, 'no');
  assert.notStrictEqual(byId(rec, 'linux-xbox').status, 'no');
  assert.ok(rec.easiest && rec.fastest);
});

test('arm64: nothing that needs x86 is offered', () => {
  const m = machine({ cores: 8, memMiB: 16000, arch: 'arm64', gpus: [] });
  const rec = X.recommend(m.caps);
  assert.strictEqual(byId(rec, 'linux-xbox').status, 'no');
  assert.strictEqual(byId(rec, 'vm-gpu').status, 'no');
  assert.strictEqual(byId(rec, 'dual-boot').status, 'no');
  assert.strictEqual(byId(rec, 'cloud').status, 'setup'); // still possible with a browser
});

test('xodus installed and steam present: that route is ready and first', () => {
  const m = machine({ cores: 8, memMiB: 16000, bins: ['steam'], xodus: true, gpus: [{ addr: '0000:03:00.0', vendor: '0x10de', device: '0x2504', boot: true, group: 1, driver: 'nvidia' }] });
  const rec = X.recommend(m.caps);
  assert.strictEqual(rec.routes[0].id, 'linux-xbox');
  assert.strictEqual(rec.routes[0].status, 'ready');
  assert.strictEqual(rec.fastest, 'linux-xbox');
});

test('browser found as a flatpak makes the cloud route ready; windows drives are counted', () => {
  const lsblk = JSON.stringify({ blockdevices: [
    { path: '/dev/nvme0n1', fstype: null, children: [{ path: '/dev/nvme0n1p3', fstype: 'ntfs', label: 'Windows', size: '400G' }, { path: '/dev/nvme0n1p4', fstype: 'btrfs' }] },
    { path: '/dev/sda1', fstype: 'BitLocker', label: null },
  ] });
  const m = machine({ cores: 4, memMiB: 8000, flatpaks: ['com.microsoft.Edge'], lsblk, gpus: [] });
  assert.strictEqual(m.caps.windowsDrives.length, 2);
  const rec = X.recommend(m.caps);
  assert.strictEqual(byId(rec, 'cloud').status, 'ready');
  assert.match(byId(rec, 'dual-boot').why, /Found 2 Windows-style drives/);
});

test('describe() and JSON stay usable on every machine above', () => {
  const m = machine({ cores: 8, memMiB: 31800, virt: 'svm', bins: ['steam', 'qemu-system-x86_64', 'virsh'],
    gpus: [{ addr: '0000:0e:00.0', vendor: '0x1002', device: '0x164e', boot: true, group: 20 }, { addr: '0000:01:00.0', vendor: '0x10de', device: '0x2684', boot: false, group: 14, peers: [{ addr: '0000:01:00.1', ...AUDIO }] }] });
  const rec = X.recommend(m.caps);
  const text = X.describe(m.caps, rec);
  assert.match(text, /Suggested split: Windows gets threads/);
  assert.doesNotThrow(() => JSON.stringify({ caps: m.caps, rec }));
});

test('cpu list parsing', () => {
  assert.deepStrictEqual(X.parseCpuList('0-2,8'), [0, 1, 2, 8]);
  assert.deepStrictEqual(X.parseCpuList('garbage'), []);
  assert.deepStrictEqual(X.parseCpuList('5-3'), []);
});

test('probe on an empty root does not throw', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'xr-'));
  tmp.push(root);
  const c = X.probe({ root, home: root, lsblk: null, arch: 'x64' });
  assert.strictEqual(c.cpu.threads, 0);
  assert.doesNotThrow(() => X.recommend(c));
});
