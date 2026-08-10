// SPDX-License-Identifier: MIT
import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { sharedMetrics } from "./metrics.service";

/** Counts/measures every handled request; used instead of a Nest interceptor
 *  (interceptors can interfere with Observable/SSE handlers). */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (req.path === "/metrics") return next(); // don't count our own scrape
    const start = Date.now();
    res.on("finish", () => {
      const route = (req.route?.path ?? req.baseUrl + req.path) || req.path;
      sharedMetrics.recordRequest(route, req.method, res.statusCode, Date.now() - start);
    });
    next();
  }
}
