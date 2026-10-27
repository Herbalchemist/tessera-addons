# Xbox and Game Pass (a Tessera shard)

Shows which ways of playing Xbox and Game Pass games this machine can really do, easiest first, and
what each one still needs:

- **Xbox PC games on Linux** through [Xodus Nexus](https://github.com/domsvoboda/xodus-nexus) (a young
  community project: only some games work). Games it adds to Steam show up in Tessera's own
  **Find games**.
- **Xbox Cloud Gaming** in Tessera's browser, one press from this add-on's page.
- **Streaming** from a Windows PC or Xbox at home.
- **A Windows VM with its own graphics chip**: only offered where it can work (a spare graphics chip
  in a clean IOMMU group, enough memory and cores), with a suggested split that gives Windows 75% of
  the memory and cores while it runs and always leaves the desktop at least 6 GB and one core.
- **Windows on its own drive**, chosen when the PC starts.

It only looks (processor, memory, graphics, IOMMU groups, drives, installed programs). It changes
nothing. **Save a report** writes what it saw to a file, for bug reports.

From a terminal: `node bin/probe.js` (or `--json`).
