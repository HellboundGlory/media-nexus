// SPDX-License-Identifier: MIT
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiError } from "@medianexus/shared";
import { AuthService } from "./auth.service";
import { IS_PUBLIC_KEY } from "../common/public.decorator";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const url = req.originalUrl ?? req.url ?? "";
    // explicit public paths (metrics/docs/health) regardless of decorator bookkeeping
    if (url === "/metrics" || url.startsWith("/api/docs") || url.startsWith("/health") || url.startsWith("/api/v1/system/status")) return true;
    const raw = req.headers["x-api-key"];
    if (!raw || typeof raw !== "string") {
      throw new ApiError({ code: "UNAUTHORIZED", message: "Missing X-Api-Key header" });
    }
    const principal = await this.auth.authenticateKey(raw.trim());
    if (!principal) {
      throw new ApiError({ code: "UNAUTHORIZED", message: "Invalid API key" });
    }
    req.principal = principal;
    return true;
  }
}
