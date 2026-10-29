<h1><img src="https://raw.githubusercontent.com/Herbalchemist/tessera/main/system_files/usr/share/tessera/branding/tessera-logo.svg" height="44" alt=""> Tessera add-ons</h1>

Optional add-ons for [Tessera](https://github.com/Herbalchemist/tessera), the controller-first gaming
OS built on Bazzite. Nothing here is forced on anyone: Tessera lists these in **Settings › Add-ons ›
Get add-ons**, and you pick what you want.

| Add-on | Kind | What it does |
|---|---|---|
| [Xbox PC Games Setup](addons/xbox) | Shard | Helps you set up software to play Xbox PC games you own: which ways this machine can do it (Xodus Nexus on Linux, Xbox Cloud Gaming, streaming from a PC or Xbox, a Windows VM with its own graphics chip, Windows on its own drive), what each one still needs, and Xbox Cloud Gaming in one press. It only looks; it changes nothing. You need your own games and accounts; not made by or affiliated with Microsoft. |

## Installing one

On Tessera: **Settings › Add-ons › Get add-ons**, pick one, and choose **Install** (it needs the
internet). A **shard** is an add-on that is code, so installing one never turns it on: go to
**Settings › Add-ons › Shards**, pick it and choose **Turn on**.

Tessera checks every download against this list (its size and SHA-256), only downloads from GitHub,
and unpacks nothing but plain files and folders.

## Official and unverified

**Official** means the Tessera project signed that add-on's exact files with its own key, and Tessera
checks the signature every time a shard starts. An unverified shard isn't signed: it may be fine,
but nobody vouches for it, and it would run with Tessera's own access to your device. **Settings ›
Add-ons › Shards › Shard safety** decides whether unverified shards may run at all.

The signing key is kept offline by the project's owner. It is never in this repository, in a GitHub
secret, or in CI. Keep it with a passphrase on it (`node tools/protect-key.cjs /path/to/key.pem` makes
a protected copy; `sign.cjs` then asks for the passphrase), and keep two copies in different places.

## What's in this repository

```
catalog.json          the list Tessera reads (written by GitHub, see below)
addons/<id>/          one folder per add-on, exactly as it is installed
  addon.json          a shard: id, name, version, entry file, tessera.api
  manifest.json       a widget        (one of these three at the top)
  theme.json          a theme
  addon.sig           a shard's signature, once it's signed (Official)
test/                 tests (not shipped in packages)
tools/build.cjs       packs addons/ into dist/*.tar.gz and writes catalog.json
tools/sign.cjs        signs an add-on, on your own computer only
tools/protect-key.cjs puts a passphrase on the signing key
tools/check.cjs       checks everything (GitHub runs it on every push)
tools/lib/            Tessera's own packing and signature code, kept identical to Tessera's
```

## Making a change, or a new add-on

1. Change the add-on's folder and **bump its `version`**. A version is released once: if the files
   change, the version must change too (GitHub refuses otherwise), so nobody's copy changes under
   the same number.
2. Run the tests: `node --test test/*.test.js` (Node.js 20 or newer).
3. For an Official shard, sign it last, on your own computer:
   `node tools/sign.cjs addons/<id> /path/to/tessera-2026.pem`, then commit `addon.sig` with the rest.
4. Push to `main`. GitHub packs every add-on, publishes a release `<id>-v<version>` with its package,
   and commits the updated `catalog.json`. Tessera sees it the next time someone opens Get add-ons.

### Writing a shard (add-on API 1)

A shard runs inside Tessera, with Tessera's access to the device. Its `addon.json`:

```json
{ "id": "my-shard", "name": "My Shard", "author": "You", "version": "1.0.0",
  "description": "What it does", "entry": "index.js", "tessera": { "api": 1 } }
```

and its entry file:

```js
module.exports = {
  activate(tessera) {
    // A page in Settings › Add-ons › Shards › My Shard
    tessera.addPanel({
      title: 'My Shard',
      render: async () => ({ body: 'Some text', items: [{ label: 'Do it', sub: 'a hint', action: 'go' }] }),
      action: async (name) => (name === 'go' ? { message: 'Done' } : { openUrl: 'https://example.com' }),
    });
    // Games or apps for Settings › Find games (must not be async)
    tessera.addLibrarySource({ name: 'My launcher', scan(offer) {
      offer({ title: 'A Game', kind: 'game', file: '/usr/bin/a-game', args: [] });
    } });
    tessera.log('started'); // a line in Tessera's log folder (shards.log)
    // tessera.dataDir: a folder of its own; tessera.tesseraVersion; tessera.id
  },
  deactivate() {}, // optional: when it's turned off
};
```

An action can return `{ body, items }` (a new page; B goes back), `{ message }` (the status line),
or `{ openUrl }` (Tessera's browser opens there; web links only). Tessera shortens long text and
drops anything that isn't a plain string, so keep pages short.

## License

GPL-3.0-or-later, like Tessera.
