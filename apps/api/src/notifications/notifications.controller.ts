// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { AdminGuard } from "../common/admin.guard";
import { NotificationService } from "./notifications.service";

const createBody = z.object({
  kind: z.enum(["webhook", "discord", "telegram", "email"]),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  eventTypes: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
const updateBody = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  eventTypes: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

@ApiTags("notifications")
@UseGuards(AdminGuard)
@Controller("api/v1/notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: "Configured notification sinks (webhook/discord/telegram/email)" })
  list() {
    return this.notifications.list();
  }

  @Post()
  @ApiOperation({ summary: "Create a notification sink" })
  create(@Body(new ZodValidationPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.notifications.create(body);
  }

  @Put(":id")
  @ApiOperation({ summary: "Edit a notification sink ([REDACTED] secret means unchanged)" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return this.notifications.update(id, body);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a notification sink" })
  remove(@Param("id") id: string) {
    return this.notifications.remove(id);
  }

  @Post(":id/test")
  @ApiOperation({ summary: "Send a test notification to a configured sink" })
  test(@Param("id") id: string) {
    return this.notifications.test(id);
  }
}
