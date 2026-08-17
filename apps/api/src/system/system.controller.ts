// SPDX-License-Identifier: MIT
import { Body, Controller, Get, Inject, Param, Post, Put, Query, StreamableFile, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ApiError, runtimeSettingsSchema } from "@medianexus/shared";
import { UseGuards } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { validateNamingTemplate, namingPreview as buildNamingPreview } from "@medianexus/domain";
import type { DbHandle } from "@medianexus/database";
import { ZodValidationPipe } from "../common/zod.pipe";
import { redactDeep } from "../common/redact";
import { AdminGuard } from "../common/admin.guard";
import { DB_HANDLE_TOKEN } from "../db/database.module";
import { SystemStatusService } from "./system-status.service";
import { ConfigService } from "./config.service";
import { BackupService } from "./backup.service";
import { ParseService } from "./parse.service";
import { LogsService } from "./logs.service";
import { UpdateCheckService } from "./update-check.service";

const upsertSchema = z.record(z.string(), z.unknown());

// Multer cap for the LAN-admin upload endpoint. Comfortably fits a real library DB (the
// *arr single-file DBs are typically tens of MB to a few hundred MB; this leaves headroom).
const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB

// Give the restore HTTP response time to flush to the client on a LAN before the process
// dies. Nest's shutdown hook does NOT call process.exit() itself, so we close the DB handle
// and exit explicitly — docker compose's `restart: unless-stopped` relaunches the container.
const RESTART_DELAY_MS = 600;

/** Minimal structural shape of the file multer hands to the upload handler (no @types/multer
 *  is installed; this is the only subset we read). */
interface UploadedBackupFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

@ApiTags("system")
@Controller("api/v1/system")
export class SystemController {
  constructor(
    private readonly statusSvc: SystemStatusService,
    private readonly configSvc: ConfigService,
    private readonly backupSvc: BackupService,
    private readonly parseSvc: ParseService,
    private readonly logsSvc: LogsService,
    private readonly updateCheckSvc: UpdateCheckService,
    @Inject(DB_HANDLE_TOKEN) private readonly dbHandle: DbHandle,
  ) {}

  @Get("logs")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Recent in-memory log entries (admin; most-recent-first, redacted). NOT persisted — restarts clear the buffer; docker logs holds the full, unredacted history." })
  async logs(@Query("limit") limit?: string, @Query("level") level?: string, @Query("search") search?: string) {
    return this.logsSvc.latest(limit ? Number(limit) : undefined, level || undefined, search || undefined);
  }

  @Get("parse")
  @ApiOperation({ summary: "Parse a raw release title (debug): run the release-title + episode parsers and a best-effort library match" })
  async parse(@Query("title") title: string) {
    if (!title || !title.trim()) throw new ApiError({ code: "VALIDATION_ERROR", message: "title query param is required" });
    return this.parseSvc.parse(title.trim());
  }

  @Get("update-check")
  @ApiOperation({ summary: "Cached result of the last system.updateCheck run (is a newer release available?). Never performs a network call — reads the in-memory cache the job populates; 'checked: false' until the first successful check." })
  updateCheck() {
    return this.updateCheckSvc.get();
  }

  @Get("backups")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "List backup files produced by the system.backup job (admin)" })
  async backups() {
    return this.backupSvc.list();
  }

  @Post("backups/:name/restore")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Restore the named backup in place (admin). Replaces the ENTIRE live database, then the app restarts automatically." })
  async restoreBackup(@Param("name") name: string) {
    // The file swap + safety copy + audit insert all complete inside restore() before it
    // returns, so a rejection here means the live DB was never touched. Only after the swap
    // succeeds do we arm the restart.
    const result = await this.backupSvc.restore(name);
    setTimeout(() => {
      try {
        this.dbHandle.close();
      } catch {
        /* connection already gone */
      }
      process.exit(0);
    }, RESTART_DELAY_MS);
    return result;
  }

  @Get("backups/:name/download")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Download the named backup file (admin)" })
  async downloadBackup(@Param("name") name: string) {
    const dl = await this.backupSvc.openDownload(name);
    return new StreamableFile(dl.stream, {
      type: "application/octet-stream",
      disposition: `attachment; filename="${dl.name}"`,
    });
  }

  @Post("backups/upload")
  @UseGuards(AdminGuard)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: UPLOAD_MAX_BYTES } }))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Upload a MediaNexus backup file (admin). Validated then added to the backups list; restoring it is a separate deliberate action." })
  async uploadBackup(@UploadedFile() file: UploadedBackupFile) {
    if (!file || !Buffer.isBuffer(file.buffer) || file.size === 0) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "No file uploaded (expected multipart field 'file')" });
    }
    return this.backupSvc.upload(file.buffer, file.originalname);
  }

  @Get("status")
  @ApiOperation({ summary: "Application status" })
  status() {
    return this.statusSvc.status();
  }

  @Get("config")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Global settings (admin; credentials masked)" })
  async getConfig() {
    return redactDeep(await this.configSvc.get()) as never;
  }

  @Put("config")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Update global settings (admin)" })
  @ApiBody({ schema: { type: "object", additionalProperties: true } })
  async putConfig(@Body(new ZodValidationPipe(upsertSchema)) body: Record<string, unknown>) {
    const allowedKeys = new Set(Object.keys(runtimeSettingsSchema.shape));
    const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: `Unknown setting keys: ${unknownKeys.join(", ")}` });
    }
    const naming = body["media.naming"] as { movies?: unknown; episodes?: unknown } | undefined;
    if (naming) {
      if (typeof naming.movies === "string") {
        const result = validateNamingTemplate("movie", naming.movies);
        if (!result.valid) throw new ApiError({ code: "VALIDATION_ERROR", message: `media.naming.movies: ${result.error}` });
      }
      if (typeof naming.episodes === "string") {
        const result = validateNamingTemplate("episode", naming.episodes);
        if (!result.valid) throw new ApiError({ code: "VALIDATION_ERROR", message: `media.naming.episodes: ${result.error}` });
      }
    }
    return this.configSvc.upsert(body as never);
  }

  @Get("naming/preview")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Preview sample filenames for the given (or currently saved) naming templates" })
  async namingPreview(@Query("movieTemplate") movieTemplate?: string, @Query("episodeTemplate") episodeTemplate?: string) {
    const cfg = await this.configSvc.get();
    return buildNamingPreview(movieTemplate ?? cfg["media.naming"].movies, episodeTemplate ?? cfg["media.naming"].episodes);
  }
}
