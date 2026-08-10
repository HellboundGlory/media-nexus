// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { SystemStatusService } from "./system-status.service";
import { SystemController } from "./system.controller";
import { SettingsModule } from "./settings.module";

@Module({
  imports: [SettingsModule],
  providers: [SystemStatusService],
  controllers: [SystemController],
  exports: [SystemStatusService],
})
export class SystemModule {}
