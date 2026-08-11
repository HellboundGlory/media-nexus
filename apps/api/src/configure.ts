// SPDX-License-Identifier: MIT
import { INestApplication } from "@nestjs/common";
import express, { type Express } from "express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { GlobalExceptionFilter } from "./common/errors.filter";
import { CompatService } from "./compat/compat.service";
import { CompatSurface } from "@medianexus/compatibility";

/**
 * Shared application wiring used by both `main.ts` (production bootstrap) and e2e tests:
 * global error filter, OpenAPI docs, and the ecosystem-compatible surface mount. No CORS/
 * trust-proxy handling — the web UI is served same-origin and this app is never meant to
 * sit behind a public reverse proxy. Keeping it in one place guarantees tests exercise the
 * real bootstrap path.
 */
export function configureApp(app: INestApplication): void {
  app.useGlobalFilters(new GlobalExceptionFilter());

  const config = new DocumentBuilder()
    .setTitle("MediaNexus API")
    .setDescription("Unified media automation platform — native API (compat APIs are separate).")
    .setVersion("1.0.0")
    .addApiKey({ type: "apiKey", name: "x-api-key", in: "header" }, "X-Api-Key")
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document);

  const httpApp = app.getHttpAdapter().getInstance() as Express;

  // ensure JSON bodies are parsed for both native and compat routes
  httpApp.use(express.json());
  httpApp.use(express.urlencoded({ extended: true }));

  // compatibility surfaces are mounted via lazily-resolved service (available post-init)
  const compat = app.get(CompatService, { strict: false });
  for (const surface of compat.surfaces as CompatSurface[]) {
    const path = surface.basePath;
    httpApp.use(path, (req: unknown, res: unknown, next: unknown) =>
      compat.handleFor(surface)(req as never, res as never, next as never),
    );
  }
}
