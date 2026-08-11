// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { SystemStatusService } from "./system-status.service";
import { SystemController } from "./system.controller";
import { SettingsModule } from "./settings.module";
import { AdminGuard } from "../requests/admin.guard";

@Module({
  imports: [SettingsModule],
  providers: [SystemStatusService, AdminGuard],
  controllers: [SystemController],
  exports: [SystemStatusService],
})
export class SystemModule {}
