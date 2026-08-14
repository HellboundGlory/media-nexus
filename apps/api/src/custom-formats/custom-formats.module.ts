// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { CustomFormatsService } from "./custom-formats.service";
import { CustomFormatsController } from "./custom-formats.controller";

@Module({
  providers: [CustomFormatsService],
  controllers: [CustomFormatsController],
  exports: [CustomFormatsService],
})
export class CustomFormatsModule {}
