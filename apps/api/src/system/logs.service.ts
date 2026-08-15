// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { LogBuffer, type LogEntry } from "./log-buffer";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** Read access to the in-memory log ring buffer for GET /api/v1/system/logs. */
@Injectable()
export class LogsService {
  constructor(@Inject(LogBuffer) private readonly buffer: LogBuffer) {}

  latest(limit?: number, level?: string, search?: string): LogEntry[] {
    const clamped = Math.max(1, Math.min(Number.isFinite(limit as number) ? (limit as number) : DEFAULT_LIMIT, MAX_LIMIT));
    return this.buffer.latest(clamped, level, search);
  }
}
