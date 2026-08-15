// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { AutoTagsService } from "./auto-tags.service";
import { AutoTagsController } from "./auto-tags.controller";

@Module({
  providers: [AutoTagsService],
  controllers: [AutoTagsController],
  exports: [AutoTagsService],
})
export class AutoTagsModule {}
