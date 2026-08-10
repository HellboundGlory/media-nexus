// SPDX-License-Identifier: MIT
import { Injectable, Logger } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { buildSonarrV3Surface } from "@medianexus/compatibility";
import { SystemStatusService } from "../system/system-status.service";

/**
 * Mounts ecosystem-compatible surfaces (doc: docs/architecture/compatibility.md).
 * Only Sonarr v3 `system/status` is adapted today (proves the translation pattern);
 * everything else responds 501 explicitly. No compat surface touches native models.
 */
@Injectable()
export class CompatService {
  private readonly logger = new Logger(CompatService.name);
  private readonly sonarr = buildSonarrV3Surface({
    appVersion: () => "0.1.0",
    appName: () => "MediaNexus",
    started: () => this.status.startedAt.toISOString(),
    databaseVersion: () => "1",
  });

  constructor(private readonly status: SystemStatusService) {}

  /** Express handler mounted at /api/sonarr/v3 in main.ts. */
  async handle(req: Request, res: Response, next: NextFunction): Promise<void> {
    const path = `${req.baseUrl}${req.path}`;
    const hit = this.sonarr.match(req.method as never, path);
    if (!hit) {
      res.status(404).json({ message: `No compatible route for ${req.method} ${path}` });
      return;
    }
    hit.ctx.query = req.query as never;
    hit.ctx.headers = req.headers as never;
    hit.ctx.body = req.body;
    hit.ctx.apiKey = req.headers["x-api-key"] as string | undefined;
    try {
      const result = await hit.route.handler(hit.ctx);
      res.status(result.status).json(result.body);
    } catch (err) {
      this.logger.error("compat handler failed", err as Error);
      next(err);
    }
  }
}
