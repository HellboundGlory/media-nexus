// SPDX-License-Identifier: MIT
import { Global, Injectable, Module, OnModuleDestroy } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { createDb, type Db, type DbHandle } from "@medianexus/database";
import { seedStatic } from "@medianexus/database";
import { parseEnv } from "@medianexus/shared";
import { runSecretBackfill } from "../secrets/secret-backfill";
import { runSettingsBlobBackfill } from "../notifications/settings-blob-backfill";
import { runEpisodeMediaFileBackfill } from "../media/media-file-backfill";

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
          await runSecretBackfill(handle.db, env.MEDIA_NEXUS_SECRET);
        }
        // Roadmap P2 (gap J4/D7): promote legacy settings-blob notification/media-server
        // configs into real rows. Sentinel-gated; runs once after migrations. Does not
        // need the secret (secret fields are carried through unchanged). Must run after
        // runMigrations so the `notification`/`media_server` tables exist.
        if (env.AUTO_MIGRATE) {
          await runSettingsBlobBackfill(handle.db);
        }
        // Roadmap P3 (gap J3): populate episode.media_file_id from pre-existing media_file.episode_ids
        // so the indexed FK inverse is in sync with the JSON array for rows written before the FK
        // existed. Idempotent (isNull-guarded) + non-destructive; runs after migrations. Does not
        // need the secret. (Reads episode_ids directly.)
        if (env.AUTO_MIGRATE) {
          await runEpisodeMediaFileBackfill(handle.db);
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

