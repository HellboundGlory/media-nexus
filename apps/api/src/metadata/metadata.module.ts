// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { MetadataService } from "./metadata.service";
import { MetadataController } from "./metadata.controller";
import { AdminGuard } from "../requests/admin.guard";

@Module({ providers: [MetadataService, AdminGuard], controllers: [MetadataController], exports: [MetadataService] })
export class MetadataModule {}
