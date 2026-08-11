// SPDX-License-Identifier: MIT
import { Body, Controller, Get, Post, Put, Req, Res, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { ApiError } from "@medianexus/shared";
import { AuthService } from "./auth.service";
import { LoginRateLimitGuard } from "./login-rate-limit.guard";
import { Public } from "../common/public.decorator";
import { buildSessionCookie, clearSessionCookie } from "./session-cookie";

@ApiTags("auth")
@Controller("api/v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get("whoami")
  @ApiOperation({ summary: "Identity of the calling API key or session" })
  whoami(@Req() req: Request) {
    return { principal: req.principal, isAuthenticated: Boolean(req.principal) };
  }

  @Get("status")
  @Public()
  @ApiOperation({ summary: "Whether the browser first-run setup (create admin account) still needs to happen" })
  async status() {
    return { setupRequired: !(await this.auth.hasAdminCredential()) };
  }

  @Post("setup")
  @Public()
  @ApiOperation({ summary: "First-run only: create the admin account and log the caller in" })
  async setup(@Body() body: { username?: string; password?: string }, @Res({ passthrough: true }) res: Response) {
    if (!body.username || !body.password || body.password.length < 8) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "username and a password (min 8 chars) are required" });
    }
    const { passwordVersion } = await this.auth.createAdminCredential(body.username, body.password);
    res.setHeader("Set-Cookie", buildSessionCookie(this.auth.issueSessionCookie(passwordVersion)));
    return { ok: true };
  }

  @Post("login")
  @Public()
  @UseGuards(LoginRateLimitGuard)
  @ApiOperation({ summary: "Log in with the admin username/password, issuing a session cookie" })
  async login(@Body() body: { username?: string; password?: string }, @Res({ passthrough: true }) res: Response) {
    const result = body.username && body.password ? await this.auth.verifyLogin(body.username, body.password) : null;
    if (!result) throw new ApiError({ code: "UNAUTHORIZED", message: "Invalid username or password" });
    res.setHeader("Set-Cookie", buildSessionCookie(this.auth.issueSessionCookie(result.passwordVersion)));
    return { ok: true };
  }

  @Post("logout")
  @Public()
  @ApiOperation({ summary: "Clear the session cookie" })
  logout(@Res({ passthrough: true }) res: Response) {
    res.setHeader("Set-Cookie", clearSessionCookie());
    return { ok: true };
  }

  @Put("password")
  @ApiOperation({ summary: "Change the admin password — invalidates every other existing session" })
  async changePassword(
    @Body() body: { currentPassword?: string; newPassword?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body.currentPassword || !body.newPassword || body.newPassword.length < 8) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "currentPassword and a newPassword (min 8 chars) are required" });
    }
    const { passwordVersion } = await this.auth.changePassword(body.currentPassword, body.newPassword);
    // re-issue a fresh cookie for the calling browser so it isn't logged out by its own password change
    res.setHeader("Set-Cookie", buildSessionCookie(this.auth.issueSessionCookie(passwordVersion)));
    return { ok: true };
  }

  @Post("regenerate-key")
  @ApiOperation({ summary: "Rotate the system API key — mints a new one, then invalidates the old one" })
  async regenerateKey() {
    return this.auth.regenerateApiKey();
  }

  @Get("key")
  @ApiOperation({ summary: "Reveal the system API key's raw value, for viewing/copying without rotating it" })
  async revealKey() {
    const rawKey = await this.auth.revealApiKey();
    return { rawKey };
  }
}
