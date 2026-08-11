// SPDX-License-Identifier: MIT
import { Global, Module } from "@nestjs/common";
import { EventBus } from "@medianexus/events";
import { EventsService } from "./events.service";
import { AuditListener } from "./audit.listener";

@Global()
@Module({
  providers: [
    EventBus,
    EventsService,
    AuditListener,
  ],
  exports: [EventBus, EventsService],
})
export class EventsModule {}
