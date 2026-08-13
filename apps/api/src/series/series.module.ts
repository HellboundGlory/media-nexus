// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { SeriesService } from "./series.service";
import { SeriesController } from "./series.controller";
import { WantedController } from "./wanted.controller";
import { MoviesModule } from "../movies/movies.module";

@Module({
  imports: [MoviesModule],
  providers: [SeriesService],
  controllers: [SeriesController, WantedController],
  exports: [SeriesService],
})
export class SeriesModule {}
