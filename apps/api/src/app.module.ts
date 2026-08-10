// SPDX-License-Identifier: MIT
import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DatabaseModule } from "./db/database.module";
import { EventsModule } from "./events/events.module";
import { AuthModule } from "./auth/auth.module";
import { ApiKeyGuard } from "./auth/api-key.guard";
import { HealthModule } from "./health/health.module";
import { SystemModule } from "./system/system.module";
import { SettingsModule } from "./system/settings.module";
import { JobsModule } from "./jobs/jobs.module";
import { DemoProvidersModule } from "./providers/demo.providers";
import { MoviesModule } from "./movies/movies.module";
import { SeriesModule } from "./series/series.module";
import { RequestsModule } from "./requests/requests.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { ObservabilityModule } from "./observability/observability.module";
import { ActivityModule } from "./activity/activity.module";
import { IndexersModule } from "./indexers/indexers.module";
import { DownloadClientsModule } from "./download-clients/download-clients.module";
import { CompatModule } from "./compat/compat.module";
import { RequestIdMiddleware } from "./common/request-id.middleware";
import { MetricsMiddleware } from "./observability/metrics.middleware";

@Module({
  imports: [
    DatabaseModule,
    EventsModule,
    AuthModule,
    HealthModule,
    SystemModule,
    SettingsModule,
    JobsModule,
    DemoProvidersModule,
    MoviesModule,
    SeriesModule,
    RequestsModule,
    ActivityModule,
    IndexersModule,
    DownloadClientsModule,
    RealtimeModule,
    ObservabilityModule,
    CompatModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware, MetricsMiddleware).forRoutes("*");
  }
}
