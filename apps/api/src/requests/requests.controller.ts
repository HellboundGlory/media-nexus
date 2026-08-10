// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request as ExpressRequest } from "express";
import { z } from "zod";
import { ApiError } from "@medianexus/shared";
import { createRequestSchema, type CreateRequest } from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { RequestsService } from "./requests.service";

const statusSchema = z.object({});
const mediaRefSchema = z.object({ mediaType: z.enum(["movie", "series"]), mediaId: z.string() });

@ApiTags("requests")
@Controller()
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get("api/v1/requests")
  @ApiOperation({ summary: "List user requests (admins: all; users: own)" })
  list(@Req() req: ExpressRequest) {
    return this.requests.list({ principal: req.principal });
  }

  @Post("api/v1/requests")
  @ApiOperation({ summary: "Create a request (movies/series)" })
  create(@Body(new ZodValidationPipe(createRequestSchema)) body: CreateRequest, @Req() req: ExpressRequest) {
    return this.requests.create(body, req.principal);
  }

  @Post("api/v1/requests/:id/approve")
  @ApiOperation({ summary: "Approves a request (triggers auto-search)" })
  approve(@Param("id") id: string, @Body(new ZodValidationPipe(statusSchema)) _: unknown, @Req() req: ExpressRequest) {
    return this.requests.setStatus(id, "approved", req.principal);
  }

  @Post("api/v1/requests/:id/decline")
  @ApiOperation({ summary: "Declines a request" })
  decline(@Param("id") id: string, @Body(new ZodValidationPipe(statusSchema)) _: unknown, @Req() req: ExpressRequest) {
    return this.requests.setStatus(id, "declined", req.principal);
  }

  // ---------- watchlist & content blocklist (principal-scoped) ----------

  @Get("api/v1/watchlist")
  @ApiOperation({ summary: "Current user's watchlist" })
  watchlist(@Req() req: ExpressRequest) {
    return this.requests.watchlist(req.principal?.userId ?? null);
  }

  @Post("api/v1/watchlist")
  @ApiOperation({ summary: "Add to watchlist" })
  addWatchlist(@Body(new ZodValidationPipe(mediaRefSchema)) body: { mediaType: "movie" | "series"; mediaId: string }, @Req() req: ExpressRequest) {
    return this.requests.addWatchlist(requireUserId(req), body.mediaType, body.mediaId);
  }

  @Delete("api/v1/watchlist/:mediaType/:mediaId")
  @ApiOperation({ summary: "Remove from watchlist" })
  removeWatchlist(@Param("mediaType") mediaType: string, @Param("mediaId") mediaId: string, @Req() req: ExpressRequest) {
    return this.requests.removeWatchlist(requireUserId(req), mediaType, mediaId);
  }

  @Get("api/v1/content-blocklist")
  @ApiOperation({ summary: "Current user's content blocklist" })
  blocklist(@Req() req: ExpressRequest) {
    return this.requests.contentBlocklist(req.principal?.userId ?? null);
  }

  @Post("api/v1/content-blocklist")
  @ApiOperation({ summary: "Add to content blocklist" })
  addBlocklist(@Body(new ZodValidationPipe(mediaRefSchema)) body: { mediaType: "movie" | "series"; mediaId: string }, @Req() req: ExpressRequest) {
    return this.requests.addContentBlocklist(requireUserId(req), body.mediaType, body.mediaId);
  }

  @Delete("api/v1/content-blocklist/:mediaType/:mediaId")
  @ApiOperation({ summary: "Remove from content blocklist" })
  removeBlocklist(@Param("mediaType") mediaType: string, @Param("mediaId") mediaId: string, @Req() req: ExpressRequest) {
    return this.requests.removeContentBlocklist(requireUserId(req), mediaType, mediaId);
  }
}

function requireUserId(req: ExpressRequest): string {
  if (!req.principal?.userId) throw new ApiError({ code: "UNAUTHORIZED", message: "A user-bound API key is required" });
  return req.principal.userId;
}
