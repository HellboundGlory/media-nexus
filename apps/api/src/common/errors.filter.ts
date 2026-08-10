// SPDX-License-Identifier: MIT
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiError, getCorrelationId } from "@medianexus/shared";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = getCorrelationId() ?? (req.headers["x-request-id"] as string | undefined);

    let status: number;
    let code: string;
    let message: string;
    let details: unknown;

    if (exception instanceof ApiError) {
      status = exception.statusCode; code = exception.code; message = exception.message; details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      code = HttpStatus[status] ?? "HTTP_ERROR";
      message = typeof body === "string" ? body : String((body as any)?.message ?? body);
      details = typeof body === "object" && body !== null ? (body as { message?: unknown }).message : undefined;
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = "INTERNAL";
      message = "Internal server error";
      details = exception.message;
      this.logger.error(exception.message, exception.stack);
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = "INTERNAL";
      message = "Internal server error";
    }

    res.status(status).json({ error: { code, message, details }, requestId });
  }
}
