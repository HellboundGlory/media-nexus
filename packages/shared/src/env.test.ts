// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseEnv, envSchema } from "../src/env";

describe("DATABASE_URL validation (roadmap P2 item 12)", () => {
  it("accepts SQLite forms: bare path, file:, sqlite:, :memory:", () => {
    for (const url of ["./data/media-nexus.db", "file:./data/media-nexus.db", "sqlite:./x.db", ":memory:", "/abs/path.db"]) {
      expect(parseEnv({ DATABASE_URL: url, MEDIA_NEXUS_SECRET: "secret1234" } as never).DATABASE_URL).toBe(url);
    }
  });

  it("accepts Postgres URLs (postgres:// and postgresql://)", () => {
    for (const url of ["postgres://user:pass@localhost:5432/media_nexus", "postgresql://user@host/db"]) {
      expect(parseEnv({ DATABASE_URL: url, MEDIA_NEXUS_SECRET: "secret1234" } as never).DATABASE_URL).toBe(url);
    }
  });

  it("rejects unrecognized schemes with a clear error", () => {
    for (const url of ["mysql://user@host/db", "mongodb://user@host/db", "redis://host", "https://example.com/db"]) {
      expect(() => parseEnv({ DATABASE_URL: url, MEDIA_NEXUS_SECRET: "secret1234" } as never)).toThrow(/DATABASE_URL/);
    }
  });

  it("keeps the default when DATABASE_URL is unset", () => {
    expect(envSchema.parse({ MEDIA_NEXUS_SECRET: "secret1234" }).DATABASE_URL).toBe("file:./data/media-nexus.db");
  });
});
