// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { SystemStatusService } from "./system-status.service";
import { ConfigService } from "./config.service";
import { SystemController } from "./system.controller";
import { JobsModule } from "../jobs/jobs.module";

@Module({
  imports: [JobsModule],
  providers: [SystemStatusService, ConfigService],
  controllers: [SystemController],
  exports: [SystemStatusService],
})
export class SystemModule {}
