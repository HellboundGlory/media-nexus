// SPDX-License-Identifier: MIT
import { Controller, Get, Param, Post } from "@nestjs/common";
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
}
