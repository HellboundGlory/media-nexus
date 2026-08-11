// SPDX-License-Identifier: MIT
import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { AdminGuard } from "../common/admin.guard";
import { NotificationService, type NotifyKind } from "./notifications.service";
import { ConfigService } from "../system/config.service";

const notifyBody = z.object({
  webhooks: z.array(z.any()).optional(),
  discord: z.array(z.any()).optional(),
  telegram: z.array(z.any()).optional(),
  email: z.array(z.any()).optional(),
});

@ApiTags("notifications")
@UseGuards(AdminGuard)
@Controller("api/v1/notifications")
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Current notification configuration" })
  async list() {
    const c = await this.config.get();
    return {
      webhooks: c["notifications.webhooks"] ?? [],
      discord: c["notifications.discord"] ?? [],
      telegram: c["notifications.telegram"] ?? [],
      email: c["notifications.email"] ?? [],
    };
  }

  @Put()
  @ApiOperation({ summary: "Save notification configuration (webhooks/discord/telegram/email)" })
  async save(@Body(new ZodValidationPipe(notifyBody)) body: z.infer<typeof notifyBody>) {
    const c = await this.config.get();
    return this.config.upsert({
      "notifications.webhooks": body.webhooks ?? (c["notifications.webhooks"] ?? []),
      "notifications.discord": body.discord ?? (c["notifications.discord"] ?? []),
      "notifications.telegram": body.telegram ?? (c["notifications.telegram"] ?? []),
      "notifications.email": body.email ?? (c["notifications.email"] ?? []),
    } as never);
  }

  @Post(":kind/:index/test")
  @ApiOperation({ summary: "Send a test notification to a configured sink" })
  test(@Param("kind") kind: string, @Param("index") index: string) {
    return this.notifications.test(kind as NotifyKind, Number(index));
  }
}
