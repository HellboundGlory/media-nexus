// SPDX-License-Identifier: MIT
import { Controller, Get, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

@ApiTags("auth")
@Controller("api/v1/auth")
export class AuthController {
  @Get("whoami")
  @ApiOperation({ summary: "Identity of the calling API key" })
  whoami(@Req() req: Request) {
    return { principal: req.principal, isAuthenticated: Boolean(req.principal) };
  }
}
