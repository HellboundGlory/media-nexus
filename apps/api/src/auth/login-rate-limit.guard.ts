// SPDX-License-Identifier: MIT
import { Injectable } from "@nestjs/common";
import { RateLimitGuard } from "../common/rate-limit.guard";

/**
 * Tighter limit than the default RateLimitGuard (120/min) — login attempts are a
 * brute-force target. Registered as its own AuthModule provider, so it gets its own
 * bucket Map/config, independent of the default-configured instance guarding /grabs.
 */
@Injectable()
export class LoginRateLimitGuard extends RateLimitGuard {
  constructor() {
    super();
    this.configure(5 * 60_000, 5); // 5 attempts per 5 minutes per IP
  }
}
