#!/usr/bin/env bun
/**
 * Assemble dist/Reheat.app — the double-click bundle a human never has to think about.
 *
 * `bun build --compile` folds the CLI + all of src/ into one standalone binary; it
 * does NOT embed the runtime assets (the chime, Gene's walkthrough), so we copy those
 * into Contents/Resources and the launcher exports REHEAT_RESOURCES to point at them
 * (see src/resources.ts). Double-clicking the app runs `reheat onboard`.
 *
 * Local builds carry no Gatekeeper quarantine, so `open dist/Reheat.app` just works.
 * Distributing to other Macs needs codesign + notarization — out of scope here.
 */
import { mkdir, rm, cp, chmod, writeFile } from "fs/promises";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const APP = join(ROOT, "dist", "Reheat.app");
const CONTENTS = join(APP, "Contents");
const MACOS = join(CONTENTS, "MacOS");
const RES = join(CONTENTS, "Resources");
const VERSION = "0.1.0";

async function main(): Promise<number> {
  await rm(APP, { recursive: true, force: true });
  await mkdir(MACOS, { recursive: true });
  await mkdir(join(RES, "assets"), { recursive: true });
  await mkdir(join(RES, "walkthrough"), { recursive: true });

  // 1. Compile the CLI to a standalone binary inside Resources.
  console.log("compiling reheat binary…");
  const compile = Bun.spawn(
    ["bun", "build", join(ROOT, "bin/reheat.ts"), "--compile", "--outfile", join(RES, "reheat")],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if ((await compile.exited) !== 0) {
    console.error("compile failed");
    return 1;
  }

  // 2. Runtime assets the binary loads by path (resolved via REHEAT_RESOURCES).
  await cp(join(ROOT, "assets/chime.mp3"), join(RES, "assets/chime.mp3"));
  await cp(join(ROOT, "assets/pop.mp3"), join(RES, "assets/pop.mp3"));
  await cp(join(ROOT, "walkthrough/gene.html"), join(RES, "walkthrough/gene.html"));
  await cp(join(ROOT, "assets/reheat.icns"), join(RES, "AppIcon.icns"));

  // 3. Info.plist — CFBundleExecutable points at the launcher, not the binary.
  await writeFile(
    join(CONTENTS, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Reheat</string>
  <key>CFBundleDisplayName</key><string>Reheat</string>
  <key>CFBundleIdentifier</key><string>com.martyrdev.reheat</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>Reheat</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.photography</string>
</dict>
</plist>
`,
  );

  // 4. The launcher: resolve Resources, export it, run onboarding, surface failures.
  await writeFile(
    join(MACOS, "Reheat"),
    `#!/bin/bash
# Reheat.app launcher — point the binary at its bundled assets, then onboard.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
export REHEAT_RESOURCES="$RES"
"$RES/reheat" onboard || osascript -e 'display dialog "Reheat had trouble starting up. You can run it from Terminal to see what happened." buttons {"OK"} with icon caution with title "Reheat"'
`,
  );
  await chmod(join(MACOS, "Reheat"), 0o755);
  await chmod(join(RES, "reheat"), 0o755);

  // 5. Classic PkgInfo (harmless; some tools still look for it).
  await writeFile(join(CONTENTS, "PkgInfo"), "APPL????");

  console.log(`\nBuilt ${APP}`);
  return 0;
}

main().then((code) => process.exit(code));
