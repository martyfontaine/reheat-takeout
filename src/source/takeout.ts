/**
 * TakeoutSource — PhotoSource #1 (ISC-46).
 *
 * Walks extracted Takeout tree(s), resolves each media file's sidecar with the
 * matcher (own → edited-original → motion-sibling), loads normalized metadata,
 * and hashes the ORIGINAL bytes for dedup. Files with no resolvable sidecar are
 * reported as unmatched — never dropped, never guessed (ISC-22).
 */
import { join } from "path";
import { buildDirIndex, resolveOwnSidecar, motionStillSibling, type DirIndex } from "../match";
import { scanMedia } from "../scan";
import { loadSidecar } from "../sidecar";
import { sha256File } from "../hash";
import type { PhotoSource, MediaItem, UnmatchedItem } from "../types";

export class TakeoutSource implements PhotoSource {
  readonly name = "Google Takeout";

  constructor(private readonly extractedRoots: string[]) {}

  async collect(): Promise<{ items: MediaItem[]; unmatched: UnmatchedItem[] }> {
    const items: MediaItem[] = [];
    const unmatched: UnmatchedItem[] = [];

    for (const root of this.extractedRoots) {
      const { media, dirFiles } = await scanMedia(root);
      const indices = new Map<string, DirIndex>();
      const indexFor = (dir: string): DirIndex => {
        let idx = indices.get(dir);
        if (!idx) {
          idx = buildDirIndex(dirFiles.get(dir) ?? []);
          indices.set(dir, idx);
        }
        return idx;
      };

      for (const m of media) {
        const idx = indexFor(m.dir);
        let { name: sidecarName, via } = resolveOwnSidecar(m.name, idx);

        // Live-photo motion halves inherit the still sibling's sidecar.
        if (!sidecarName && m.kind === "video") {
          const still = motionStillSibling(m.name, idx);
          if (still) {
            const r = resolveOwnSidecar(still, idx);
            if (r.name) {
              sidecarName = r.name;
              via = "motion-sibling";
            }
          }
        }

        if (!sidecarName) {
          unmatched.push({ path: m.path, reason: "no resolvable sidecar" });
          continue;
        }

        const sidecarPath = join(m.dir, sidecarName);
        try {
          // A malformed sidecar (bad JSON) or an unreadable media file must not
          // abort the whole archive — report this one and keep going.
          const metadata = await loadSidecar(sidecarPath);
          const hash = await sha256File(m.path);
          items.push({ path: m.path, kind: m.kind, hash, sidecarPath, matchedVia: via, metadata });
        } catch (err) {
          unmatched.push({ path: m.path, reason: `sidecar/media unreadable: ${String(err).slice(0, 120)}` });
        }
      }
    }

    return { items, unmatched };
  }
}
