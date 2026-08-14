// SPDX-License-Identifier: MIT
import { Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiError } from "@medianexus/shared";
import { JobsService } from "./jobs.service";

@ApiTags("system")
@Controller("api/v1/system")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get("jobs")
  @ApiOperation({ summary: "List job definitions" })
  listJobs() {
    return this.jobs.definitions();
  }

  @Get("jobs/runs")
  @ApiOperation({ summary: "Recent job runs (history)" })
  recentRuns() {
    return this.jobs.recentRuns(50);
  }

  @Post("commands/:jobKey")
  @ApiOperation({ summary: "Manually trigger a job (arr-style command surface)" })
  async trigger(@Param("jobKey") jobKey: string) {
    if (!this.jobs.hasHandler(jobKey)) {
      throw new ApiError({ code: "NOT_FOUND", message: `No job handler for "${jobKey}"` });
    }
    return this.jobs.dispatch({ jobKey, trigger: "manual" });
  }

  @Get("commands/:id")
  @ApiOperation({ summary: "Poll a single command (job run) by id" })
  async getRun(@Param("id") id: string) {
    const run = await this.jobs.findRun(id);
    if (!run) throw new ApiError({ code: "NOT_FOUND", message: `No job run "${id}"` });
    return run;
  }

  @Delete("commands/:id")
  @ApiOperation({ summary: "Cancel a queued or in-flight command" })
  async cancelRun(@Param("id") id: string) {
    const run = await this.jobs.findRun(id);
    if (!run) throw new ApiError({ code: "NOT_FOUND", message: `No job run "${id}"` });
    return this.jobs.cancel(id);
  }
}
