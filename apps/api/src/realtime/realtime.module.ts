// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { RealtimeService } from "./realtime.service";
import { EventsController } from "./events.controller";

@Module({
  providers: [RealtimeService],
  controllers: [EventsController],
  exports: [RealtimeService],
})
export class RealtimeModule {}
