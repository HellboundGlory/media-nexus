// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { RequestsService } from "./requests.service";
import { RequestsController } from "./requests.controller";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { RequestFulfillmentService } from "./request-fulfillment.service";
import { NotificationService } from "./notifications.service";
import { NotificationsController } from "./notifications.controller";
import { MediaServersService } from "./media-servers.service";
import { MediaServersController } from "./media-servers.controller";
import { RateLimitGuard } from "./rate-limit.guard";
import { IndexersModule } from "../indexers/indexers.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [IndexersModule, AuthModule],
  providers: [
    RequestsService,
    UsersService,
    RequestFulfillmentService,
    NotificationService,
    MediaServersService,
    RateLimitGuard,
  ],
  controllers: [RequestsController, UsersController, MediaServersController, NotificationsController],
  exports: [RequestsService, RequestFulfillmentService, NotificationService, MediaServersService, RateLimitGuard],
})
export class RequestsModule {}
