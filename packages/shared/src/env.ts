// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { z } from "zod";

/** Validate a DATABASE_URL: SQLite (bare path, `file:`, `sqlite:`, `:memory:`) or
 *  Postgres (`postgres://` / `postgresql://`). Anything else is rejected with a clear
 *  error (roadmap P2 item 12). */
const databaseUrlSchema = z
  .string()
  .refine(
    (u) =>
      u === ":memory:" ||
      /^file:/.test(u) ||
      /^sqlite:/.test(u) ||
      /^postg(?:re)?s(ql)?:\/\//.test(u) ||
      // bare filesystem path (no scheme): a SQLite db file like ./data/media-nexus.db
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(u),
    {
      message:
        "DATABASE_URL must be a SQLite path (e.g. file:./data/media-nexus.db), :memory:, or a Postgres URL (postgres:// or postgresql://)",
    },
  );

/** Environment schema — single source of truth for MediaNexus configuration. */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(7373),
  DATABASE_URL: databaseUrlSchema.default("file:./data/media-nexus.db"),
  MEDIA_NEXUS_SECRET: z.string().min(8, "MEDIA_NEXUS_SECRET must be set (min 8 chars)"),
  MEDIA_NEXUS_SECRET_FILE: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  TZ: z.string().default("UTC"),
  AUTO_MIGRATE: z.coerce.boolean().default(true),
});

export type AppEnv = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const env = { ...source };
  if (!env.MEDIA_NEXUS_SECRET && env.MEDIA_NEXUS_SECRET_FILE) {
    // read secret from file (docker secrets)
    env.MEDIA_NEXUS_SECRET = readFileSync(env.MEDIA_NEXUS_SECRET_FILE, "utf8").trim();
  }
  return envSchema.parse(env);
}
