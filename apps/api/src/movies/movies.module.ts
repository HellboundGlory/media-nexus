// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { MoviesService } from "./movies.service";
import { MoviesController } from "./movies.controller";
import { AutoTagsModule } from "../auto-tags/auto-tags.module";
import { IndexersModule } from "../indexers/indexers.module";

@Module({
  imports: [AutoTagsModule, IndexersModule],
  providers: [MoviesService],
  controllers: [MoviesController],
  exports: [MoviesService],
})
export class MoviesModule {}
