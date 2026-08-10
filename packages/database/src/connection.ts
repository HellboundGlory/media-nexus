// SPDX-License-Identifier: MIT
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { schema, type Schema } from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;
export type { Schema };

export interface DbHandle {
  db: Db;
  close: () => void;
  runMigrations: () => void;
}

export const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

/**
 * Open a database connection from a Drizzle connection string.
 * Supported now: SQLite (`file:./x.db` or a bare path; `:memory:` for tests).
 * PostgreSQL is a targeted follow-up (pg-core port of the same schema).
 */
export function createDb(url: string): DbHandle {
  if (/^postg(?:re)?s(ql)?:\/\//.test(url)) {
    throw new Error(
      "PostgreSQL support is planned but not yet wired in this build. " +
        "Use SQLite (default) — see docs/deployment/configuration.md. URL was: " +
        url.replace(/\/\/\/[^@]*@/, "//***@"),
    );
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

  const db = drizzle(sqlite, { schema });
  return {
    db,
    close: () => sqlite.close(),
    runMigrations: () => migrate(db, { migrationsFolder: MIGRATIONS_DIR }),
  };
}

export type { BetterSQLite3Database };
