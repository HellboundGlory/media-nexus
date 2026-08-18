// SPDX-License-Identifier: MIT
import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DatabaseModule } from "./db/database.module";
import { MediaModule } from "./media/media.module";
import { MediaFilesModule } from "./media/media-files.module";
import { BlocklistModule } from "./blocklist/blocklist.module";
import { DecisionModule } from "./decision/decision.module";
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
import { LibraryScanModule } from "./library-scan/library-scan.module";
import { CompatModule } from "./compat/compat.module";
import { RootFoldersModule } from "./root-folders/root-folders.module";
import { RemotePathMappingsModule } from "./remote-path-mappings/remote-path-mappings.module";
import { TagsModule } from "./tags/tags.module";
import { ImportListsModule } from "./import-lists/import-lists.module";
import { CustomFormatsModule } from "./custom-formats/custom-formats.module";
import { ReleaseProfilesModule } from "./release-profiles/release-profiles.module";
import { CollectionsModule } from "./collections/collections.module";
import { AutoTagsModule } from "./auto-tags/auto-tags.module";
import { WebUiModule } from "./web-ui/web-ui.module";
import { RequestIdMiddleware } from "./common/request-id.middleware";
import { MetricsMiddleware } from "./observability/metrics.middleware";
import { SecurityHeadersMiddleware } from "./common/security-headers.middleware";

@Module({
  imports: [
    DatabaseModule,
    MediaModule,
    MediaFilesModule,
    BlocklistModule,
    DecisionModule,
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
    LibraryScanModule,
    RealtimeModule,
    ObservabilityModule,
    CompatModule,
    RootFoldersModule,
    RemotePathMappingsModule,
    TagsModule,
    ImportListsModule,
    CustomFormatsModule,
    ReleaseProfilesModule,
    CollectionsModule,
    AutoTagsModule,
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
