// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { MediaServersService } from "./media-servers.service";
import { MediaServersController } from "./media-servers.controller";

@Module({
  providers: [MediaServersService],
  controllers: [MediaServersController],
  exports: [MediaServersService],
})
export class MediaServersModule {}
