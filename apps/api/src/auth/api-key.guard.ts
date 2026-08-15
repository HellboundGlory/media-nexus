// SPDX-License-Identifier: MIT
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiError } from "@medianexus/shared";
import { AuthService } from "./auth.service";
import { IS_PUBLIC_KEY } from "../common/public.decorator";
import { readSessionCookie } from "./session-cookie";

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
    if (raw && typeof raw === "string") {
      const principal = await this.auth.authenticateKey(raw.trim());
      if (!principal) {
        throw new ApiError({ code: "UNAUTHORIZED", message: "Invalid API key" });
      }
      req.principal = principal;
      return true;
    }

    // iCal calendar feed only: external calendar apps (Google/Apple) subscribe by URL and can't send
    // an X-Api-Key header or hold a session cookie, so accept the API key as a `?apikey=` query param
    // on THIS route specifically (the long-established *arr calendar-feed convention). Scoped to
    // exactly this path — deliberately NOT a general query-param auth mechanism — and the key is
    // still required (the feed is never unauthenticated; it would leak library contents).
    if (url.startsWith("/api/v1/calendar/ical") && typeof req.query?.apikey === "string" && req.query.apikey.length > 0) {
      const principal = await this.auth.authenticateKey(req.query.apikey.trim());
      if (!principal) throw new ApiError({ code: "UNAUTHORIZED", message: "Invalid API key" });
      req.principal = principal;
      return true;
    }

    // no X-Api-Key header — fall back to a browser session cookie
    const sessionValue = readSessionCookie(req);
    if (sessionValue) {
      const principal = await this.auth.verifySessionCookie(sessionValue);
      if (principal) {
        req.principal = principal;
        return true;
      }
    }

    throw new ApiError({ code: "UNAUTHORIZED", message: "Missing X-Api-Key header" });
  }
}
