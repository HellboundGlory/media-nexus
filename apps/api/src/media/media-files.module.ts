// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { MediaFilesService } from "./media-files.service";
import { MediaFilesController } from "./media-files.controller";

@Module({
  providers: [MediaFilesService],
  controllers: [MediaFilesController],
  exports: [MediaFilesService],
})
export class MediaFilesModule {}
