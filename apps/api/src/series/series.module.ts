// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { SeriesService } from "./series.service";
import { SeriesController } from "./series.controller";

@Module({ providers: [SeriesService], controllers: [SeriesController], exports: [SeriesService] })
export class SeriesModule {}
