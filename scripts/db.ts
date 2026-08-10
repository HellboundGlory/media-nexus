// SPDX-License-Identifier: MIT
/** Standalone DB helper: `tsx scripts/db.ts migrate|seed` */
import { createDb, seedStatic } from "@medianexus/database";

const cmd = process.argv[2];
const url = process.env.DATABASE_URL ?? "file:./data/media-nexus.db";

async function main() {
  const handle = createDb(url);
  handle.runMigrations();
  if (cmd === "seed") {
    await seedStatic(handle.db);
    console.log("Static seed applied (quality profiles, indexer definitions, job definitions).");
  } else if (cmd === "migrate") {
    console.log("Migrations applied.");
  } else {
    console.error("Usage: tsx scripts/db.ts migrate|seed");
    process.exit(1);
  }
  handle.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
