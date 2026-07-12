/**
 * Parse a Google Takeout sidecar JSON into normalized metadata.
 *
 * Field rules (confirmed against multiple independent Takeout reverse-engineers):
 *  - photoTakenTime.timestamp is authoritative (unix seconds, UTC). Fall back to
 *    creationTime.timestamp (upload time — inferior) only if the former is absent.
 *  - Prefer geoData over geoDataExif; fall back to geoDataExif only when geoData is
 *    zeroed/absent. 0/0/0 means "no location" — never stamp Null Island (ISC-27).
 *  - description is the caption; title is the original filename (tiebreaker only).
 */
import type { SidecarMetadata, GeoData } from "./types";

interface RawGeo {
  latitude?: number;
  longitude?: number;
  altitude?: number;
}

interface RawSidecar {
  title?: string;
  description?: string;
  photoTakenTime?: { timestamp?: string | number };
  creationTime?: { timestamp?: string | number };
  geoData?: RawGeo;
  geoDataExif?: RawGeo;
}

function toUnix(ts: string | number | undefined): number | null {
  if (ts === undefined || ts === null) return null;
  const n = typeof ts === "number" ? ts : parseInt(ts, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeGeo(g: RawGeo | undefined): GeoData | null {
  if (!g) return null;
  const lat = g.latitude ?? 0;
  const lng = g.longitude ?? 0;
  const alt = g.altitude ?? 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0 && alt === 0) return null; // ISC-27: 0/0/0 => no location
  return { latitude: lat, longitude: lng, altitude: Number.isFinite(alt) ? alt : 0 };
}

export function parseSidecar(json: string): SidecarMetadata {
  const raw = JSON.parse(json) as RawSidecar;

  let takenTimeUnix = toUnix(raw.photoTakenTime?.timestamp);
  let timeSource: SidecarMetadata["timeSource"] = takenTimeUnix !== null ? "photoTaken" : null;
  if (takenTimeUnix === null) {
    const creation = toUnix(raw.creationTime?.timestamp);
    if (creation !== null) {
      takenTimeUnix = creation;
      timeSource = "creation";
    }
  }

  let geo = normalizeGeo(raw.geoData);
  if (geo === null) geo = normalizeGeo(raw.geoDataExif); // fallback only when geoData zeroed/absent

  const description =
    typeof raw.description === "string" && raw.description.trim().length > 0
      ? raw.description
      : null;
  const title = typeof raw.title === "string" && raw.title.length > 0 ? raw.title : null;

  return { takenTimeUnix, timeSource, geo, description, title };
}

export async function loadSidecar(path: string): Promise<SidecarMetadata> {
  return parseSidecar(await Bun.file(path).text());
}
