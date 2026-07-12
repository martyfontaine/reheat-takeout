# Security Policy

## Reporting a vulnerability

If you believe you've found a security issue in PhotoBridge, please report it
**privately** rather than opening a public issue:

- Use GitHub's **[Report a vulnerability](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**
  (Security → Advisories → Report a vulnerability) on this repository, **or**
- Open a minimal public issue asking for a private contact channel (no details).

Please include: affected version, a description, and ideally a minimal
reproduction (e.g. a crafted archive). We aim to acknowledge reports within a
few days.

## Design notes relevant to security

PhotoBridge is **local-first** and intentionally small in attack surface:

- **No network.** It makes no outbound connections; a test fails the build if any
  network primitive is introduced. The only cloud involved is Google Takeout,
  which *you* initiate.
- **No secrets.** It handles no credentials, API keys, or tokens.
- **No shell.** All subprocesses are spawned with argument arrays (no shell
  interpolation); SQL is parameterized; AppleScript receives paths via `argv`.
- **Untrusted input** (archives, sidecars, filenames) is extracted and scanned in
  a way that contains path traversal and ignores symlinks.

See [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md) for the full audit.

## Keeping your install safe

- Keep **exiftool** updated (`brew upgrade exiftool`) — it parses untrusted media.
  `photobridge doctor` reports your installed version.
- Only drop archives you obtained yourself (your own Google Takeout) into the
  watched inbox.

## Supported versions

PhotoBridge is pre-1.0; security fixes land on the latest `main`.
