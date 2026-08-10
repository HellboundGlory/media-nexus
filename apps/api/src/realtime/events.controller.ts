
// SPDX-License-Identifier: MIT
import { Controller, Header, Sse } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import { RealtimeService } from "./realtime.service";

@ApiTags("realtime")
@Controller("api/v1/events")
export class EventsController {
  constructor(private readonly realtime: RealtimeService) {}

  @Sse()
  @Header("Cache-Control", "no-cache")
  @ApiOperation({ summary: "Server-Sent Events stream (all domain events)" })
  stream(): Observable<MessageEvent> {
    return this.realtime.stream();
  }
}
