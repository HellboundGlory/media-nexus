// SPDX-License-Identifier: MIT
import { Global, Module } from "@nestjs/common";
import { MediaRepository } from "./media.repository";
import { RecycleBinService } from "./recycle-bin.service";

/**
 * Global because the media abstraction is a leaf dependency of nearly every other
 * module (acquisition, decisions, import, metadata) and carries no state of its own.
 */
@Global()
@Module({
  providers: [MediaRepository, RecycleBinService],
  exports: [MediaRepository, RecycleBinService],
})
export class MediaModule {}
