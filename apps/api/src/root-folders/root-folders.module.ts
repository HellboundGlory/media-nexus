// SPDX-License-Identifier: MIT
import { Global, Module } from "@nestjs/common";
import { RootFoldersService } from "./root-folders.service";
import { RootFoldersController } from "./root-folders.controller";

// Global: consumed by AcquisitionService and DecisionService for the "no root folder
// set on this title" fallback — same pattern as MediaModule/BlocklistModule/DecisionModule.
@Global()
@Module({
  providers: [RootFoldersService],
  controllers: [RootFoldersController],
  exports: [RootFoldersService],
})
export class RootFoldersModule {}
