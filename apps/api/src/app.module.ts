// SPDX-License-Identifier: MIT
import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DatabaseModule } from "./db/database.module";
import { MediaModule } from "./media/media.module";
import { EventsModule } from "./events/events.module";
import { AuthModule } from "./auth/auth.module";
import { ApiKeyGuard } from "./auth/api-key.guard";
import { HealthModule } from "./health/health.module";
import { SystemModule } from "./system/system.module";
import { SettingsModule } from "./system/settings.module";
import { JobsModule } from "./jobs/jobs.module";
import { DemoProvidersModule } from "./providers/demo.providers";
import { MoviesModule } from "./movies/movies.module";
import { QualityProfilesModule } from "./quality-profiles/quality-profiles.module";
import { SeriesModule } from "./series/series.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { MediaServersModule } from "./media-servers/media-servers.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { ObservabilityModule } from "./observability/observability.module";
import { ActivityModule } from "./activity/activity.module";
import { IndexersModule } from "./indexers/indexers.module";
import { DownloadClientsModule } from "./download-clients/download-clients.module";
import { MetadataModule } from "./metadata/metadata.module";
import { CompatModule } from "./compat/compat.module";
import { WebUiModule } from "./web-ui/web-ui.module";
import { RequestIdMiddleware } from "./common/request-id.middleware";
import { MetricsMiddleware } from "./observability/metrics.middleware";
import { SecurityHeadersMiddleware } from "./common/security-headers.middleware";

@Module({
  imports: [
    DatabaseModule,
    MediaModule,
    EventsModule,
    AuthModule,
    HealthModule,
    SystemModule,
    SettingsModule,
    JobsModule,
    DemoProvidersModule,
    MoviesModule,
    QualityProfilesModule,
    SeriesModule,
    NotificationsModule,
    MediaServersModule,
    ActivityModule,
    IndexersModule,
    DownloadClientsModule,
    MetadataModule,
    RealtimeModule,
    ObservabilityModule,
    CompatModule,
    // Must stay last: its catch-all route serves the SPA shell only when nothing
    // above it (native/compat routes) matched.
    WebUiModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SecurityHeadersMiddleware, RequestIdMiddleware, MetricsMiddleware).forRoutes("*");
  }
}
