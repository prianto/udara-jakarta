// Create a SQLite database from db/schema.sql.
// Usage: node scripts/init-db.js [target]   (default: db/data.sqlite)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, process.argv[2] ?? "db/data.sqlite");
const schema = readFileSync(resolve(root, "db/schema.sql"), "utf8");

if (existsSync(target)) {
  console.log(
    `${target} already exists, applying schema (IF NOT EXISTS only).`,
  );
}
mkdirSync(dirname(target), { recursive: true });

const db = new DatabaseSync(target);
db.exec(schema);
db.close();

console.log(`Database ready: ${target}`);
