import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { SCHEMA_DDL } from "./ddl.js";
import * as schema from "./schema.js";

export type DB = LibSQLDatabase<typeof schema>;

let dbPromise: Promise<DB> | undefined;

/**
 * Resolve the default local DB file to <repo-root>/linkchecker.db so the
 * crawler and the dashboard (which run from different working directories)
 * always hit the same file without any configuration.
 */
function defaultLocalUrl(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // packages/db/src
  const root = path.resolve(here, "../../..");
  return `file:${path.join(root, "linkchecker.db")}`;
}

/**
 * Lazily create the Drizzle client and ensure the schema exists.
 *
 * - Local: no env needed — uses a SQLite file at the repo root.
 * - Production (Turso): set DATABASE_URL=libsql://<db>.turso.io and
 *   DATABASE_AUTH_TOKEN=<token>. Same code, same queries.
 */
export function getDb(): Promise<DB> {
  if (!dbPromise) dbPromise = init();
  return dbPromise;
}

async function init(): Promise<DB> {
  const url = process.env.DATABASE_URL ?? defaultLocalUrl();
  const authToken = process.env.DATABASE_AUTH_TOKEN;
  const client = createClient({ url, authToken });
  await client.executeMultiple(SCHEMA_DDL);
  return drizzle(client, { schema });
}
