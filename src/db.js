import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./config.js";

export const dbPath = resolve(root, "db/data.sqlite");

/** Open db/data.sqlite with foreign keys on; waits up to 5 s if the scraper is writing. */
export function openDb() {
  if (!existsSync(dbPath))
    throw new Error(`${dbPath} not found, run "pnpm db:init" first`);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
