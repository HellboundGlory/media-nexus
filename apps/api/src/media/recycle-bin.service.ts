// SPDX-License-Identifier: MIT
import { Injectable, Logger } from "@nestjs/common";
import { basename, join } from "node:path";
import { LocalStorageProvider } from "@medianexus/integrations";
import { ConfigService } from "../system/config.service";

/**
 * Recycle bin for superseded/deleted media files (roadmap P1, gap report B7). Opt-in: an
 * unconfigured `media.recycleBinPath` (the default) falls back to deleting outright, so
 * existing installs see no behavior change until they set it.
 */
@Injectable()
export class RecycleBinService {
  private readonly logger = new Logger(RecycleBinService.name);
  private readonly storage = new LocalStorageProvider();

  constructor(private readonly config: ConfigService) {}

  /** Moves a file into the recycle bin, or deletes it outright when unconfigured. */
  async dispose(absolutePath: string): Promise<void> {
    const cfg = await this.config.get();
    const recycleBinPath = cfg["media.recycleBinPath"];
    if (!recycleBinPath) {
      await this.storage.delete(absolutePath);
      return;
    }
    await this.storage.ensureDir(recycleBinPath);
    const dest = join(recycleBinPath, `${Date.now()}-${basename(absolutePath)}`);
    await this.storage.move(absolutePath, dest);
  }

  /** Deletes recycle-bin entries older than `media.recycleBinRetentionDays`. No-op when
   *  the recycle bin isn't configured. Driven by the `media.recycleBinTrim` job. */
  async purgeExpired(): Promise<{ purged: number }> {
    const cfg = await this.config.get();
    const recycleBinPath = cfg["media.recycleBinPath"];
    if (!recycleBinPath) return { purged: 0 };

    const retentionMs = cfg["media.recycleBinRetentionDays"] * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;
    const entries = await this.storage.list(recycleBinPath).catch(() => []);
    let purged = 0;
    for (const entry of entries) {
      const timestamp = Number(basename(entry.path).split("-")[0]);
      if (!Number.isFinite(timestamp) || timestamp >= cutoff) continue;
      try {
        await this.storage.delete(entry.path);
        purged++;
      } catch (err) {
        this.logger.warn(`Failed to purge expired recycle-bin entry ${entry.path}: ${(err as Error).message}`);
      }
    }
    return { purged };
  }
}
