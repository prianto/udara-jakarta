import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Load .env from the project root. A missing file is fine; real environment variables win. */
export function loadEnv() {
  try {
    process.loadEnvFile(resolve(root, ".env"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
