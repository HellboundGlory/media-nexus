// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { MetricsService, sharedMetrics } from "./metrics.service";
import { MetricsMiddleware } from "./metrics.middleware";
import { MetricsController } from "./metrics.controller";
import { AuditController } from "./audit.controller";
import { DB_TOKEN } from "../db/database.module";
import type { Db } from "@medianexus/database";

@Module({
  providers: [
    {
      // The middleware imports `sharedMetrics` directly (SSE-safe design), so the DI
      // instance must BE that same singleton — wire the DB into it at bootstrap so the
      // DB-sourced gauges in render() have their data source.
      provide: MetricsService,
      useFactory: (db: Db) => {
        sharedMetrics.setDb(db);
        return sharedMetrics;
      },
      inject: [DB_TOKEN],
    },
    MetricsMiddleware,
  ],
  controllers: [MetricsController, AuditController],
  exports: [MetricsService, MetricsMiddleware],
})
export class ObservabilityModule {}
