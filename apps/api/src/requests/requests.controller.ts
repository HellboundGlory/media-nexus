// SPDX-License-Identifier: MIT
import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request as ExpressRequest } from "express";
import { z } from "zod";
import { createRequestSchema, type CreateRequest } from "@medianexus/domain";
import { ZodValidationPipe } from "../common/zod.pipe";
import { RequestsService } from "./requests.service";

const statusSchema = z.object({});

@ApiTags("requests")
@Controller("api/v1/requests")
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get()
  @ApiOperation({ summary: "List user requests" })
  list() {
    return this.requests.list();
  }

  @Post()
  @ApiOperation({ summary: "Create a request (movies/series)" })
  create(@Body(new ZodValidationPipe(createRequestSchema)) body: CreateRequest, @Req() req: ExpressRequest) {
    return this.requests.create(body, req.principal);
  }

  @Post(":id/approve")
  @ApiOperation({ summary: "Approves a request (triggers auto-search in M1+)" })
  approve(@Param("id") id: string, @Body(new ZodValidationPipe(statusSchema)) _: unknown) {
    return this.requests.setStatus(id, "approved");
  }

  @Post(":id/decline")
  @ApiOperation({ summary: "Declines a request" })
  decline(@Param("id") id: string, @Body(new ZodValidationPipe(statusSchema)) _: unknown) {
    return this.requests.setStatus(id, "declined");
  }
}
