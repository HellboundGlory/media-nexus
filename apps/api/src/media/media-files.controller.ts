// SPDX-License-Identifier: MIT
import { Body, Controller, Delete, Param, Put } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { MediaFilesService, type UpdateMediaFileBody } from "./media-files.service";

@ApiTags("media-files")
@Controller("api/v1/media-files")
export class MediaFilesController {
  constructor(private readonly mediaFiles: MediaFilesService) {}

  @Delete(":id")
  @ApiOperation({ summary: "Delete a media file: dispose the physical file (recycle bin) and remove the row" })
  remove(@Param("id") id: string) {
    return this.mediaFiles.remove(id);
  }

  @Put(":id")
  @ApiOperation({ summary: "Edit a media file's metadata (partial; no filesystem operation)" })
  update(@Param("id") id: string, @Body(new ZodValidationPipe(
    z.object({
      quality: z.object({ source: z.string(), resolution: z.string(), edition: z.string() }).optional(),
      languages: z.array(z.string()).optional(),
      releaseGroup: z.string().nullable().optional(),
    }),
  )) body: UpdateMediaFileBody) {
    return this.mediaFiles.update(id, body);
  }
}
