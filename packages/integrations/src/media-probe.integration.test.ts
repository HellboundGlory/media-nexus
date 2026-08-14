// SPDX-License-Identifier: MIT
/**
 * Real-binary integration test: exercises probeMediaFile against the actual static ffprobe
 * binary (`@ffprobe-installer/ffprobe`, installed by `npm ci`) on a tiny checked-in fixture.
 * Catches arg-shape and JSON-schema drift that mocks cannot. Unmocked file on purpose.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { probeMediaFile } from "./media-probe";

const fixture = fileURLToPath(new URL("./fixtures/probe-fixture.mp4", import.meta.url));

describe("probeMediaFile (real ffprobe binary)", () => {
  it("probes a real video and extracts video/audio stream data", async () => {
    const raw = await probeMediaFile(fixture);
    expect(raw).not.toBeNull();

    const video = raw!.streams?.find((s) => s.codec_type === "video");
    const audio = raw!.streams?.find((s) => s.codec_type === "audio");
    expect(video?.codec_name).toBe("h264");
    expect(video?.width).toBe(64);
    expect(video?.height).toBe(64);
    expect(audio?.codec_name).toBe("aac");
    expect(Number.parseFloat(raw!.format!.duration!)).toBeCloseTo(1.0, 1);
  });
});
