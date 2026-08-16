# HBTool (cross-platform)

Electron + TypeScript port of the macOS-native HBTool, for Mac **and Windows**.
Public repository, which is why the secrets handling below is load-bearing.

This is the **pilot**: TFR Report only. The Swift app in the private
`HBTool-mac` repo (`flight-path-kml/` locally) is still the app of record for
Flight path, LRF, File Editor, Fire Perimeter, Map to MBTiles, Front Counter BC
and T-Rex. Its `CLAUDE.md` holds the hard-won traps for all of those and is the
reference when porting any of them.

## Build and run

```bash
npm install
npm start          # esbuild → dist/, then electron .
npm test           # 35 assertions, no network
npm run typecheck
npm run dist:mac   # or dist:win — output in release/
```

`npm start` does NOT hot-reload; rebuild and relaunch.

## Why this repository can be public

`secrets/secrets.enc.json` holds the Mapbox token encrypted under a team key
(scrypt → AES-256-GCM). **The key is never committed and never shipped inside
the build.** Each person types it once and it goes to the OS credential store
via Electron `safeStorage`.

That last sentence is the entire security model. If the key were ever embedded
in the app, the download would contain both halves and the token would fall out
under `strings` — the encryption would be theatre. Any change that makes the app
able to decrypt without a human supplying the key defeats the whole design.

- `tests/crypto.test.ts` asserts the published bundle contains no trace of the
  plaintext. Treat a failure there as "do not publish".
- Fresh salt and IV per encryption, so re-releasing the same token does not
  reveal that it went unrotated, and no IV is reused under one key.
- Wrong key is detected by the GCM auth tag — there is deliberately no separate
  "is this right" check to keep in sync.
- The token never crosses IPC into the renderer. Main-process code reads it at
  the point of use, so it cannot land in a DOM attribute.

Rotating the Mapbox token = re-encrypt under the same key, commit, release;
installs pick it up on the next update. Rotating the team key forces everyone to
re-enter, so it is reserved for someone leaving.

## Layout and the one rule about it

```
src/shared/   Pure logic. No Electron, no DOM. Imported by main, renderer AND tests.
src/main/     Window, IPC, network, secrets, updater.
src/renderer/ UI only. No network, no secrets.
```

Formatting lives in `src/shared/tfr.ts` (`formFields`, `copyAllText`) and is
imported by the renderer and the tests **both**. That is deliberate: it is what
makes it impossible for the on-screen fields, the clipboard text and the test
expectations to drift apart. Do not reimplement field formatting in the
renderer.

`src/main/net.ts` imports nothing from Electron, which is what lets the test
suite and headless verification scripts exercise the real fetch path:

```bash
node --input-type=module -e "
import { fetchAllTFRs } from './src/main/net.ts';
console.log((await fetchAllTFRs(true)).records.length);
"
```

## Ported behaviour — keep these identical to the Swift app

`tests/tfr.test.ts` mirrors the Swift `tests/main.swift` assertions
case-for-case. If both suites pass, the port has not drifted. When fixing a
parser bug, fix it in both repos or write down why not.

- **Fire names are parsed by walking words BACKWARDS** from markers (` TEL `,
  ` FIRE IS IN CHARGE`). A leftmost-first regex captures from the wrong place —
  `([A-Z ]+?) TEL` against "SFC-8000FT OREGON DEPARTMENT OF FORESTRY TEL" starts
  at "FT". Digits are legitimately inside names ("LOST CREEK 2", "MILE MARKER 81
  HIGHWAY 55"), so the walk stops at punctuation-bearing tokens (frequencies,
  phones, FRDs), not at digits.
- **Altimeter comes from the raw METAR's `Axxxx` group in inHg.** The API's own
  `altim` field is hPa — the wrong number to dial in.
- **FAA date stamps are wall-clock in `codeTimeZone`** (UTC on every fire TFR
  seen); the `Z` is appended before parsing. Parsing them naked applies the
  reader's own timezone and is hours off. The UTC stamp is the authoritative one
  and is always shown first — a laptop with a wrong timezone then misreads only
  the parenthesised local time, not the filing.
- **Polygon TFRs have no radius call**, so the centroid of the published
  geometry stands in and is **labelled as such**. Never present a centroid as if
  the NOTAM published it.
- **Failed detail fetches are reported, never silently dropped.** A missing TFR
  looks exactly like "no TFR over my fire".
- The TFR cache is **session-only**. A stale layer restored at launch would look
  authoritative and be wrong.

## Networking

All fetches happen in the **main process**: tfr.faa.gov and aviationweather.gov
send no CORS headers, so a renderer-side fetch is blocked by the browser.

`getText` retries twice on 5xx and transport failures, not on 4xx. This is not
gold-plating — aviationweather.gov returned a one-off 502 during verification
while the next request succeeded, and losing the altimeter to a single blip
matters for a form filled at the end of a night shift.

## Auto-update reality

`electron-updater` against public GitHub Releases.

- **Windows**: works unsigned. SmartScreen warns until reputation builds.
- **macOS**: Squirrel.Mac **refuses** to apply an update to an app that is not
  signed with a valid Developer ID. Ad-hoc is not enough. `updater.ts` detects
  the signature error and degrades to "update available — download" rather than
  pretending it worked. Buying an Apple Developer ID ($99/yr) is what fixes it.

Releases are cut by tag: `npm version patch && git push --follow-tags`.

## Verifying UI work

Synthetic keystrokes are blocked on this Mac (no Accessibility permission), so
interactive states are checked by temporarily presetting them in the renderer,
rebuilding, and screenshotting the window:

```bash
/private/tmp/.../winlist2 electron      # find the window id
screencapture -x -o -l <id> shot.png
```

Keep a `.good` copy of any file patched that way and restore it immediately.

## Working style

Concise and direct, bullets over prose, no filler, no praise for completed work.
Ask clarifying questions before starting unless the message ends with "go".

Brand: Laser Yellow `#F1FF66` accents, Night `#191314` / Ivory `#ECEAE4`
grounds, Forest `#406354` for the light-mode tint. Tokens are defined per theme
in `styles.css`; never define a colour in only one theme.
