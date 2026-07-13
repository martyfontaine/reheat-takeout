#!/usr/bin/env bun
/**
 * Assemble dist/Reheat.dmg — the "drag me to Applications" installer.
 *
 * Rebuilds Reheat.app, then packages it into a compressed disk image whose window
 * shows the app beside an Applications alias with a branded arrow between them, so
 * a non-technical person just drags the cup into Applications. The Finder-layout
 * step (background + icon positions) needs Automation permission for Finder; if
 * that's unavailable we still ship a working DMG (app + Applications symlink), just
 * without the pretty arrangement, and say so.
 */
import { mkdir, rm, symlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { notarizeAndStaple } from "./sign";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const APP = join(DIST, "Reheat.app");
const VOL = "Reheat";
const MOUNT = `/Volumes/${VOL}`;
const RW = join(DIST, "Reheat-rw.dmg");
const FINAL = join(DIST, "Reheat.dmg");
const WIN_W = 640;
const WIN_H = 400;

interface Run { out: string; err: string; code: number }

async function sh(cmd: string[], inherit = false): Promise<Run> {
  const p = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });
  const out = inherit ? "" : await new Response(p.stdout).text();
  const err = inherit ? "" : await new Response(p.stderr).text();
  return { out, err, code: await p.exited };
}

/** Run a command but give up (kill it) after `ms` — for the Finder step, which can
 *  block on an Automation-permission prompt in a headless session. */
async function shTimeout(cmd: string[], ms: number): Promise<Run & { timedOut: boolean }> {
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill(9); }, ms);
  const code = await p.exited;
  clearTimeout(timer);
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  return { out, err, code, timedOut };
}

const BACKGROUND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIN_W}" height="${WIN_H}" viewBox="0 0 ${WIN_W} ${WIN_H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#F4A85C"/>
      <stop offset="1" stop-color="#CB1C22"/>
    </linearGradient>
  </defs>
  <rect width="${WIN_W}" height="${WIN_H}" fill="url(#bg)"/>
  <text x="320" y="70" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#FFF3E4">Install Reheat</text>
  <text x="320" y="102" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#FFF3E4" opacity="0.92">Drag the cup onto the Applications folder</text>
  <!-- arrow sits between the icons (centered at x=160 and x=480, y=200) -->
  <g fill="none" stroke="#FFF3E4" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" opacity="0.95">
    <line x1="250" y1="200" x2="388" y2="200"/>
    <polyline points="360,176 394,200 360,224"/>
  </g>
  <text x="320" y="360" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" font-weight="600" fill="#FFF3E4" opacity="0.9">Open Source&#8194;|&#8194;Always Free&#8194;|&#8194;Take the Power Back</text>
</svg>`;

const LAYOUT_APPLESCRIPT = `tell application "Finder"
  tell disk "${VOL}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, ${200 + WIN_W}, ${120 + WIN_H}}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set text size of opts to 13
    set background picture of opts to file ".background:bg.png"
    set position of item "Reheat.app" of container window to {160, 200}
    set position of item "Applications" of container window to {480, 200}
    update without registering applications
    delay 1
    close
  end tell
end tell`;

async function detachIfMounted(): Promise<void> {
  if (existsSync(MOUNT)) await sh(["hdiutil", "detach", MOUNT, "-force"]);
}

async function main(): Promise<number> {
  if (!existsSync(join(ROOT, "walkthrough", "gene.html"))) {
    console.error("run from the repo root");
    return 1;
  }

  // 1. Fresh app build so the DMG always carries the latest binary + Gene.
  console.log("building Reheat.app…");
  if ((await sh(["bun", "run", join(ROOT, "scripts/build-app.ts")], true)).code !== 0) {
    console.error("build-app failed");
    return 1;
  }

  // 2. Branded background PNG.
  await mkdir(DIST, { recursive: true });
  const bgSvg = join(DIST, "dmg-bg.svg");
  const bgPng = join(DIST, "dmg-bg.png");
  await writeFile(bgSvg, BACKGROUND_SVG);
  if ((await sh(["rsvg-convert", "-w", String(WIN_W), "-h", String(WIN_H), bgSvg, "-o", bgPng])).code !== 0) {
    console.error("rsvg-convert (background) failed");
    return 1;
  }

  // 3. Empty read-write image, then copy the app + Applications alias + background in.
  await detachIfMounted();
  await rm(RW, { force: true });
  // No -format here: the default for an empty -size image is read/write (UDRW),
  // and this macOS rejects -format without a -srcfolder/-srcdevice.
  const create = await sh(["hdiutil", "create", "-size", "160m", "-fs", "HFS+", "-volname", VOL, "-ov", RW]);
  if (create.code !== 0) {
    console.error("hdiutil create failed:\n" + create.err);
    return 1;
  }
  const attach = await sh(["hdiutil", "attach", RW, "-readwrite", "-noverify", "-noautoopen"]);
  if (attach.code !== 0) {
    console.error("hdiutil attach failed:\n" + attach.err);
    return 1;
  }
  try {
    await sh(["ditto", APP, join(MOUNT, "Reheat.app")]);
    await symlink("/Applications", join(MOUNT, "Applications"));
    await mkdir(join(MOUNT, ".background"), { recursive: true });
    await sh(["cp", bgPng, join(MOUNT, ".background", "bg.png")]);

    // 4. Pretty Finder layout — best effort (needs Finder Automation permission).
    const layout = await shTimeout(["osascript", "-e", LAYOUT_APPLESCRIPT], 30000);
    if (layout.code === 0) {
      console.log("  applied window layout (background + arrow)");
    } else {
      const why = layout.timedOut ? "timed out (Automation permission?)" : (layout.err.trim().split("\n")[0] || "unavailable");
      console.warn(`  window layout skipped: ${why}`);
      console.warn("  → DMG still installs fine (app + Applications alias); re-run this on your Mac and approve 'control Finder' for the pretty layout.");
    }
    await sh(["sync"]);
  } finally {
    await sh(["hdiutil", "detach", MOUNT, "-force"]);
  }

  // 5. Compress to the final read-only image.
  await rm(FINAL, { force: true });
  const convert = await sh(["hdiutil", "convert", RW, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", FINAL]);
  if (convert.code !== 0) {
    console.error("hdiutil convert failed:\n" + convert.err);
    return 1;
  }

  // 6. Tidy.
  await rm(RW, { force: true });
  await rm(bgSvg, { force: true });
  await rm(bgPng, { force: true });

  // 7. Optional notarization + stapling — no-op unless REHEAT_NOTARY_PROFILE is set.
  await notarizeAndStaple(FINAL);

  console.log(`\nBuilt ${FINAL}`);
  return 0;
}

main().then((code) => process.exit(code));
