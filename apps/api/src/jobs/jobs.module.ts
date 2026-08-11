// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { DrizzleJobStore } from "./drizzle-job.store";
import { JobsService } from "./jobs.service";
import { JobHandlers } from "./job.handlers";
import { JobsController } from "./jobs.controller";
import { AcquisitionModule } from "../acquisition/acquisition.module";
import { IndexersModule } from "../indexers/indexers.module";
import { MediaServersModule } from "../media-servers/media-servers.module";
import { MetadataModule } from "../metadata/metadata.module";

@Module({
  imports: [AcquisitionModule, IndexersModule, MediaServersModule, MetadataModule],
  providers: [DrizzleJobStore, JobsService, JobHandlers],
  controllers: [JobsController],
  exports: [JobsService],
})
export class JobsModule {}
