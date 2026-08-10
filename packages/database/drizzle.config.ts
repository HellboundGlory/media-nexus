// SPDX-License-Identifier: MIT
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  dbCredentials: { url: "./data/media-nexus.db" },
  verbose: true,
  strict: true,
});
