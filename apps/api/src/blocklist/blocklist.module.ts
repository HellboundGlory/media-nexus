// SPDX-License-Identifier: MIT
import { Global, Module } from "@nestjs/common";
import { BlocklistService } from "./blocklist.service";
import { BlocklistController } from "./blocklist.controller";

// Global: consulted by IndexersService.grab() and RssSyncService (acquisition module),
// which have no other dependency relationship — same pattern as MediaModule/EventsModule.
@Global()
@Module({
  providers: [BlocklistService],
  controllers: [BlocklistController],
  exports: [BlocklistService],
})
export class BlocklistModule {}
