// SPDX-License-Identifier: MIT
import { INestApplication } from "@nestjs/common";
import express, { type Express } from "express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { parseEnv } from "@medianexus/shared";
import { GlobalExceptionFilter } from "./common/errors.filter";
import { CompatService } from "./compat/compat.service";
import { CompatSurface } from "@medianexus/compatibility";

/**
 * Shared application wiring used by both `main.ts` (production bootstrap) and e2e tests:
 * global error filter, CORS/trust-proxy, OpenAPI docs, and the ecosystem-compatible
 * surface mount. Keeping it in one place guarantees tests exercise the real bootstrap path.
 */
export function configureApp(app: INestApplication): void {
  const env = parseEnv();
  app.useGlobalFilters(new GlobalExceptionFilter());

  if (env.CORS_ORIGINS) {
    app.enableCors({ origin: env.CORS_ORIGINS.split(",").map((s) => s.trim()) });
  }

  const config = new DocumentBuilder()
    .setTitle("MediaNexus API")
    .setDescription("Unified media automation platform — native API (compat APIs are separate).")
    .setVersion("0.1.0")
    .addApiKey({ type: "apiKey", name: "x-api-key", in: "header" }, "X-Api-Key")
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document);

  const httpApp = app.getHttpAdapter().getInstance() as Express & { set?: (k: string, v: unknown) => void };
  if (env.TRUST_PROXY > 0) httpApp.set?.("trust proxy", env.TRUST_PROXY);

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
