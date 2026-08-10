// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseEnv } from "./env";
import { Logger, isSecretField } from "./log";
import { ApiError } from "./errors";
import { newRequestId } from "./id";

describe("shared", () => {
  it("parses environment with defaults and validates secret presence", () => {
    const env = parseEnv({ MEDIA_NEXUS_SECRET: "x".repeat(12) });
    expect(env.PORT).toBe(7373);
    expect(env.DATABASE_URL).toBe("file:./data/media-nexus.db");
    expect(env.AUTO_MIGRATE).toBe(true);
    expect(() => parseEnv({ MEDIA_NEXUS_SECRET: "short" })).toThrow();
  });

  it("redacts secret-looking fields in structured logs", () => {
    const lines: string[] = [];
    const logger = new Logger("test", "info", (l) => lines.push(l));
    logger.info("hello", { apiKey: "super-secret", settings: { password: "pw123", url: "https://x" } });
    const obj = JSON.parse(lines[0]);
    expect(obj.apiKey).toBe("[REDACTED]");
    expect(obj.settings.password).toBe("[REDACTED]");
    expect(obj.settings.url).toBe("https://x");
  });

  it("classifies secret field names", () => {
    expect(isSecretField("apiKey")).toBe(true);
    expect(isSecretField("authorization")).toBe(true);
    expect(isSecretField("title")).toBe(false);
  });

  it("exposes ApiError with mapped status + notFound helper", () => {
    expect(new ApiError({ code: "NOT_FOUND", message: "nope" }).statusCode).toBe(404);
    expect(ApiError.notFound("movie").statusCode).toBe(404);
    expect(ApiError.notFound("movie", "m1").message).toBe("movie m1 not found");
  });

  it("generates unique request ids", () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});
