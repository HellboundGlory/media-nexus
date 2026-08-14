// SPDX-License-Identifier: MIT
import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { HealthCheckService } from "./health-check.service";

/** Detailed health-check results (roadmap P1, gap report B9) — deliberately not under the
 *  bare `/health/*` prefix `HealthController` owns, since `ApiKeyGuard` treats that as a
 *  public-path *prefix* match (see apps/api/src/auth/api-key.guard.ts) and this endpoint
 *  should require the same auth as the rest of `/api/v1/system/*`. */
@ApiTags("system")
@Controller("api/v1/system")
export class HealthStatusController {
  constructor(private readonly healthCheck: HealthCheckService) {}

  @Get("health")
  @ApiOperation({ summary: "Last health-check run's results (persisted, not re-run live)" })
  async health() {
    return this.healthCheck.latest();
  }
}
