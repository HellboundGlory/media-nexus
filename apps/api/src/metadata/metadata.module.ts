// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { MetadataService } from "./metadata.service";
import { MetadataController } from "./metadata.controller";
import { AdminGuard } from "../common/admin.guard";
import { MoviesModule } from "../movies/movies.module";
import { SeriesModule } from "../series/series.module";

@Module({
  imports: [MoviesModule, SeriesModule],
  providers: [MetadataService, AdminGuard],
  controllers: [MetadataController],
  exports: [MetadataService],
})
export class MetadataModule {}
