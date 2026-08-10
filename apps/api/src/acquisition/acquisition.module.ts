// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { AcquisitionService } from "./acquisition.service";
import { RssSyncService } from "./rss-sync.service";
import { SeriesModule } from "../series/series.module";
import { IndexersModule } from "../indexers/indexers.module";

@Module({
  imports: [SeriesModule, IndexersModule],
  providers: [AcquisitionService, RssSyncService],
  exports: [AcquisitionService, RssSyncService],
})
export class AcquisitionModule {}
