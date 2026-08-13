// SPDX-License-Identifier: MIT
import { Controller, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { LibraryScanService } from "./library-scan.service";

const mediaTypeSchema = z.enum(["movie", "series"]);

@ApiTags("library-scan")
@Controller("api/v1/library-scan")
export class LibraryScanController {
  constructor(private readonly scan: LibraryScanService) {}

  @Post(":mediaType/:mediaId")
  @ApiOperation({ summary: "Rescan one title's root folder for files not yet tracked, and reconcile ones that vanished" })
  scanOne(@Param("mediaType", new ZodValidationPipe(mediaTypeSchema)) mediaType: z.infer<typeof mediaTypeSchema>, @Param("mediaId") mediaId: string) {
    return this.scan.scanMedia(mediaType, mediaId);
  }
}
