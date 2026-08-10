// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { DrizzleJobStore } from "./drizzle-job.store";
import { JobsService } from "./jobs.service";
import { JobHandlers } from "./job.handlers";
import { JobsController } from "./jobs.controller";
import { AcquisitionModule } from "../acquisition/acquisition.module";
import { IndexersModule } from "../indexers/indexers.module";
import { RequestsModule } from "../requests/requests.module";

@Module({
  imports: [AcquisitionModule, IndexersModule, RequestsModule],
  providers: [DrizzleJobStore, JobsService, JobHandlers],
  controllers: [JobsController],
  exports: [JobsService],
})
export class JobsModule {}
