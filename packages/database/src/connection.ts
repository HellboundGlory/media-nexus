// SPDX-License-Identifier: MIT
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { drizzle as sqliteDrizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate as sqliteMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as pgDrizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as pgMigrate } from "drizzle-orm/node-postgres/migrator";
import { schema, type Schema } from "./schema";
import { schema as pgSchema } from "./schema.pg";

/** The app-facing database type — SQLite dialect. apps/api is typed against this.
 *  See the boundary-cast note in `createDb` for how the Postgres path satisfies it. */
export type Db = BetterSQLite3Database<typeof schema>;
export type { Schema };

export interface DbHandle {
  db: Db;
  close: () => void;
  /** Apply pending migrations. Awaited by the bootstrap factory — Postgres's migrator is
   *  async (SQLite's runs synchronously, but returning a resolved promise is harmless). */
  runMigrations: () => Promise<void>;
  /** Online backup to `destPath` via SQLite's native backup API (roadmap P1, gap report
   *  B9). Postgres has no equivalent single-file online-backup API — on a Postgres-backed
   *  handle this rejects with "use pg_dump"; see `createDb`. */
  backup: (destPath: string) => Promise<void>;
}

export const MIGRATIONS_DIR = resolve(__dirname, "../migrations");
export const PG_MIGRATIONS_DIR = resolve(__dirname, "../migrations-pg");

/**
 * Detect whether a DATABASE_URL points at Postgres (reused the existing regex from the
 * pre-Stage-1 rejection stub — the one piece of dialect detection that already existed).
 */
function isPostgresUrl(url: string): boolean {
  return /^postg(?:re)?s(ql)?:\/\//.test(url);
}

/**
 * Open a database connection from a Drizzle connection string, choosing the dialect from
 * the URL scheme at boot (roadmap P2 item 12 / M1.1).
 *
 *  - SQLite: `file:./x.db`, a bare path, or `:memory:` (tests). Unchanged behavior.
 *  - Postgres: `postgres://...` / `postgresql://...` -> a real `NodePgDatabase` built on
 *    a `pg` Pool, with migrations applied from the pg migration folder.
 *
 * BOUNDARY CAST (approved Option 1): the returned `Db` is typed as the SQLite
 * `BetterSQLite3Database` because that is what all ~49 apps/api service files are written
 * against. For a Postgres URL the pg database is genuinely a different class
 * (`NodePgDatabase`, async driver, `PgTable`-typed schema), so it cannot be assigned
 * without a cast. The cast is confined to THIS one factory boundary — no `as any` at any
 * apps/api call site. The type-level sync/async and table-type mismatch (SQLite vs PG) is
 * acknowledged and the real fix (converting the SQLite-specific call sites — sync
 * `.all()/.run()/.get()`, sync `db.transaction`, raw `json_extract`) is Stage 2 of this
 * item; see also the Stage 1 plan and ADR-004.
 */
export function createDb(url: string): DbHandle {
  if (isPostgresUrl(url)) {
    const pool = new Pool({ connectionString: url });
    const pgDb: NodePgDatabase<typeof pgSchema> = pgDrizzle(pool, { schema: pgSchema });
    return {
      db: pgDb as unknown as Db, // single boundary cast (see doc comment above)
      close: () => pool.end(),
      runMigrations: () => pgMigrate(pgDb, { migrationsFolder: PG_MIGRATIONS_DIR }),
      backup: async () => {
        throw new Error(
          "Online backup is not supported on a Postgres database — use pg_dump instead.",
        );
      },
    };
  }

  let filePath = url;
  if (filePath.startsWith("file:")) filePath = filePath.slice("file:".length);
  if (filePath.startsWith("sqlite:")) filePath = filePath.slice("sqlite:".length);
  if (filePath === ":memory:") {
    filePath = ":memory:";
  } else if (filePath.startsWith("./") || filePath.startsWith("../")) {
    // resolve relative to the process CWD
    filePath = resolve(process.cwd(), filePath);
  }

  if (filePath !== ":memory:") {
    mkdirSync(dirname(resolve(filePath)), { recursive: true });
  }
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db: Db = sqliteDrizzle(sqlite, { schema });
  return {
    db,
    close: () => sqlite.close(),
    runMigrations: async () => {
      sqliteMigrate(db, { migrationsFolder: MIGRATIONS_DIR });
    },
    backup: async (destPath: string) => {
      if (filePath === ":memory:") throw new Error("cannot back up an in-memory database");
      mkdirSync(dirname(resolve(destPath)), { recursive: true });
      await sqlite.backup(destPath);
    },
  };
}

export type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
