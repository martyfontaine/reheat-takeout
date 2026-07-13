# Reheat — Security Audit

| | |
|---|---|
| **Project** | Reheat v0.1.0 |
| **Date** | 2026-07-11 |
| **Scope** | Full source tree (`src/`, `bin/`), extraction/import pipeline, launchd integration |
| **Method** | Static review of the complete attack surface + **empirical adversarial testing** (hand-crafted malicious archives and injection payloads run through the real code paths) + regression tests |
| **Result** | **No critical or high-severity vulnerabilities.** 2 issues fixed, 1 class empirically verified safe and hardened with regression tests, remainder documented. |

This audit was performed on the code itself and is complemented by an earlier independent cross-vendor code review (findings tracked separately for v0.2).

---

## Threat model

**Trust boundaries.** Reheat treats the following as **untrusted**:
- Any archive dropped in the watched inbox (a `.zip`/`.tgz` — not necessarily a real Google Takeout).
- Sidecar `.json` files, media files, and **filenames** inside an archive.

**Trusted:** the user's own config file, the user's machine and account.

**Assets at risk:** the user's photos, their Apple Photos library, and the local filesystem. Reheat handles **no credentials, API keys, tokens, or secrets**, and makes **no network connections**, which removes entire categories of risk (credential theft, SSRF, data exfiltration) by design.

**Primary attacker model:** a maliciously-crafted archive processed by the pipeline (hostile entry paths, symlinks, filenames, or sidecar contents). Note that placing a file in the inbox already requires local write access to the user's account — a meaningful pre-condition.

---

## Findings summary

| ID | Finding | Severity | Status |
|----|---------|----------|--------|
| F1 | launchd plist XML injection via unescaped config paths | Medium | **Fixed** |
| F2 | Archive extraction path traversal / symlink escape (zip-slip) | High *(if present)* | **Verified NOT vulnerable** + regression-tested |
| F3 | Malformed sidecar aborts the entire import (availability) | Low | **Fixed** |
| F4 | exiftool parser CVE exposure (untrusted media) | Informational | **Documented** + version surfaced in `doctor` |
| F5 | Media filename read as an exiftool option — incl. **newline/option injection** via the `-@` argfile | Medium | **Fixed 2026-07-12** (reject control-char paths) |
| F6 | Corrupt `config.json` yields a raw parse error | Informational | Accepted |
| F7 | Decompression bomb (zip/tar) fills the disk via the auto-firing daemon | Medium | **Fixed 2026-07-12** (pre-extract entry/size/free-space caps) |

> **2026-07-12 follow-up audit** (manual re-review + independent `codex` cross-check) revised
> F5 and added F7; details in the dated section below. Two correctness defects found in the same
> pass (silent import of merge-failed files; duplicate risk on a partial Photos batch) are fixed
> and documented there as well.

---

## Verified-safe (with evidence)

These common vulnerability classes were checked and found **not exploitable** by construction:

- **Shell/command injection — SAFE.** Every subprocess is spawned with an **argument array** (`Bun.spawn([...])`); no command is ever built as a shell string and no shell is invoked. Untrusted values (filenames, paths) are passed as discrete `argv` elements, so shell metacharacters have no meaning. Verified across all 8 spawn sites (`exiftool`, `ditto`, `tar`, `osascript`, `launchctl`).
- **AppleScript injection — SAFE.** The Photos import and iCloud scripts are **static string constants**; file paths are passed to `osascript` via `on run argv`, never interpolated into the script body. A hostile filename cannot inject AppleScript.
- **SQL injection — SAFE.** All `bun:sqlite` queries use `?` parameter binding; the only interpolated SQL is the static schema (`CREATE TABLE`/`PRAGMA`). The one untrusted value stored (`orig_name`, a filename) is bound as a parameter.
- **Network egress — NONE.** No `fetch`, sockets, or `node:net`/`tls`/`dgram` usage anywhere in `src/`. Enforced by a build-failing test (`network-audit.test.ts`).
- **Symlink traversal — SAFE.** The scanner enumerates with `readdir(..., { withFileTypes: true })` and processes only `isFile()` entries; symlinks (`isSymbolicLink()`) are neither scanned nor recursed. *Empirically verified:* a `passwd.jpg` symlink to `/etc/passwd` and a symlink-to-directory were both ignored.

---

## Detailed findings

### F1 — launchd plist XML injection (Medium, Fixed)

`generatePlist()` interpolated `inboxDir` and `logPath` (user-controlled, from config) directly into `<string>` elements. A config value containing XML metacharacters (`<`, `>`, `&`) could break out of the element and inject arbitrary launchd keys — e.g. an `inboxDir` of `/x</string><key>RunAtLoad</key><true/><string>`.

- **Impact:** an attacker able to influence the config could alter the LaunchAgent (persistence/behavior). Low real-world likelihood (the config is the user's own), but a clear correctness/robustness defect and a defense-in-depth gap.
- **Fix:** all interpolated values are now passed through `xmlEscape()` (escapes `& < > " '`).
- **Regression test:** `security.test.ts` asserts a malicious `inboxDir` is escaped (`&lt;key&gt;INJECTED_EVIL`, not active XML).

### F2 — Archive extraction path traversal (High if present — Verified NOT vulnerable)

Reheat extracts **untrusted** archives with `ditto -x -k` (zip) and `tar -xzf` (tgz). A zip-slip archive (entries like `../../escape.txt`) could, in a naive extractor, write outside the staging directory and overwrite arbitrary files.

**This was tested adversarially, not assumed:**
- A `.tgz` whose member was renamed to `../../escapecheck/PWNED.txt` → `tar` **refused** it: `Path contains '..'` (fail-closed), nothing escaped.
- A **hand-crafted** zip (raw ZIP structure, entry name `../../escapecheck/PWNED_ZIP.txt`) run through `ditto` → extraction succeeded but the payload **did not escape**; `ditto` sanitizes the traversal.
- Combined with the symlink-skipping scanner (above), there are **two independent layers** preventing escape.

- **Status:** not vulnerable on macOS. Hardened with a regression test that crafts a zip-slip archive and asserts containment, so any future change (or a swapped extractor) that regressed this would fail the build.
- **Residual note:** the guarantee rests on the platform tools (`ditto`/`tar`). It has been verified on this macOS; the regression test guards it going forward.

### F3 — Malformed sidecar aborts the import (Low, Fixed)

`JSON.parse` of a sidecar had no error handling; a single corrupt `.json` in a large Takeout would throw and fail the **entire** archive's import — an availability/DoS issue (one bad file blocks thousands of good ones).

- **Fix:** the per-item load (`loadSidecar` + hash) in `TakeoutSource.collect` is wrapped in try/catch; a bad sidecar or unreadable file is reported as **unmatched** and processing continues.
- **Regression test:** `security.test.ts` mixes a valid and an invalid-JSON sidecar and asserts the good item is collected while the bad one is reported (no throw).

### F4 — exiftool parser exposure (Informational, Documented)

exiftool parses untrusted media and has historically had parser CVEs (e.g. CVE-2021-22204, DjVu RCE). Reheat cannot eliminate this — exiftool *is* the metadata engine — but:
- `doctor` now reports the installed exiftool **version** with a reminder to keep it current.
- Recommendation: users on outdated exiftool should update (`brew upgrade exiftool`).

### F5 — Filename interpreted as an exiftool option (Medium, Fixed 2026-07-12)

exiftool arg-files (`-@`) treat **each line as one argument**. The original review reasoned this
was mitigated because Reheat writes **absolute** paths that begin with `/`. The 2026-07-12 re-audit
found that reasoning incomplete: it assumes a path is a **single line**. A filename inside a hostile
archive can contain an embedded **newline**; when that path is written into the argfile it splits
across lines, and a resulting line beginning with `-` is read by exiftool as an **option**
(option injection), not a file. The same function already collapses newlines in the *caption* for
exactly this reason (`merge.ts`), but the *path* was not guarded.

- **Impact:** exiftool option injection from a crafted archive filename — e.g. stray `-o`/`-w`
  output writes or metadata wipes. **Not** demonstrated RCE: the `-config`→Perl vector requires
  `-config` to be the first CLI argument, which the argfile/`-execute` structure prevents.
  A genuine Google Takeout never contains control-character filenames.
- **Fix:** `mergeBatch` rejects any item whose path contains `\r`/`\n`, reporting it as an error and
  keeping it out of both the merge and the import (it is neither written nor sent to Photos).
- **Regression test:** `security.test.ts` → "F5 — a media filename with a newline cannot inject
  exiftool options" (asserts the item is not written, not importable, and reported in `errors`).

### F7 — Decompression bomb fills the disk (Medium, Fixed 2026-07-12)

Extraction ran `ditto`/`tar` on an untrusted archive with **no** size, entry-count, or free-space
limit. Because the launchd daemon auto-fires on a dropped archive, a zip/tar bomb (tiny compressed,
astronomically large uncompressed) could fill the startup disk unattended — an availability/DoS defect.

- **Fix:** before each extraction, `extract.ts` inspects the archive (`archiveStats`: `unzip -l` for
  zips; entry count × gzip's ~1032:1 max ratio for tgz) and refuses via a pure, unit-tested guard
  (`checkExtractionLimits`) if the entry count exceeds a cap or the estimated expansion would leave
  less than a free-space headroom. A real `ENOSPC` mid-extract remains a backstop, and the temp dir
  is cleaned on failure.
- **Residual:** a malicious zip that *understates* its uncompressed size in local headers can slip
  the declared-size check; the free-space margin plus the ENOSPC backstop bound the damage.
- **Regression test:** `security.test.ts` → "F7 — extraction is bounded" (entry-count cap, disk-fill
  refusal, normal-archive pass, and the undeterminable-free-space path).

### F6 — Corrupt config.json (Informational, Accepted)

A malformed `config.json` surfaces as a raw `JSON.parse` error (caught by the top-level handler, exit 1). Acceptable: it is the user's own file and the failure is safe and obvious. A friendlier message is a possible future nicety.

---

## Security test coverage

`test/security.test.ts` (part of the standard `bun test` suite) encodes:
- F1 — plist XML escaping.
- F2 — zip-slip containment (crafted malicious zip) + symlink-skip.
- F3 — malformed-sidecar resilience.
- F5 — newline-in-filename rejection (exiftool option-injection guard).
- F7 — extraction bounds (entry-count cap, disk-fill refusal, free-space edge cases).

Plus `test/network-audit.test.ts` fails the build if any network primitive is introduced.

## 2026-07-12 follow-up audit

**Method.** Full manual re-read of `src/`, `bin/`, `scripts/` plus an independent `codex` review
(read-only sandbox) as a cross-check; every finding was verified against the code before acceptance,
and each fix ships with a regression test. `bun test` and `tsc --noEmit` are green.

**Security fixes:** F5 (newline/option injection — above) and F7 (decompression bomb — above).

**Correctness fixes found in the same pass** (not vulnerabilities, but integrity/UX defects):

- **Merge-failed files were imported as "done."** The pipeline imported every deduped item
  regardless of whether its metadata merge succeeded, so a failed/again-skipped exiftool write could
  land a photo in Apple Photos *without* the corrected date/GPS — reported as success. `mergeBatch`
  now attributes success per file and returns an `importable` set; the pipeline imports only those
  and counts the rest as failures. (`merge.ts`, `pipeline.ts`.)
- **Partial Photos batch could duplicate on retry.** A chunk that partially imported was marked
  wholly failed, so nothing was recorded and the next run re-imported the ones that *had* landed —
  and `skip check duplicates true` meant Photos re-added them as duplicates. The import AppleScript
  now returns a **per-file** status so exactly the confirmed files are recorded. (`sink/applephotos.ts`.)

**Also hardened / cleaned:** `exiftoolBin()` (absolute-path resolver) is now actually used at both
exiftool call sites; `status` prints the import counts it advertises; dead branches and a duplicated
regex removed; dev-only `img/` sources untracked. See the commit history for the full change list.

**Known lower-severity items left for a follow-up** (documented, not yet changed): the loopback
`/recycle` endpoint has no CSRF nonce (short-lived, deletes only config/logs/DB, not photos); the
stale-run-lock reclaim is a narrow TOCTOU; source archives are re-extracted/re-hashed on every run.

---

## Residual risk & recommendations

1. **Keep exiftool updated** — it is the one component parsing untrusted binary input.
2. **Extraction safety is platform-provided** — verified on macOS via `ditto`/`tar`; the regression test guards against regressions or extractor swaps.
3. **Inbox is a trust boundary** — anything with write access to the inbox can trigger runs. This matches the local-first, single-user model; document it if Reheat is ever run in a shared context.
4. **v0.2 robustness items** (from the cross-vendor review): per-file import to avoid partial-chunk re-import, and a multipart settle-check. These are availability/correctness refinements, not security vulnerabilities.

---

## Conclusion

Reheat is **sound from a security standpoint** for its intended local-first, single-user use. It avoids injection by construction (array-spawn, parameterized SQL, argv-based AppleScript), performs no network I/O, handles no secrets, and its highest-risk operation — extracting untrusted archives — was **empirically verified** to be contained by both the platform extractors and a symlink-safe scanner. The two genuine defects found (plist escaping, malformed-sidecar handling) are fixed and regression-tested.

*No critical or high-severity vulnerabilities were identified.*
