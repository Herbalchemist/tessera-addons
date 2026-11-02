# Security

## Reporting a problem

Please report security problems privately, not in a public issue: on GitHub, open the
**Security** tab of this repository and choose **Report a vulnerability**.

## Our standards

This repository follows Tessera's security standards; the full list is in
[Tessera's SECURITY.md](https://github.com/Herbalchemist/tessera/blob/main/SECURITY.md).
`tools/security-check.cjs` checks them on every push and pull request (`.github/workflows/test.yml`).
For add-ons in particular:

- **The signing key never comes here.** Add-ons are signed offline with `tools/sign.cjs`, with a
  passphrase-protected key (`tools/protect-key.cjs`). The key is never committed and never used in
  CI; `.gitignore` keeps key and environment files out.
- **Packages follow Tessera's rules**: plain files only, safe names, size limits. Tessera refuses a
  package that breaks any of them, and the catalog's SHA-256 must match.
- **Official means signed**: Tessera shows a shard as Official only when its Ed25519 signature
  checks out against the key built into Tessera.
- **Add-on code** runs on people's machines: no shell commands built from text, no `eval`, nothing
  that runs as root.
- **Dependencies**: the tools use Node's own modules only; Dependabot keeps the workflows' actions
  current, pinned to a commit. Pull requests are reviewed by Claude Code's security review once the
  `CLAUDE_API_KEY` secret is added.
