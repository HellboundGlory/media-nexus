// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { MetadataService } from "./metadata.service";
import { MetadataController } from "./metadata.controller";
import { AdminGuard } from "../common/admin.guard";
import { MoviesModule } from "../movies/movies.module";
import { SeriesModule } from "../series/series.module";
import { AutoTagsModule } from "../auto-tags/auto-tags.module";

@Module({
  imports: [MoviesModule, SeriesModule, AutoTagsModule],
  providers: [MetadataService, AdminGuard],
  controllers: [MetadataController],
  exports: [MetadataService],
})
export class MetadataModule {}
