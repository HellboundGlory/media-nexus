// SPDX-License-Identifier: MIT
import { Global, Injectable, Module, OnModuleDestroy } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { createDb, type Db, type DbHandle } from "@medianexus/database";
import { seedStatic } from "@medianexus/database";
import { parseEnv } from "@medianexus/shared";
import { runSecretBackfill } from "../secrets/secret-backfill";
import { runSettingsBlobBackfill } from "../notifications/settings-blob-backfill";

export const DB_TOKEN = Symbol("DATABASE");
export const DB_HANDLE_TOKEN = Symbol("DATABASE_HANDLE");

/**
 * Owns the Drizzle connection + migration + static seed lifecycle.
 * Reads `DATABASE_URL` (+ `AUTO_MIGRATE`) from the environment at factory time so
 * tests can inject a temp SQLite database before building the app.
 */
/** Closes the connection on app shutdown (graceful drain). */
@Injectable()
export class DatabaseLifecycle implements OnModuleDestroy {
  constructor(@Inject(DB_HANDLE_TOKEN) private readonly handle: DbHandle) {}
  onModuleDestroy() {
    this.handle.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE_TOKEN,
      useFactory: async (): Promise<DbHandle> => {
        const env = parseEnv();
        const handle = createDb(env.DATABASE_URL);
        if (env.AUTO_MIGRATE) await handle.runMigrations();
        await seedStatic(handle.db);
        // Gap report J9 — encrypt pre-existing plaintext provider credentials in place.
        // Idempotent + non-destructive: re-runs every boot and no-ops once everything is
        // already encrypted. Must run after migrations (so the tables exist) and needs the
        // secret from the environment (like auth.service.ts).
        if (env.AUTO_MIGRATE && env.MEDIA_NEXUS_SECRET) {
          runSecretBackfill(handle.db, env.MEDIA_NEXUS_SECRET);
        }
        // Roadmap P2 (gap J4/D7): promote legacy settings-blob notification/media-server
        // configs into real rows. Sentinel-gated; runs once after migrations. Does not
        // need the secret (secret fields are carried through unchanged). Must run after
        // runMigrations so the `notification`/`media_server` tables exist.
        if (env.AUTO_MIGRATE) {
          runSettingsBlobBackfill(handle.db);
        }
        return handle;
      },
    },
    {
      provide: DB_TOKEN,
      useFactory: (handle: DbHandle): Db => handle.db,
      inject: [DB_HANDLE_TOKEN],
    },
    DatabaseLifecycle,
  ],
  exports: [DB_TOKEN, DB_HANDLE_TOKEN],
})
export class DatabaseModule {}

