// SPDX-License-Identifier: MIT
import { Injectable } from "@nestjs/common";
import { APP_NAME, parseEnv } from "@medianexus/shared";
// Single source of truth for the app version is the root package.json "version" field
// (see AGENTS.md "Versioning and Release Process"); everything derives from it at runtime
// rather than a hand-kept literal. `../../../../` resolves to the repo root from both
// src/system/ (dev) and the built dist/system/ (and the Docker runtime copies root
// package.json to /app/package.json, same relative depth).
import pkg from "../../../../package.json";

@Injectable()
export class SystemStatusService {
  readonly startedAt: Date;
  readonly appName = APP_NAME;
  readonly version = pkg.version;

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
