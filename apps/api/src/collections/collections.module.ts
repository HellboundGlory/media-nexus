// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { CollectionsController } from "./collections.controller";
import { CollectionsService } from "./collections.service";
import { MetadataModule } from "../metadata/metadata.module";
import { MoviesModule } from "../movies/movies.module";

@Module({
  imports: [MetadataModule, MoviesModule],
  controllers: [CollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
