// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { UsersService, type CreateUserInput } from "./users.service";
import { AdminGuard } from "./admin.guard";

const createUserBody = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(256),
  email: z.string().email().optional(),
  isAdmin: z.boolean().optional(), // default false unless explicitly set
  roles: z.array(z.enum(["ADMIN", "MODERATOR", "USER"])).optional(),
});
const createKeyBody = z.object({ name: z.string().min(1).default("user-key") });

@UseGuards(AdminGuard)
@ApiTags("users")
@Controller("api/v1/users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: "List users (admin)" })
  list() { return this.users.list(); }

  @Post()
  @ApiOperation({ summary: "Create a user (admin)" })
  create(@Body(new ZodValidationPipe(createUserBody)) body: CreateUserInput) { return this.users.create(body); }

  @Post(":id/api-keys")
  @ApiOperation({ summary: "Create a user-scoped API key (raw shown once)" })
  createKey(@Param("id") id: string, @Body(new ZodValidationPipe(createKeyBody)) body: { name: string }) { return this.users.createApiKey(id, body.name); }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a user (admin)" })
  remove(@Param("id") id: string) { return this.users.remove(id); }
}
