// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { SeriesService } from "./series.service";
import { SeriesController } from "./series.controller";
import { WantedController } from "./wanted.controller";
import { MoviesModule } from "../movies/movies.module";
import { AutoTagsModule } from "../auto-tags/auto-tags.module";
import { IndexersModule } from "../indexers/indexers.module";

@Module({
  imports: [MoviesModule, AutoTagsModule, IndexersModule],
  providers: [SeriesService],
  controllers: [SeriesController, WantedController],
  exports: [SeriesService],
})
export class SeriesModule {}
