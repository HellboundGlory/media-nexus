// SPDX-License-Identifier: MIT
/**
 * probeMediaFile failure handling (roadmap P2 item 6) — mocked execFile. The happy path
 * against a real ffprobe binary is covered separately in media-probe.integration.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { probeMediaFile } from "./media-probe";

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

afterEach(() => vi.clearAllMocks());

const SAMPLE = {
  format: { duration: "1.0" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 64, height: 64 }],
};

describe("probeMediaFile", () => {
  it("runs execFile with shell:false args and returns parsed JSON on success", async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
      cb(null, { stdout: JSON.stringify(SAMPLE) });
    });

    const out = await probeMediaFile("/tmp/movie.mkv");

    expect(out).toEqual(SAMPLE);
    const [bin, args] = execFileMock.mock.calls[0];
    expect(bin).toContain("ffprobe"); // resolved static binary path
    expect(args).toEqual(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "/tmp/movie.mkv"]);
  });

  it("returns null on a missing binary (ENOENT) without throwing", async () => {
    execFileMock.mockImplementation((_b: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => {
      const err = Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" });
      cb(err);
    });
    await expect(probeMediaFile("/tmp/nope.mkv")).resolves.toBeNull();
  });

  it("returns null on a non-zero exit without throwing", async () => {
    execFileMock.mockImplementation((_b: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => {
      cb(new Error("ffprobe exited with code 1"));
    });
    await expect(probeMediaFile("/tmp/bad.mkv")).resolves.toBeNull();
  });

  it("returns null when ffprobe emits invalid JSON", async () => {
    execFileMock.mockImplementation((_b: string, _a: string[], _o: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
      cb(null, { stdout: "not json at all" });
    });
    await expect(probeMediaFile("/tmp/garbage.mkv")).resolves.toBeNull();
  });
});
