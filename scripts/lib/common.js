// Helpers shared by the scrapers in this folder.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Load .env from the project root. A missing file is fine; real environment variables win. */
export function loadEnv() {
  try {
    process.loadEnvFile(resolve(root, ".env"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

/** DATASOURCE_BASEURL with a trailing slash, so `new URL("path", base)` keeps any base path. */
export function getBaseUrl() {
  loadEnv();
  const base = process.env.DATASOURCE_BASEURL;
  if (!base) throw new Error("DATASOURCE_BASEURL is not set (add it to .env)");
  return base.endsWith("/") ? base : `${base}/`;
}

export async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "udara-scraper/1.0", accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.text();
}

/** Open db/data.sqlite with foreign keys enabled. */
export function openDb() {
  const dbPath = resolve(root, "db/data.sqlite");
  if (!existsSync(dbPath))
    throw new Error(`${dbPath} not found, run "pnpm db:init" first`);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
