// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { ReleaseProfilesService } from "./release-profiles.service";
import { ReleaseProfilesController } from "./release-profiles.controller";

@Module({
  providers: [ReleaseProfilesService],
  controllers: [ReleaseProfilesController],
  exports: [ReleaseProfilesService],
})
export class ReleaseProfilesModule {}
