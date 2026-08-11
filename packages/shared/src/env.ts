// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { z } from "zod";

/** Environment schema — single source of truth for MediaNexus configuration. */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(7373),
  DATABASE_URL: z.string().default("file:./data/media-nexus.db"),
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
