// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { QualityProfilesService } from "./quality-profiles.service";
import { QualityProfilesController } from "./quality-profiles.controller";

@Module({
  providers: [QualityProfilesService],
  controllers: [QualityProfilesController],
  exports: [QualityProfilesService],
})
export class QualityProfilesModule {}
