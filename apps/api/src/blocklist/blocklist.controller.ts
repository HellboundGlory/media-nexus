// SPDX-License-Identifier: MIT
import { Controller, Delete, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod.pipe";
import { BlocklistService } from "./blocklist.service";

const listQuery = z.object({
  mediaType: z.enum(["movie", "series"]).optional(),
  mediaId: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

@ApiTags("blocklist")
@Controller("api/v1/blocklist")
export class BlocklistController {
  constructor(private readonly blocklist: BlocklistService) {}

  @Get()
  @ApiOperation({ summary: "List blocklisted releases (paginated)" })
  list(@Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.blocklist.list(q);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a blocklist entry (un-blocklist a release)" })
  remove(@Param("id") id: string) {
    return this.blocklist.remove(id);
  }
}
