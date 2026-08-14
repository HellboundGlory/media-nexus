// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { ImportListsController } from "./import-lists.controller";
import { ImportListsService } from "./import-lists.service";
import { MetadataModule } from "../metadata/metadata.module";

@Module({ controllers: [ImportListsController], providers: [ImportListsService], imports: [MetadataModule], exports: [ImportListsService] })
export class ImportListsModule {}
