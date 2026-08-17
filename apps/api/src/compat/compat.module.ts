// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { CompatService } from "./compat.service";
import { SystemModule } from "../system/system.module";
import { SeriesModule } from "../series/series.module";
import { MoviesModule } from "../movies/movies.module";
import { JobsModule } from "../jobs/jobs.module";
import { IndexersModule } from "../indexers/indexers.module";
import { CustomFormatsModule } from "../custom-formats/custom-formats.module";

@Module({
  imports: [SystemModule, SeriesModule, MoviesModule, JobsModule, IndexersModule, CustomFormatsModule],
  providers: [CompatService],
  exports: [CompatService],
})
export class CompatModule {}
