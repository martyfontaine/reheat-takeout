/**
 * SHA-256 of a file's bytes, streamed so large videos never load into memory.
 * The hash is of the ORIGINAL content and must be computed before merge mutates
 * the file — it is the dedup key that survives Takeout's album duplication and
 * re-exports (ISC-37, ISC-39).
 */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}
