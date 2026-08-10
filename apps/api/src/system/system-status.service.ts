// SPDX-License-Identifier: MIT
import { Injectable } from "@nestjs/common";
import { APP_NAME, parseEnv } from "@medianexus/shared";

@Injectable()
export class SystemStatusService {
  readonly startedAt: Date;
  readonly appName = APP_NAME;
  readonly version = "0.1.0";

  constructor() {
    this.startedAt = new Date();
  }

  status() {
    const env = parseEnv();
    const dbUrl = env.DATABASE_URL;
    const vendor = /^postgres?:\/\//.test(dbUrl) ? "postgresql" : dbUrl.startsWith("file") || dbUrl.includes(".db") ? "sqlite" : "sqlite";
    return {
      appName: this.appName,
      version: this.version,
      started: this.startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      database: { vendor },
      node: process.version,
    };
  }
}
