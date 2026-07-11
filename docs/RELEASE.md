# Release and Sync

`kotonia-vscode` is published from the `vscode-extension/` subtree. The
extension does **not** bundle the `kotonia-cli` helper binary — a bundled
unsigned native binary trips the Marketplace "suspicious content" scanner.
Instead it downloads the pinned `kotonia-cli` release (see
`kotonia-cli.version`) on first use, caching it per version under the
extension's global storage. A user-set `kotonia.enginePath` (custom path, or
`kotonia-cli` resolved via PATH on the remote) always wins.

## One-time setup

Create the public extension repository:

```bash
gh repo create zhener562/kotonia-vscode --public \
  --description "Kotonia Agent VS Code extension"
git remote add kotonia-vscode git@github.com:zhener562/kotonia-vscode.git
```

Create or verify the Visual Studio Marketplace publisher id `shinjishimizu`, then add
`VSCE_PAT` as a GitHub Actions secret in `zhener562/kotonia-vscode`.

## Sync from the monorepo

From the repository that owns `vscode-extension/`:

```bash
git subtree split --prefix=vscode-extension -b split/kotonia-vscode
git push kotonia-vscode split/kotonia-vscode:main
git branch -D split/kotonia-vscode
```

Do this after the subtree has absorbed the intended `kotonia-cli` changes.

## CLI release first

`kotonia-cli` publishes helper binaries from its own release workflow on `v*`
tags. The VS Code extension pins the CLI release tag in `kotonia-cli.version`.
Update that file intentionally when taking a new engine into the extension.

## Extension release

In `kotonia-vscode`, tag the synced commit:

```bash
git tag <EXT_VERSION>
git push origin <EXT_VERSION>
```

The extension workflow builds a single, platform-agnostic VSIX (no bundled
binary), attaches it to the GitHub release, and publishes it to the Marketplace
when `VSCE_PAT` is configured. The engine is fetched at runtime from the CLI
release pinned in `kotonia-cli.version`.

To publish manually without a tag:

```bash
gh workflow run publish.yml --repo zhener562/kotonia-vscode --ref main \
  -f publish_marketplace=true
```

(The old `-f cli_tag=…` input is gone — the engine version is pinned in
`kotonia-cli.version`, so bump that file instead.)
