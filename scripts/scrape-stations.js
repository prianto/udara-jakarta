// Scrape the station list from <DATASOURCE_BASEURL>/lokasi-spku into the `stations` table.
// Usage: pnpm scrape:stations        (needs DATASOURCE_BASEURL in .env or the environment)
//
// Stations are matched by `uuid` (taken from the row's data-redirect="/spku/<uuid>"),
// so running the script again updates existing rows instead of duplicating them.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { fetchHtml, getBaseUrl, openDb } from "./lib/common.js";

const UUID_RE =
  /\/spku\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const clean = (text) => text.replace(/\s+/g, " ").trim();
const orNull = (text) => (text === "" ? null : text);

/**
 * Parse the HTML of the /lokasi-spku page.
 * @returns {{ stations: object[], skipped: number }}
 */
export function parseStations(html) {
  const $ = cheerio.load(html);
  const stations = [];
  let skipped = 0;

  $("table tbody tr[data-redirect]").each((_, el) => {
    const $tr = $(el);
    const uuid = $tr.attr("data-redirect")?.match(UUID_RE)?.[1]?.toLowerCase();
    if (!uuid) {
      skipped++;
      return;
    }

    const cells = $tr.children("td");

    // 2nd cell: station name as direct text, address inside a <div> (no column for it yet)
    const spku = clean(cells.eq(1).clone().children().remove().end().text());

    // 3rd cell: one <span> per parameter -> "PM25,AIR_HUMID,DD,..."
    const parameter = cells
      .eq(2)
      .find("span")
      .map((__, span) => clean($(span).text()))
      .get()
      .filter(Boolean)
      .join(",");

    stations.push({
      uuid,
      spku: orNull(spku),
      parameter: orNull(parameter),
      kecamatan: orNull(clean(cells.eq(3).text())),
      kota: orNull(clean(cells.eq(4).text())),
    });
  });

  return { stations, skipped };
}

/**
 * Insert new stations and update changed ones. Rows whose scraped values did not
 * change are left untouched, so `updated_at` only moves when something really changed.
 */
export function saveStations(db, stations) {
  const known = new Set(
    db
      .prepare("SELECT uuid FROM stations")
      .all()
      .map((r) => r.uuid),
  );

  const upsert = db.prepare(`
    INSERT INTO stations (uuid, spku, parameter, kecamatan, kota)
    VALUES (:uuid, :spku, :parameter, :kecamatan, :kota)
    ON CONFLICT (uuid) DO UPDATE SET
      spku      = excluded.spku,
      parameter = excluded.parameter,
      kecamatan = excluded.kecamatan,
      kota      = excluded.kota
    WHERE spku      IS NOT excluded.spku
       OR parameter IS NOT excluded.parameter
       OR kecamatan IS NOT excluded.kecamatan
       OR kota      IS NOT excluded.kota
  `);

  const result = { inserted: 0, updated: 0, unchanged: 0 };

  db.exec("BEGIN");
  try {
    for (const station of stations) {
      const { changes } = upsert.run(station);
      if (!known.has(station.uuid)) result.inserted++;
      else if (changes > 0) result.updated++;
      else result.unchanged++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return result;
}

async function main() {
  const url = new URL("lokasi-spku", getBaseUrl());
  console.log(`Fetching ${url} ...`);
  const { stations, skipped } = parseStations(await fetchHtml(url));

  if (stations.length === 0) {
    throw new Error(
      "No station rows found; the page layout may have changed. Nothing was saved.",
    );
  }
  if (skipped > 0)
    console.warn(
      `Skipped ${skipped} row(s) without a valid /spku/<uuid> link.`,
    );

  const db = openDb();
  try {
    const { inserted, updated, unchanged } = saveStations(db, stations);
    console.log(
      `Parsed ${stations.length} stations: ${inserted} new, ${updated} updated, ${unchanged} unchanged.`,
    );
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  });
}
