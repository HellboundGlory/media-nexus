// SPDX-License-Identifier: MIT
import { Global, Module } from "@nestjs/common";
import { RemotePathMappingsService } from "./remote-path-mappings.service";
import { RemotePathMappingsController } from "./remote-path-mappings.controller";

// Global: consumed by AcquisitionService.resolveContent() — same pattern as RootFoldersModule.
@Global()
@Module({
  providers: [RemotePathMappingsService],
  controllers: [RemotePathMappingsController],
  exports: [RemotePathMappingsService],
})
export class RemotePathMappingsModule {}
