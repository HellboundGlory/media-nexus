// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { IndexersService } from "./indexers.service";
import { CardigannSyncService } from "./cardigann-sync.service";
import { IndexersController } from "./indexers.controller";

@Module({ providers: [IndexersService, CardigannSyncService], controllers: [IndexersController], exports: [IndexersService, CardigannSyncService] })
export class IndexersModule {}
