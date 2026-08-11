// SPDX-License-Identifier: MIT
import { Controller, Get, NotFoundException, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Public } from "../common/public.decorator";

export const WEB_DIR = process.env.MEDIA_NEXUS_WEB_DIR ?? "/app/web";

/**
 * Serves the built web UI's index.html for any path not otherwise handled — SPA
 * client-side routing (e.g. /movies, /series/:id) — so one process/port serves both
 * the API and the UI (no separate web/nginx container). Registered as the last module
 * so real API/compat routes always match first; unmatched /api|health|metrics paths
 * still 404 as JSON instead of falling back to the SPA shell.
 */
@Controller()
export class WebUiController {
  // Express 5 / Nest 11 wildcard: "*splat" alone requires >=1 segment and misses "/",
  // so root is listed explicitly alongside it.
  @Get(["/", "*splat"])
  @Public()
  index(@Req() req: Request, @Res() res: Response): void {
    if (/^\/(api|health|metrics)(\/|$)/.test(req.path)) throw new NotFoundException();
    const indexPath = join(WEB_DIR, "index.html");
    if (!existsSync(indexPath)) throw new NotFoundException();
    res.sendFile(indexPath);
  }
}
