// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { WebUiController } from "./web-ui.controller";

@Module({
  controllers: [WebUiController],
})
export class WebUiModule {}
