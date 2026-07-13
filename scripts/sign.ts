/**
 * Optional Developer ID code-signing + notarization.
 *
 * This is a NO-OP unless configured, so `bun run build:app` / `build:dmg` keep working
 * for unsigned local/dev builds. Once you have an Apple Developer account and a
 * "Developer ID Application" certificate in your keychain, set these and the build
 * produces a signed, notarized, stapled DMG that opens with no Gatekeeper block:
 *
 *   export REHEAT_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
 *   # one-time: store notary creds in the keychain under a profile name of your choice
 *   xcrun notarytool store-credentials reheat-notary \
 *       --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
 *   export REHEAT_NOTARY_PROFILE="reheat-notary"
 *
 * With SIGN_IDENTITY only → signed but not notarized (still blocked on other Macs).
 * With both → signed + notarized + stapled → opens cleanly. With neither → unsigned.
 *
 * NOTE: the .app's main executable is a small bash launcher (Contents/MacOS/Reheat)
 * that execs the compiled binary in Resources; the binary carries the hardened runtime
 * + JIT entitlements Bun/JavaScriptCore needs. This follows Apple's documented flow but
 * has not been validated end-to-end without a real certificate — if the notary service
 * rejects the script-launcher layout, the fallback is to make the compiled binary the
 * bundle's main executable (Contents/MacOS/Reheat). Iterate from notarytool's log.
 */
import { join } from "path";
import { tmpdir } from "os";
import { writeFile, rm } from "fs/promises";

export function signIdentity(): string | null {
  const v = process.env.REHEAT_SIGN_IDENTITY;
  return v && v.trim().length > 0 ? v.trim() : null;
}

export function notaryProfile(): string | null {
  const v = process.env.REHEAT_NOTARY_PROFILE;
  return v && v.trim().length > 0 ? v.trim() : null;
}

interface RunResult { code: number; out: string; err: string }

async function run(cmd: string[]): Promise<RunResult> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

async function must(cmd: string[], label: string): Promise<string> {
  const r = await run(cmd);
  if (r.code !== 0) {
    throw new Error(`${label} failed (exit ${r.code}):\n${(r.err || r.out).trim()}`);
  }
  return r.out;
}

// JavaScriptCore (Bun's engine) JITs, so the hardened runtime needs these or the
// binary crashes at launch after notarization.
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict>
</plist>
`;

/**
 * Sign the compiled binary (hardened runtime + JIT entitlements) then seal the bundle.
 * Returns true if signed, false if signing isn't configured (unsigned build).
 * `innerBinary` is the Mach-O inside the bundle that must carry the hardened runtime.
 */
export async function signApp(appPath: string, innerBinary: string): Promise<boolean> {
  const identity = signIdentity();
  if (!identity) {
    console.log("  signing: skipped (unsigned build — set REHEAT_SIGN_IDENTITY to sign)");
    return false;
  }
  const ents = join(tmpdir(), `reheat-entitlements-${Date.now()}.plist`);
  await writeFile(ents, ENTITLEMENTS);
  try {
    console.log(`  signing with: ${identity}`);
    // Inner Mach-O first (hardened runtime + entitlements + secure timestamp)…
    await must(
      ["codesign", "--force", "--timestamp", "--options", "runtime",
       "--entitlements", ents, "--sign", identity, innerBinary],
      "codesign (binary)",
    );
    // …then the bundle itself.
    await must(
      ["codesign", "--force", "--timestamp", "--options", "runtime",
       "--entitlements", ents, "--sign", identity, appPath],
      "codesign (app)",
    );
    await must(["codesign", "--verify", "--deep", "--strict", "--verbose=2", appPath], "codesign --verify");
    console.log("  signing: OK");
    return true;
  } finally {
    await rm(ents, { force: true });
  }
}

/**
 * Submit a DMG to Apple's notary service, wait for the result, then staple the ticket
 * so Gatekeeper accepts it offline. No-op (returns false) unless a notary profile is set.
 * Requires the DMG's app to already be Developer ID-signed with the hardened runtime.
 */
export async function notarizeAndStaple(dmgPath: string): Promise<boolean> {
  const profile = notaryProfile();
  if (!profile) {
    console.log("  notarize: skipped (set REHEAT_NOTARY_PROFILE to notarize + staple)");
    return false;
  }
  if (!signIdentity()) {
    throw new Error("notarization requires a signed build — set REHEAT_SIGN_IDENTITY too");
  }
  console.log(`  notarize: submitting ${dmgPath} (this waits for Apple)…`);
  const out = await must(
    ["xcrun", "notarytool", "submit", dmgPath, "--keychain-profile", profile, "--wait"],
    "notarytool submit",
  );
  if (/status:\s*Invalid/i.test(out)) {
    throw new Error(`notarization was rejected:\n${out.trim()}\nRun: xcrun notarytool log <id> --keychain-profile ${profile}`);
  }
  await must(["xcrun", "stapler", "staple", dmgPath], "stapler staple");
  await must(["xcrun", "stapler", "validate", dmgPath], "stapler validate");
  console.log("  notarize: OK (stapled)");
  return true;
}
