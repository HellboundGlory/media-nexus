// SPDX-License-Identifier: MIT
/**
 * Media file probing — I/O only (media info probing, roadmap P2 item 6).
 *
 * Invokes a static per-platform ffprobe binary (`@ffprobe-installer/ffprobe`) directly via
 * `execFile` with shell:false. This is a hard constraint, not a style choice: the runtime
 * image is `gcr.io/distroless/nodejs22-debian12`, which has no /bin/sh — `exec` would fail.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffprobe from "@ffprobe-installer/ffprobe";
import type { RawFfprobeOutput } from "@medianexus/domain";

const execFileAsync = promisify(execFile);

/**
 * Run ffprobe against `absolutePath` and return the parsed JSON, or `null` on any failure.
 *
 * Failure modes (ENOENT / non-zero exit / JSON parse) all collapse to `null` so a missing or
 * broken probing binary can never break an import, a library scan, or the probe job itself —
 * the caller persists null fields and moves on.
 */
export async function probeMediaFile(absolutePath: string): Promise<RawFfprobeOutput | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobe.path,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", absolutePath],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as RawFfprobeOutput;
  } catch {
    return null;
  }
}
