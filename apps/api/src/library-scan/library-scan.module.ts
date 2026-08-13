// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { LibraryScanService } from "./library-scan.service";
import { LibraryScanController } from "./library-scan.controller";

@Module({
  providers: [LibraryScanService],
  controllers: [LibraryScanController],
  exports: [LibraryScanService],
})
export class LibraryScanModule {}
