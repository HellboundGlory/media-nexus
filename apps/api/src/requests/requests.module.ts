// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { RequestsService } from "./requests.service";
import { RequestsController } from "./requests.controller";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { RequestFulfillmentService } from "./request-fulfillment.service";
import { NotificationService } from "./notifications.service";
import { MediaServersService } from "./media-servers.service";
import { MediaServersController } from "./media-servers.controller";
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
  ],
  controllers: [RequestsController, UsersController, MediaServersController],
  exports: [RequestsService, RequestFulfillmentService, NotificationService, MediaServersService],
})
export class RequestsModule {}
