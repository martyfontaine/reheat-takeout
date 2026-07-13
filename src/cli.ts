/**
 * CLI surface (ISC-4, ISC-5). Subcommands: init, install, uninstall, run,
 * status, logs, doctor. Global flags: --help/-h, --version, --dry-run.
 */
import { existsSync } from "fs";
import { readFile, mkdir } from "fs/promises";
import { walkthroughPath } from "./resources";
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  configPath,
  hostTimeZone,
  type Config,
} from "./config";
import { createLogger } from "./log";
import { run as runPipeline } from "./pipeline";
import { runDoctor } from "./doctor";
import { runICloudAction } from "./icloud";
import * as daemon from "./daemon";

const VERSION = "0.1.0";

const USAGE = `reheat ${VERSION} — Google Takeout → Apple Photos, metadata-correct.

USAGE
  reheat <command> [options]

COMMANDS
  onboard      One-shot human setup: make the Reheat drop folder, install the
               daemon, and open Gene's guide beside Google Takeout (the .app does this)
  init         Interactively set the watched inbox folder and write config
  install      Install the launchd LaunchAgent (watches the inbox, runs on drop)
  uninstall    Remove the LaunchAgent
  run          Process any Takeout archives currently in the inbox
  status       Show agent load state and import counts
  logs         Print recent structured log lines
  doctor       Check dependencies and Apple Photos automation permission
  icloud       status | on | off — report iCloud Photos state (passive), or open
               Settings ▸ iCloud and guide the toggle (the click stays yours)

OPTIONS
  --dry-run    (run) Report what would be imported without touching Apple Photos
  -h, --help   Show this help
  --version    Show version

Config lives at ${configPath()}. Reheat makes no outbound network connections.`;

async function ensureConfig(): Promise<Config> {
  return (await loadConfig()) ?? defaultConfig();
}

async function cmdInit(): Promise<number> {
  const base = defaultConfig();
  const inbox = (prompt(`Inbox folder to watch [${base.inboxDir}]:`) || "").trim();
  const tz = (prompt(`Display timezone for EXIF dates [${base.displayTimeZone || hostTimeZone()}]:`) || "").trim();
  const cfg: Config = {
    ...base,
    inboxDir: inbox.length > 0 ? inbox.replace(/^~(?=\/|$)/, process.env.HOME ?? "~") : base.inboxDir,
    displayTimeZone: tz.length > 0 ? tz : base.displayTimeZone,
  };
  await saveConfig(cfg);
  console.log(`Wrote config → ${configPath()}`);
  console.log(`  inbox:    ${cfg.inboxDir}`);
  console.log(`  timezone: ${cfg.displayTimeZone}`);
  console.log(`Next: 'reheat install' to start the daemon.`);
  return 0;
}

function spawnDetached(cmd: string[]): void {
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* best-effort */
  }
}

/** Open Gene as a chromeless companion window if Chrome is present, else a browser tab. */
function openGene(htmlPath: string): void {
  const chromeApp = "/Applications/Google Chrome.app";
  if (existsSync(chromeApp)) {
    spawnDetached(["open", "-na", "Google Chrome", "--args", `--app=file://${htmlPath}`, "--window-size=470,780"]);
  } else {
    spawnDetached(["open", htmlPath]);
  }
}

/** The double-click experience: set up the drop folder, daemon, and open Gene beside Takeout. */
async function cmdOnboard(): Promise<number> {
  const cfg = await ensureConfig();
  // The app's promise is one visible folder in the home directory — no hidden paths,
  // no surprises. Pin it to the canonical location even if an older config drifted.
  cfg.inboxDir = defaultConfig().inboxDir;
  await mkdir(cfg.inboxDir, { recursive: true });
  await saveConfig(cfg);
  console.log("Reheat is setting up…");
  console.log(`  drop folder: ${cfg.inboxDir}`);

  try {
    const { label } = await daemon.install(cfg);
    console.log(`  daemon:      ${label} — watching your Reheat folder`);
  } catch (e) {
    console.error(`  daemon install skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  spawnDetached(["open", cfg.inboxDir]); // show the human their drop folder
  const gene = walkthroughPath();
  if (existsSync(gene)) openGene(gene); // Gene, the guide
  spawnDetached(["open", "https://takeout.google.com/settings/takeout"]); // Google Takeout

  console.log("\nGene will walk you through it. Drop your Takeout .zip in the Reheat folder when it's ready.");
  return 0;
}

async function cmdInstall(): Promise<number> {
  const cfg = await ensureConfig();
  const { plist, label } = await daemon.install(cfg);
  console.log(`Installed LaunchAgent ${label}`);
  console.log(`  plist:  ${plist}`);
  console.log(`  watch:  ${cfg.inboxDir}`);
  console.log(`Drop a Google Takeout .zip into the inbox to trigger an import.`);
  return 0;
}

async function cmdUninstall(): Promise<number> {
  const { removed } = await daemon.uninstall();
  console.log(removed ? "Uninstalled LaunchAgent and removed plist." : "No plist found; agent booted out if present.");
  return 0;
}

async function cmdRun(dryRun: boolean): Promise<number> {
  const cfg = await ensureConfig();
  const logger = createLogger(cfg.logPath);
  const summary = await runPipeline(cfg, logger, { dryRun });
  console.log(
    `\n${dryRun ? "DRY RUN — " : ""}archives=${summary.archives} matched=${summary.matched} ` +
      `unmatched=${summary.unmatched} duplicates=${summary.duplicates} ` +
      (dryRun
        ? `wouldImport=${summary.wouldImport}`
        : `merged=${summary.merged} imported=${summary.imported} failed=${summary.failed}`),
  );
  return summary.failed > 0 ? 1 : 0;
}

async function cmdStatus(): Promise<number> {
  const cfg = await ensureConfig();
  const st = await daemon.status();
  console.log(`agent:  ${st.loaded ? "loaded" : "not loaded"} (${daemon.agentLabel()})`);
  console.log(`inbox:  ${cfg.inboxDir}`);
  console.log(`db:     ${cfg.dbPath}`);
  if (st.loaded) console.log(st.detail);
  return 0;
}

async function cmdLogs(): Promise<number> {
  const cfg = await ensureConfig();
  if (!existsSync(cfg.logPath)) {
    console.log(`No log file yet at ${cfg.logPath}`);
    return 0;
  }
  const text = await readFile(cfg.logPath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  console.log(lines.slice(-40).join("\n"));
  return 0;
}

async function cmdICloud(sub: string | undefined): Promise<number> {
  if (sub !== "status" && sub !== "on" && sub !== "off") {
    console.error("Usage: reheat icloud <status|on|off>");
    console.error("  status  Report whether iCloud Photos looks on (passive, no permissions needed)");
    console.error("  on/off  Open Photos ▸ Settings ▸ iCloud and guide the toggle — you make the click");
    return 2;
  }
  const res = await runICloudAction(sub);
  console.log(res.message);
  if (res.manualRequired) return 3; // pane opened; the toggle is the user's click
  return res.ok ? 0 : 1;
}

async function cmdDoctor(): Promise<number> {
  const checks = await runDoctor();
  let allOk = true;
  for (const c of checks) {
    const mark = c.ok ? "PASS" : "FAIL";
    if (!c.ok) allOk = false;
    console.log(`[${mark}] ${c.name.padEnd(26)} ${c.detail}`);
  }
  console.log(allOk ? "\nAll checks passed." : "\nSome checks failed — see above.");
  return allOk ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.includes("--version")) {
    console.log(VERSION);
    return 0;
  }
  const cmd = args.find((a) => !a.startsWith("-"));
  if (!cmd || args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return cmd ? 0 : args.length === 0 ? 0 : 0;
  }
  const dryRun = args.includes("--dry-run");

  switch (cmd) {
    case "onboard": return cmdOnboard();
    case "init": return cmdInit();
    case "install": return cmdInstall();
    case "uninstall": return cmdUninstall();
    case "run": return cmdRun(dryRun);
    case "status": return cmdStatus();
    case "logs": return cmdLogs();
    case "doctor": return cmdDoctor();
    case "icloud": {
      const rest = args.filter((a) => !a.startsWith("-"));
      return cmdICloud(rest[rest.indexOf("icloud") + 1]);
    }
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(USAGE);
      return 2;
  }
}
