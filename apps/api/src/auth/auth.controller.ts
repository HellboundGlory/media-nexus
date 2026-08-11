// SPDX-License-Identifier: MIT
import { Controller, Get, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { AuthService } from "./auth.service";

@ApiTags("auth")
@Controller("api/v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get("whoami")
  @ApiOperation({ summary: "Identity of the calling API key" })
  whoami(@Req() req: Request) {
    return { principal: req.principal, isAuthenticated: Boolean(req.principal) };
  }

  @Post("regenerate-key")
  @ApiOperation({ summary: "Rotate the calling API key — mints a new one, then invalidates this one" })
  async regenerateKey(@Req() req: Request) {
    // create-then-delete: if anything fails after creation, the old key still works
    // (no lockout); the reverse order risks a window with zero valid keys.
    const { rawKey } = await this.auth.createApiKey({ name: "system (rotated)" });
    await this.auth.deleteApiKey(req.principal!.keyId);
    return { rawKey };
  }

  @Get("key")
  @ApiOperation({ summary: "Reveal the calling API key's raw value, for viewing/copying without rotating it" })
  async revealKey(@Req() req: Request) {
    const rawKey = await this.auth.revealApiKey(req.principal!.keyId);
    return { rawKey };
  }
}
