// SPDX-License-Identifier: MIT
/**
 * CLI: import an upstream Sonarr/Radarr/Prowlarr SQLite DB into MediaNexus.
 *   tsx scripts/import-upstream.ts --kind sonarr --db /path/to/sonarr.db
 *   (--kind optional: auto-detected; --target defaults to DATABASE_URL or ./data/media-nexus.db)
 */
import { createDb } from "@medianexus/database";
import { resolve } from "node:path";

interface Args { kind?: string; db?: string; target?: string; }

function parse(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--kind") out.kind = argv[++i];
    else if (argv[i] === "--db") out.db = argv[++i];
    else if (argv[i] === "--target") out.target = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (!args.db) { console.error("Usage: tsx scripts/import-upstream.ts --kind <sonarr|radarr|prowlarr> --db <upstream.db> [--target <media-nexus.db>]"); process.exit(1); }
  const sourcePath = resolve(args.db);
  const targetUrl = args.target ? `file:${resolve(args.target)}` : (process.env.DATABASE_URL ?? "file:./data/media-nexus.db");

  const handle = createDb(targetUrl);
  handle.runMigrations();

  const { runImport } = await import("../apps/api/src/import/importer");
  const report = await runImport(sourcePath, handle.db, { onLog: (m) => console.log(m) });
  console.log("\nImport report:", JSON.stringify(report, null, 2));
  if (report.errors.length) { console.error("\nErrors:"); for (const e of report.errors) console.error(" -", e); }
  handle.close();
  process.exit(report.errors.length ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
