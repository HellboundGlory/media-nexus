// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { NotificationService } from "./notifications.service";
import { NotificationsController } from "./notifications.controller";

@Module({
  providers: [NotificationService],
  controllers: [NotificationsController],
  exports: [NotificationService],
})
export class NotificationsModule {}
