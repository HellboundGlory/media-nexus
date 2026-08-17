// SPDX-License-Identifier: MIT
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { APP_NAME, parseEnv } from "@medianexus/shared";
import { AppModule } from "./app.module";
import { configureApp } from "./configure";
import { WEB_DIR } from "./web-ui/web-ui.controller";
import { RingBufferLogger } from "./system/ring-buffer.logger";
import { logBuffer } from "./system/log-buffer";
import { logFileWriter } from "./system/log-file-writer";

async function bootstrap(): Promise<void> {
  const env = parseEnv(); // fail fast on invalid/missing config
  // App-level logger: console output exactly as Nest's default (docker logs unchanged) PLUS a
  // mirrored, redacted copy into the in-memory log ring buffer (see system/log-buffer.ts) and the
  // durable, rotating log file on disk (see system/log-file-writer.ts).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new RingBufferLogger(logBuffer, logFileWriter),
  });
  app.enableShutdownHooks();
  app.useStaticAssets(WEB_DIR, { index: false });
  configureApp(app);
  await app.listen(env.PORT);
  // eslint-disable-next-line no-console
  console.log(`MediaNexus API (${APP_NAME}) listening on http://localhost:${env.PORT} — docs at /api/docs`);
}

void bootstrap();
