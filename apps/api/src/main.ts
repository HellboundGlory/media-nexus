// SPDX-License-Identifier: MIT
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { APP_NAME, parseEnv } from "@medianexus/shared";
import { AppModule } from "./app.module";
import { configureApp } from "./configure";

async function bootstrap(): Promise<void> {
  const env = parseEnv(); // fail fast on invalid/missing config
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  configureApp(app);
  await app.listen(env.PORT);
  // eslint-disable-next-line no-console
  console.log(`MediaNexus API (${APP_NAME}) listening on http://localhost:${env.PORT} — docs at /api/docs`);
}

void bootstrap();
