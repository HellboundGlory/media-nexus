// SPDX-License-Identifier: MIT
import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { X_REQUEST_ID, newRequestId, runWithCorrelation } from "@medianexus/shared";

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const given = req.headers[X_REQUEST_ID];
    const requestId = typeof given === "string" && given.length > 0 ? given : newRequestId();
    req.correlationId = requestId;
    res.setHeader(X_REQUEST_ID, requestId);
    runWithCorrelation({ requestId }, () => next());
  }
}
