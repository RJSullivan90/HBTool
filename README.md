# HBTool

Geospatial toolkit for Hummingbird Drones, for macOS and Windows.

Currently ships one tool: **TFR Report** — look up a US wildfire Temporary
Flight Restriction by fire name, NOTAM number, or place, and get every field the
"UAS Operations in a Wildfire TFR" flight documentation form asks for, each one
copy-pastable.

> Reference only — not flight clearance. TFR boundaries and times change by
> NOTAM; verify with the FAA before flying.

## Install

Download the latest build from
[Releases](https://github.com/RJSullivan90/HBTool/releases/latest):

| Platform | File |
|---|---|
| macOS (Apple silicon or Intel) | `HBTool-<version>-<arch>.dmg` |
| Windows | `HBTool-Setup-<version>.exe` |

The app updates itself from that same Releases page. See
[Code signing](#code-signing) for what that currently does and does not do.

## The team key

Map imagery needs a Mapbox credential. This repository is public, so that
credential is **not** stored here in readable form — `secrets/secrets.enc.json`
holds it encrypted, and a team key unlocks it.

Enter the key once, under **Satellite imagery key** at the bottom of the window.
It is stored in your operating system's credential store (Keychain on macOS,
DPAPI on Windows), never on disk in the clear. The app shows a four-character
fingerprint of whichever key you unlocked with, so you can confirm you and your
teammates are on the same one.

Ask Richard for the key. It is not in this repo, it is not in the download, and
it never will be — that is the whole reason this arrangement is safe to publish.

**TFR lookups work perfectly well without the key.** It gates map imagery only.

### What this protects, and what it doesn't

It protects against automated scrapers that crawl public GitHub for
credentials — the thing that actually burns a free-tier token overnight.

It does not protect against anyone you have given the key to. They can read the
Mapbox token, by design; they need it for the app to work. This is access
control for a small trusted team, not DRM.

## Development

```bash
npm install
npm start          # build and run
npm test           # 35 assertions, no network required
npm run typecheck
```

| Command | What it does |
|---|---|
| `npm run dist:mac` | Build macOS `.dmg` + `.zip` into `release/` |
| `npm run dist:win` | Build the Windows installer into `release/` |
| `npm run encrypt-secret` | Rewrite `secrets/secrets.enc.json` |

### Rotating the Mapbox token

Run `npm run encrypt-secret`, give it the **same team key** and the new token,
commit the bundle, and cut a release. Every install picks the new token up on
its next update with nobody re-typing anything.

Rotating the *team key* is the disruptive one — everybody has to re-enter it —
so save that for someone leaving.

## Releasing

```bash
npm version patch
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which runs the tests, builds
on a macOS runner and a Windows runner, and publishes both to Releases. No
secrets need configuring: `GITHUB_TOKEN` is provided automatically.

## Code signing

Neither platform is code-signed yet, which has consequences worth knowing before
you hand a build to someone:

- **Windows** — auto-update works. SmartScreen shows an "unrecognised app"
  warning on first run until the download builds reputation. A code-signing
  certificate removes it.
- **macOS** — auto-update **cannot apply**. Squirrel.Mac refuses to update an
  app without a valid Developer ID signature, so the app detects this, says an
  update is available, and offers the Releases page instead of silently failing.
  An Apple Developer account ($99/year) plus notarization fixes it properly.

To enable signing later: set `hardenedRuntime: true` and remove
`identity: null` in `electron-builder.yml`, and add the certificate and
notarization credentials to the workflow.

## Layout

```
src/shared/    Pure logic — parsing, geodesy, crypto. No Electron, no DOM.
src/main/      Electron main process: window, IPC, network, secrets, updater.
src/renderer/  The UI. No network and no secrets ever reach it.
tests/         Runs under `node --test` against src/shared and src/main/net.
scripts/       Build (esbuild) and the secret-encryption tool.
secrets/       The encrypted bundle. Safe to commit. The key is not here.
```

The macOS-native predecessor lives in the private `HBTool-mac` repository and
remains the app of record for the other six tools until they are ported.
