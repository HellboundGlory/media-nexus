// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { HealthStatusController } from "./health-status.controller";
import { HealthCheckService } from "./health-check.service";

@Module({
  controllers: [HealthController, HealthStatusController],
  providers: [HealthCheckService],
  exports: [HealthCheckService],
})
export class HealthModule {}
