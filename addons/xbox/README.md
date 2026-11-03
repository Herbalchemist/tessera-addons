# Xbox PC Games Setup (a Tessera shard)

Helps you set up software to play Xbox PC games you own on Tessera. It shows which ways this machine
can really do it, easiest first, and what each one still needs. You need your own games and accounts;
this add-on is not made by or affiliated with Microsoft, and it doesn't come with any games or
subscription.

- **Xbox PC games on Linux** through [Xodus Nexus](https://github.com/domsvoboda/xodus-nexus) (a young
  community project: only some games work). The games you make with Nexus's **Create shortcut** or
  **Add to Steam** show up in Tessera's **Find games**, as Xbox games. Tessera keeps them behind the
  PIN: they're offered only once a PIN is set and **Settings › PIN › Allow Xbox games** is on, and
  starting one asks for the PIN. This needs a Tessera with that rule; an older one gets no Xbox games
  from here, and this page says to update. The page also says when Nexus is open, since a game
  started from Tessera then only hands over to it. Install Nexus and sign in to Microsoft in
  Desktop Mode (it needs a keyring and a keyboard or mouse).
- **Xbox Cloud Gaming** in Tessera's browser, one press from this add-on's page.
- **Streaming** from a Windows PC or Xbox at home.
- **A Windows VM with its own graphics chip**: only offered where it can work (a spare graphics chip
  in a clean IOMMU group, enough memory and cores), with a suggested split that gives Windows 75% of
  the memory and cores while it runs and always leaves the desktop at least 6 GB and one core.
- **Windows on its own drive**, chosen when the PC starts.

It only looks (processor, memory, graphics, IOMMU groups, drives, installed programs, Nexus's
shortcuts). It changes nothing. **Save a report** writes what it saw to a file, for bug reports.

From a terminal: `node bin/probe.js` (or `--json`).
