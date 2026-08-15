// SPDX-License-Identifier: MIT
import { Body, Controller, Get, Put, Query } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ApiError, runtimeSettingsSchema } from "@medianexus/shared";
import { UseGuards } from "@nestjs/common";
import { validateNamingTemplate, namingPreview as buildNamingPreview } from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { redactDeep } from "../common/redact";
import { AdminGuard } from "../common/admin.guard";
import { SystemStatusService } from "./system-status.service";
import { ConfigService } from "./config.service";
import { BackupService } from "./backup.service";
import { ParseService } from "./parse.service";
import { LogsService } from "./logs.service";

const upsertSchema = z.record(z.string(), z.unknown());

@ApiTags("system")
@Controller("api/v1/system")
export class SystemController {
  constructor(
    private readonly statusSvc: SystemStatusService,
    private readonly configSvc: ConfigService,
    private readonly backupSvc: BackupService,
    private readonly parseSvc: ParseService,
    private readonly logsSvc: LogsService,
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

  @Get("backups")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "List backup files produced by the system.backup job (admin)" })
  async backups() {
    return this.backupSvc.list();
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
