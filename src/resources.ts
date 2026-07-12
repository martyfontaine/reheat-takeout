/**
 * Resolve bundled resources (sounds, the Gene walkthrough) whether Reheat is
 * running from source in dev or from inside a `.app` bundle.
 *
 * The `.app` launcher exports REHEAT_RESOURCES=<...>/Contents/Resources; in dev
 * we fall back to the repo root. Both layouts hold `assets/` and `walkthrough/`.
 */
import { join } from "path";
import { existsSync } from "fs";

export function resourcesDir(): string {
  const env = process.env.REHEAT_RESOURCES;
  if (env && existsSync(env)) return env;
  return join(import.meta.dir, ".."); // dev: repo root (this file is in src/)
}

export function assetPath(name: string): string {
  return join(resourcesDir(), "assets", name);
}

export function walkthroughPath(): string {
  return join(resourcesDir(), "walkthrough", "gene.html");
}
