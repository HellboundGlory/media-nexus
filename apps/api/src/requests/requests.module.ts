// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { RequestsService } from "./requests.service";
import { RequestsController } from "./requests.controller";

@Module({ providers: [RequestsService], controllers: [RequestsController], exports: [RequestsService] })
export class RequestsModule {}
