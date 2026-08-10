// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { DownloadClientsService } from "./download-clients.service";
import { DownloadClientsController } from "./download-clients.controller";

@Module({ providers: [DownloadClientsService], controllers: [DownloadClientsController], exports: [DownloadClientsService] })
export class DownloadClientsModule {}
