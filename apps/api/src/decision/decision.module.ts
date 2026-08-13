// SPDX-License-Identifier: MIT
import { Global, Module } from "@nestjs/common";
import { DecisionService } from "./decision.service";

// Global: consumed by IndexersService and RssSyncService (acquisition module), which
// have no other dependency relationship — same pattern as MediaModule/BlocklistModule.
@Global()
@Module({
  providers: [DecisionService],
  exports: [DecisionService],
})
export class DecisionModule {}
