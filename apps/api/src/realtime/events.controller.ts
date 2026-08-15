
// SPDX-License-Identifier: MIT
import { Controller, Header, Req, Sse } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { MessageEvent } from "@nestjs/common";
import type { Request } from "express";
import { Observable } from "rxjs";
import { RealtimeService } from "./realtime.service";

@ApiTags("realtime")
@Controller("api/v1/events")
export class EventsController {
  constructor(private readonly realtime: RealtimeService) {}

  @Sse()
  @Header("Cache-Control", "no-cache")
  @ApiOperation({ summary: "Server-Sent Events stream (all domain events)" })
  stream(@Req() req: Request): Observable<MessageEvent> {
    // SSE reconnect catch-up (roadmap P2, gap H6): the client sends the last event id it
    // received; replay exactly the gap from the durable outbox, then continue live.
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    return this.realtime.streamSince(lastEventId || undefined);
  }
}
