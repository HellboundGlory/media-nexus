// SPDX-License-Identifier: MIT
import { Controller, Get, Header } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../common/public.decorator";
import { MetricsService } from "./metrics.service";

@ApiTags("observability")
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Public()
  @Header("content-type", "text/plain; version=0.0.4; charset=utf-8")
  @ApiOperation({ summary: "Prometheus metrics (public)" })
  render(): string {
    return this.metrics.render();
  }
}
