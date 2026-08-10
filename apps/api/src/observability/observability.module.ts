// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { MetricsService, sharedMetrics } from "./metrics.service";
import { MetricsMiddleware } from "./metrics.middleware";
import { MetricsController } from "./metrics.controller";
import { AuditController } from "./audit.controller";

@Module({
  providers: [{ provide: MetricsService, useValue: sharedMetrics }, MetricsMiddleware],
  controllers: [MetricsController, AuditController],
  exports: [MetricsService, MetricsMiddleware],
})
export class ObservabilityModule {}
