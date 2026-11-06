// Helpers shared by the scrapers in this folder.
import { loadEnv } from "../../src/config.js";

export { root } from "../../src/config.js";
export { openDb } from "../../src/db.js";

/** DATASOURCE_BASEURL with a trailing slash, so `new URL("path", base)` keeps any base path. */
export function getBaseUrl() {
  loadEnv();
  const base = process.env.DATASOURCE_BASEURL;
  if (!base) throw new Error("DATASOURCE_BASEURL is not set (add it to .env)");
  return base.endsWith("/") ? base : `${base}/`;
}

export async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; Udara-Jakarta/1.0)",
      accept: "text/html",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.text();
}
