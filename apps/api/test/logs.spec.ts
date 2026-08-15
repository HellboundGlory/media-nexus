// SPDX-License-Identifier: MIT
/**
 * Roadmap P3, gap report C8 (logs sub-item) — GET /api/v1/system/logs (backed by LogBuffer +
 * LogsService and populated by RingBufferLogger).
 *
 * Covers the two new components:
 *  - LogsService: most-recent-first ordering, exact level filter, substring search, limit, and
 *    ring-buffer eviction at capacity.
 *  - RingBufferLogger: captures console log lines (with context) into the buffer, and redacts a
 *    secret-shaped message before storing — the security-critical piece (an unredacted log line
 *    surfaced through a new API/UI surface would be a credential-leak vector).
 */
import { describe, it, expect } from "vitest";
import { LogBuffer } from "../src/system/log-buffer";
import { LogsService } from "../src/system/logs.service";
import { RingBufferLogger } from "../src/system/ring-buffer.logger";

describe("LogBuffer + LogsService (GET /api/v1/system/logs backing)", () => {
  it("returns entries most-recent-first and respects limit, level and search filters", () => {
    const buffer = new LogBuffer();
    const svc = new LogsService(buffer);
    buffer.append("info", "A", "first info msg");
    buffer.append("warn", "B", "warning here");
    buffer.append("error", "C", "failure happened");

    // Most-recent-first is the default view.
    expect(svc.latest(200).map((e) => e.message)).toEqual(["failure happened", "warning here", "first info msg"]);

    // Exact-level filter.
    expect(svc.latest(200, "error").map((e) => e.message)).toEqual(["failure happened"]);
    expect(svc.latest(200, "info").map((e) => e.message)).toEqual(["first info msg"]);

    // Substring search across message + context.
    expect(svc.latest(200, undefined, "warn").map((e) => e.message)).toEqual(["warning here"]);
    expect(svc.latest(200, undefined, "B").map((e) => e.message)).toEqual(["warning here"]); // matches context "B"

    // Limit bounds the most-recent.
    expect(svc.latest(2).map((e) => e.message)).toEqual(["failure happened", "warning here"]);
  });

  it("evicts the oldest entries once at capacity", () => {
    const buffer = new LogBuffer(3);
    for (let i = 0; i < 5; i++) buffer.append("info", "A", `m${i}`);
    expect(new LogsService(buffer).latest(10).map((e) => e.message)).toEqual(["m4", "m3", "m2"]);
  });
});

describe("RingBufferLogger", () => {
  it("captures console log lines (with context) and redacts secret-shaped messages before storing", () => {
    const buffer = new LogBuffer();
    const logger = new RingBufferLogger(buffer);
    const SECRET = "mn_Ip1u_j3adlXI457o06XWiyMnte5XBnx1";

    logger.log(SECRET, "AcquisitionService");
    logger.warn("plain warning here", "RssSyncService");

    const entries = buffer.latest(10);
    expect(entries).toHaveLength(2);

    const secretEntry = entries.find((e) => e.context === "AcquisitionService");
    expect(secretEntry?.level).toBe("info");
    expect(secretEntry?.message).not.toBe(SECRET);
    expect(secretEntry?.message).toBe("[REDACTED]");

    const warnEntry = entries.find((e) => e.context === "RssSyncService");
    expect(warnEntry?.level).toBe("warn");
    expect(warnEntry?.message).toBe("plain warning here");
  });

  it("redacts a secret token embedded in longer message prose (the real-world leak)", () => {
    const buffer = new LogBuffer();
    const logger = new RingBufferLogger(buffer);
    const SECRET = "mn_7Blv4nhQz2_DkvNDH4EncaBmX3uRBkuX";
    // Mirrors how Bootstrap logs the first-run API key on boot ("API key : mn_... (send as ...)").
    logger.warn(`   API key : ${SECRET}   (send as X-Api-Key header)`, "Bootstrap");

    const e = buffer.latest(10)[0];
    expect(e.context).toBe("Bootstrap");
    expect(e.message).not.toContain(SECRET);
    expect(e.message).toContain("[REDACTED]");
    expect(e.message).toContain("X-Api-Key"); // surrounding prose is preserved, only the token is scrubbed
  });

  it("leaves long pure-letter controller-class-name messages unredacted (RoutesResolver boot lines)", () => {
    // Regression: SECRET_TOKEN without a digit requirement nuked every >=16-char PascalCase
    // controller name in the RoutesResolver boot messages (e.g. it turned
    // "CustomFormatsController {/api/v1}:" into "[REDACTED] {/api/v1}:"). Class names are
    // letters only; requiring a digit in the matched run preserves them.
    const buffer = new LogBuffer();
    const logger = new RingBufferLogger(buffer);

    logger.log("CustomFormatsController {/api/v1}:", "RoutesResolver");
    logger.log("RemotePathMappingsController {/api/v1/remote-path-mappings}:", "RoutesResolver");

    const entries = buffer.latest(10);
    expect(entries[0].message).toBe("RemotePathMappingsController {/api/v1/remote-path-mappings}:");
    expect(entries[1].message).toBe("CustomFormatsController {/api/v1}:");
  });
});
