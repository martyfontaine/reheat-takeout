# PhotoBridge

**A macOS background daemon that turns Google Photos *Takeout* exports into a clean, metadata-correct import into Apple Photos** — so any app that can only read your local Apple Photos library (Gander and every other iOS-app-on-Mac, plus native Photos-reading apps) can finally see your Google Photos, with dates and locations intact.

Set it up once. Drop a Takeout archive in a folder. PhotoBridge silently extracts it, re-attaches the true capture date + GPS + caption to every photo and video, dedupes anything already imported, and imports the result into Apple Photos. You never open Apple Photos again — it becomes invisible plumbing.

## Why this exists

Getting Google Photos into Apple Photos is blocked by two walls:

1. **Google Photos has no local copy** — it's cloud-native; nothing lives on your Mac to read.
2. **Google bricked the read API (March 31, 2025)** — `photoslibrary.readonly` now returns `403 PERMISSION_DENIED`; apps may only touch media they themselves uploaded. Live Google→local sync is dead.

The only sanctioned bulk path out is **Google Takeout** — but Takeout is notorious for breaking import: it strips capture dates, GPS, and captions out of the files and dumps them into sidecar `.json` files. Existing fixers (like GPTH) only repair the *filesystem* timestamp, **not the EXIF metadata Apple Photos actually reads** — so Photos still shows the wrong date.

**PhotoBridge writes the true metadata back into each file's EXIF/QuickTime block *and* imports into Apple Photos *and* runs as a daemon** — collapsing three manual steps into zero. The metadata merge is the whole point, so it's built to be correct, not merely present.

## Honest and transparent

Plenty of tools promise one-click magic and quietly cut corners to fake it — automating your Google login (which gets accounts flagged), or hiding what they do with your photos. Reheat won't.

**Honest and transparent means not everything can be automatic.** The one step only *you* can do — asking Google for a copy of your own data — stays yours. That's not laziness on our part; it's the wall Google put up in 2025, and pretending otherwise would mean either lying to you or gambling with your account. So instead, Gene (your friendly takeout-box guide) walks you through it in about four clicks, tells you exactly *why*, and hides nothing.

Join us in learning, and we'll be with you every step of the way.

## Requirements

- macOS (Apple Silicon or Intel)
- [Bun](https://bun.sh) ≥ 1.1
- [exiftool](https://exiftool.org) — `brew install exiftool`
- Apple Photos (built in)

Run `photobridge doctor` to check everything at once.

## Install

```sh
git clone <this-repo> photobridge && cd photobridge
bun install
bun run bin/photobridge.ts doctor      # verify dependencies + permissions
bun run bin/photobridge.ts init        # choose the watched inbox folder
bun run bin/photobridge.ts install     # install the launchd agent
```

`init` writes a config file (default `~/.config/photobridge/config.json`); `install` writes a launchd LaunchAgent that watches your inbox folder and runs PhotoBridge whenever an archive lands there.

## Getting a Takeout archive

1. Go to [takeout.google.com](https://takeout.google.com), deselect all, select **Google Photos**, and export.
2. Choose `.zip` (or `.tgz`). Large libraries are split into multiple parts (`…-001.zip`, `…-002.zip`); download **all** parts into the inbox folder — PhotoBridge extracts every part before scanning.
3. Optionally set up Takeout's **scheduled export** (every 2 months) delivered to **Google Drive**, and let Google Drive for desktop sync it into your inbox folder — then imports happen with zero ongoing effort.

Drop the archive(s) into your inbox folder. That's it. Watch progress with `photobridge logs`.

## Commands

| Command | What it does |
|---|---|
| `photobridge init` | Interactively set the watched inbox folder and timezone; write config |
| `photobridge install` | Install the launchd LaunchAgent (watches the inbox) |
| `photobridge uninstall` | Remove the LaunchAgent |
| `photobridge run` | Process any Takeout archives currently in the inbox |
| `photobridge run --dry-run` | Report what *would* be imported without touching Apple Photos |
| `photobridge status` | Show agent load state and import counts |
| `photobridge logs` | Print recent structured log lines |
| `photobridge doctor` | Check dependencies and Apple Photos automation permission |
| `photobridge icloud status` | Read the actual iCloud Photos setting (definitive, via UI automation) |
| `photobridge icloud on/off` | Toggle iCloud Photos — confirmation dialogs are left for you to answer |

## Permissions

On first run macOS will prompt for:

- **Automation** — allow your terminal / Bun to control Photos (System Settings ▸ Privacy & Security ▸ Automation). Required to import.
- **Full Disk Access** may be needed for your terminal depending on where your inbox lives.

`photobridge doctor` detects the Automation permission and tells you exactly how to grant it if it's missing.

## Controlling iCloud Photos

Apple provides **no API** for the iCloud Photos setting — no `defaults` key, no AppleScript command — and on modern macOS the Settings toggle is a SwiftUI control that isn't exposed to another app's accessibility automation, so it **cannot be flipped programmatically** in a way that survives macOS versions. PhotoBridge is honest about this:

- **`photobridge icloud status`** reports the state from a **passive filesystem heuristic** (cloud-sync artifacts in the system library). It's version-independent, needs **no permissions**, and prints e.g. *"iCloud Photos appears ON (cloud-sync artifacts active today)."*
- **`photobridge icloud on|off`** opens the exact **Photos ▸ Settings ▸ iCloud** pane for you and tells you which way to flip the *"Sync this Mac"* toggle. **PhotoBridge never flips it itself** — which also keeps the consequential decision (below) with you. Opening the pane needs **Accessibility** for your terminal; if that's not granted it tells you to open the pane yourself.
- **The physics that matters:** iCloud Photos is whole-library sync. Toggling off, importing, then back on does **not** keep those imports out of iCloud — they upload when you re-enable. What the toggle genuinely enables is the **import → curate → then sync** workflow: turn it off, import a Takeout, delete the junk in Photos, turn it back on — only the survivors ever upload.
- **The sharp edge:** turning iCloud Photos **off** on an "Optimize Mac Storage" setup can prompt to download originals — potentially your entire cloud library. Because PhotoBridge leaves the toggle to you, that decision is always yours to make in the Photos window.
- **The daemon never touches this.** Only the interactive `icloud` command opens any UI. The `run`/daemon path uses only the passive heuristic to *warn* when iCloud Photos looks enabled (`warnIfICloudOn` in config, default `true`).

## Caveats — read before importing a large library

- **~2× storage.** Apple Photos **copies** originals into its own library on import, so importing an N-GB Takeout uses roughly another N GB on the disk that holds your Photos library. Make sure you have the headroom.
- **iCloud Photos.** If iCloud Photos is on, everything PhotoBridge imports will upload to iCloud and count against your iCloud storage. Turn iCloud Photos off first if you don't want that.
- **Timezone.** Google stores capture time as a UTC epoch with no original timezone. PhotoBridge renders the EXIF wall-clock in a configured display timezone (default: your Mac's timezone) and also writes an explicit `OffsetTimeOriginal` tag. Set `displayTimeZone` in the config if you want a fixed zone.
- **Albums.** v1 dedupes by content and does **not** reconstruct Google Photos albums inside Apple Photos (planned for v2).
- **One direction.** v1 is Takeout → Apple Photos only. Apple → Google is out of scope for v1.

## How it works

```
inbox archive → extract → scan → match sidecar → hash (original bytes)
   → dedup → merge EXIF/GPS/date → import to Apple Photos → confirm → record
```

- **Matcher** resolves each media file to its `.json` sidecar handling every Takeout quirk: legacy vs `supplemental-metadata` naming, the 46-char truncation rule, the `(n)`-duplicate-counter that moves to the tail, `-edited` files inheriting the original's sidecar, and live-photo motion files inheriting the still's sidecar.
- **Merger** writes `DateTimeOriginal`/`CreateDate` (+ `OffsetTimeOriginal`) and GPS for images, and QuickTime date tags for video, using a single batched exiftool process. `0/0/0` locations are treated as "no location" and never stamped.
- **Dedup** is by SHA-256 of the original bytes, computed before the merge mutates the file — so Takeout's album duplication and repeated exports never create duplicate imports. Re-running is always safe.
- **Sink** imports via AppleScript (the same path as File ▸ Import) and confirms each import before recording it, so a crash mid-import never leaves the database claiming something Photos didn't receive.

## Privacy

PhotoBridge is **local-first and makes no outbound network connections.** It never contacts Google or any other host — the only cloud involved is Google's own Takeout, which *you* initiate. (There's a test that fails the build if any network-call primitive appears in the source.)

## Security

PhotoBridge has undergone a security audit ([`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md)) covering command injection, archive path-traversal (zip-slip), symlink handling, AppleScript/SQL injection, and network egress — including adversarial testing with hand-crafted malicious archives. No critical or high-severity vulnerabilities were found. To report a vulnerability, see [`SECURITY.md`](./SECURITY.md).

## Development

```sh
bun run typecheck   # tsc --noEmit
bun test            # unit + integration tests against checked-in fixtures
```

Fixtures live in `test/fixtures/takeout-mini/` — a synthetic Takeout subtree covering the matcher's edge cases, each with a known-good expected mapping.

## License

MIT — see [LICENSE](./LICENSE).
