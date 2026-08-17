// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { SystemStatusService } from "./system-status.service";
import { SystemController } from "./system.controller";
import { ParseService } from "./parse.service";
import { LogsService } from "./logs.service";
import { LogBuffer, logBuffer } from "./log-buffer";
import { LogFileWriter, logFileWriter } from "./log-file-writer";
import { UpdateCheckService } from "./update-check.service";
import { SettingsModule } from "./settings.module";
import { AdminGuard } from "../common/admin.guard";
import { HousekeepingService } from "./housekeeping.service";
import { BackupService } from "./backup.service";

@Module({
  imports: [SettingsModule],
  providers: [
    SystemStatusService, AdminGuard, HousekeepingService, BackupService,
    ParseService, LogsService, UpdateCheckService, { provide: LogBuffer, useValue: logBuffer },
    { provide: LogFileWriter, useValue: logFileWriter },
  ],
  controllers: [SystemController],
  exports: [SystemStatusService, HousekeepingService, BackupService, LogBuffer, UpdateCheckService, LogFileWriter],
})
export class SystemModule {}
