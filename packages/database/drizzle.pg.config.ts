// SPDX-License-Identifier: MIT
import { defineConfig } from "drizzle-kit";

/** Postgres drizzle-kit config (roadmap P2 item 12 / M1.1): generates the pg migration
 *  set from `schema.pg.ts` into `migrations-pg/`, separate from the SQLite migrations. */
export default defineConfig({
  schema: "./src/schema.pg.ts",
  out: "./migrations-pg",
  dialect: "postgresql",
  dbCredentials: {
    // Only used for `drizzle-kit push`/studio introspection; generation doesn't connect.
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/media_nexus",
  },
  verbose: true,
  strict: true,
});
