// SPDX-License-Identifier: MIT
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ApiError } from "@medianexus/shared";

/**
 * Minimal in-process rate limiter (M5) for sensitive write endpoints
 * (requests, grabs). Generous per-IP windowed bucket; single-instance safe.
 * Real distributed limiting: route behind a proxy/Redis (documented).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();
  private windowMs = 60_000;
  private max = 120;

  /** Optional tuning for tests; defaults are generous (120/min/IP per route). */
  configure(windowMs: number, max: number): this {
    this.windowMs = windowMs;
    this.max = max;
    return this;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const key = this.key(req);
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    bucket.count++;
    if (bucket.count > this.max) {
      throw new ApiError({ code: "RATE_LIMITED", message: "Too many requests — slow down" });
    }
    return true;
  }

  private key(req: import("express").Request): string {
    const fwd = req.headers["x-forwarded-for"];
    const ip = typeof fwd === "string" ? fwd.split(",")[0].trim() : (req.socket?.remoteAddress ?? "local");
    return `${ip}:${req.route?.path ?? req.originalUrl}`;
  }
}
