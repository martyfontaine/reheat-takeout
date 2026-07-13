#!/usr/bin/env bun
/**
 * Reheat CLI entry point. Thin shim → src/cli.ts.
 */
import { main } from "../src/cli";

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
