// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { IndexersService } from "./indexers.service";
import { IndexersController } from "./indexers.controller";

@Module({ providers: [IndexersService], controllers: [IndexersController], exports: [IndexersService] })
export class IndexersModule {}
