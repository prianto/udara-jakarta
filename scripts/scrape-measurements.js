// Scrape the latest reading of every station into the `measurements` table.
// Usage: pnpm scrape:measurements     (needs DATASOURCE_BASEURL in .env or the environment)
//
// For each station it reads <DATASOURCE_BASEURL>/spku/<uuid> and:
//   - inserts one row into `measurements` (skipped when that station already has a row
//     with the same "Update Terakhir" time),
//   - fills in the station's operator, type, procurement year, last maintenance and
//     coordinates (a "-" on the page never overwrites a value already stored),
//   - sets stations.is_active = 0 when "Update Terakhir" is more than 24 hours ago,
//     and back to 1 as soon as the station reports fresh data again.
//
// The source always shows WIB, and so does the database: `measured_at` is saved exactly as
// displayed ("13.00 WIB" -> "2026-11-06 13:00:00"), like created_at/updated_at.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { fetchHtml, getBaseUrl, openDb } from "./lib/common.js";
import { wibNow, wibToMs } from "../src/time.js";

const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 300);
const STALE_AFTER_MS = 24 * 3_600_000;

// "name" in the JSON-LD variableMeasured list -> measurements column
const INDEX_COLUMNS = {
  CO: "co_index",
  NO2: "no2_index",
  SO2: "so2_index",
  "PM2.5": "pm25_index",
  PM25: "pm25_index",
  O3: "o3_index",
  PM10: "pm10_index",
  ISPU: "ispu_index",
};

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  mei: 5,
  may: 5,
  jun: 6,
  jul: 7,
  agu: 8,
  ags: 8,
  aug: 8,
  sep: 9,
  okt: 10,
  oct: 10,
  nov: 11,
  des: 12,
  dec: 12,
};

const clean = (text) => text.replace(/\s+/g, " ").trim();
const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** "-" or empty on the page means "no value". */
const valueOrNull = (text) =>
  text === "" || /^[-–—]$/.test(text) ? null : text;

/** First number in a text such as "0.5 km/h", "83%" or "30°". */
function firstNumber(text) {
  const match = text.match(/-?\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(",", ".")) : null;
}

function toInteger(value) {
  if (value === null || value === undefined) return null;
  const n =
    typeof value === "number"
      ? value
      : parseFloat(String(value).replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Find a date in ISO ("2026-11-06"), numeric ("06/11/2026") or Indonesian
 * ("Jumat, 6 November 2026") form. Returns the parts plus the text left over.
 */
function findDate(text) {
  let m;
  let y, mo, d;
  if ((m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/))) {
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = text.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/))) {
    [d, mo, y] = [
      Number(m[1]),
      MONTHS[m[2].slice(0, 3).toLowerCase()],
      Number(m[3]),
    ];
  } else {
    return null;
  }
  if (!mo || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d, rest: text.replace(m[0], " ") };
}

/** "2024-05-12", "12 Mei 2025" ... -> "2024-05-12"; anything else -> null. */
export function parseDate(text) {
  const found = text ? findDate(text) : null;
  return found ? `${found.y}-${pad(found.mo)}-${pad(found.d)}` : null;
}

/**
 * "Jumat, 6 November 2026 13.00 WIB" -> "2026-11-06 13:00:00".
 * The source always shows WIB, so the time is kept exactly as displayed (the zone
 * text is ignored). A date without a time is unusable and gives null.
 */
export function parseMeasuredAt(text) {
  const found = text ? findDate(text) : null;
  if (!found) return null;
  const time = found.rest.match(/(\d{1,2})[.:](\d{2})/);
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) return null;
  return `${found.y}-${pad(found.mo)}-${pad(found.d)} ${pad(time[1])}:${time[2]}:00`;
}

/** Pull the ISPU indexes out of the application/ld+json Dataset block. */
function readIndexes($) {
  const indexes = Object.fromEntries(
    Object.values(INDEX_COLUMNS).map((col) => [col, null]),
  );

  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).text());
    } catch (err) {
      throw new Error(`invalid JSON-LD on the page: ${err.message}`);
    }
    for (const node of Array.isArray(data) ? data : [data]) {
      if (node?.["@type"] !== "Dataset") continue;
      for (const variable of node.variableMeasured ?? []) {
        const column =
          INDEX_COLUMNS[
            String(variable?.name ?? "")
              .trim()
              .toUpperCase()
          ];
        if (column) indexes[column] = toInteger(variable.value);
      }
    }
  });

  return indexes;
}

/**
 * Parse one /spku/<uuid> page.
 * @returns {{ station: object, measurement: object }}
 */
export function parseStationPage(html) {
  const $ = cheerio.load(html);

  // <p>Label</p><p>Value</p>
  const detail = (label) => {
    const labelEl = $("p")
      .filter((_, el) => clean($(el).text()) === label)
      .first();
    return valueOrNull(clean(labelEl.next("p").text()));
  };

  // <div><i data-lucide="wind"></i></div><p>0.5 km/h</p>
  const weather = (icon) => {
    const text = clean(
      $(`i[data-lucide="${icon}"]`).first().closest("div").next("p").text(),
    );
    return firstNumber(text);
  };

  // coordinates: "-6.2445, 106.7906", fall back to the Google Maps link ".../@lat,lng,15z"
  let lat = null;
  let long = null;
  const coordText =
    detail("Titik Koordinat") ??
    $('a[href*="google.com/maps/@"]').attr("href") ??
    "";
  const coords = coordText.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (coords) {
    const [a, b] = [Number(coords[1]), Number(coords[2])];
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) [lat, long] = [a, b];
  }

  const year = detail("Tahun Pengadaan")?.match(/\b(?:19|20)\d{2}\b/)?.[0];

  // <p>Update Terakhir: <span title="Jumat, 6 November 2026 13.00 WIB">...</span></p>
  const updateP = $("p")
    .filter((_, el) => clean($(el).text()).startsWith("Update Terakhir"))
    .first();
  const updateSpan = updateP.find("span").first();
  const updateText =
    clean(updateSpan.attr("title") ?? "") ||
    clean(updateSpan.text()) ||
    clean(updateP.text()).replace(/^Update Terakhir:?/, "");

  // <p>Parameter : <span id="ispu-parameter">PM<sub>2.5</sub></span></p>  -> "pm25"
  // <p>Konsentrasi : <span id="ispu-concentration">9.81 µg/m³</span></p>   -> 9.81
  const ispuSource =
    clean($("#ispu-parameter").first().text())
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || null;
  const ispuConcentration = firstNumber(
    clean($("#ispu-concentration").first().text()),
  );

  return {
    station: {
      operator: detail("Dioperasikan Oleh"),
      sumber_data: detail("Tipe"),
      tahun_pengadaan: year ? Number(year) : null,
      perawatan_terakhir: parseDate(detail("Perawatan Terakhir")),
      lat,
      long,
    },
    measurement: {
      wind_speed: weather("wind"),
      humidity: weather("droplets"),
      temperature: weather("thermometer"),
      ...readIndexes($),
      ispu_source: ispuSource,
      ispu_concentration: ispuConcentration,
      measured_at: parseMeasuredAt(updateText),
    },
  };
}

const INSERT_MEASUREMENT = `
  INSERT INTO measurements (
    station_id, wind_speed, humidity, temperature,
    pm25_index, pm10_index, co_index, so2_index, no2_index, o3_index, ispu_index,
    ispu_source, ispu_concentration, measured_at
  )
  SELECT
    :station_id, :wind_speed, :humidity, :temperature,
    :pm25_index, :pm10_index, :co_index, :so2_index, :no2_index, :o3_index, :ispu_index,
    :ispu_source, :ispu_concentration, :measured_at
  WHERE NOT EXISTS (
    SELECT 1 FROM measurements WHERE station_id = :station_id AND measured_at = :measured_at
  )`;

/**
 * Save one parsed page. `now` is the current WIB time (injectable for tests).
 * Returns { status, active }:
 *   status "inserted"     - a new reading was stored
 *           "existing"    - that reading was already stored
 *           "no-timestamp" - the page had no usable "Update Terakhir", nothing stored
 *   active true/false     - the station's is_active after this scrape (more than 24 hours
 *                           since "Update Terakhir" = false); null when there was no timestamp
 */
export function saveScrape(
  db,
  stationId,
  { station, measurement },
  now = wibNow(),
) {
  db.exec("BEGIN");
  try {
    let operatorId = null;
    if (station.operator) {
      db.prepare(
        "INSERT INTO operators (name) VALUES (?) ON CONFLICT (name) DO NOTHING",
      ).run(station.operator);
      operatorId = db
        .prepare("SELECT id FROM operators WHERE name = ?")
        .get(station.operator).id;
    }

    const current = db
      .prepare(
        `SELECT operator_id, sumber_data, tahun_pengadaan, perawatan_terakhir, lat, long, is_active
           FROM stations WHERE id = ?`,
      )
      .get(stationId);
    if (!current) throw new Error(`station ${stationId} not found`);

    const active = measurement.measured_at
      ? wibToMs(now) - wibToMs(measurement.measured_at) <= STALE_AFTER_MS
      : null;

    // a missing value on the page ("-", or no timestamp for is_active) keeps what is stored
    const incoming = {
      operator_id: operatorId,
      sumber_data: station.sumber_data,
      tahun_pengadaan: station.tahun_pengadaan,
      perawatan_terakhir: station.perawatan_terakhir,
      lat: station.lat,
      long: station.long,
      is_active: active === null ? null : Number(active),
    };
    const next = Object.fromEntries(
      Object.keys(incoming).map((key) => [key, incoming[key] ?? current[key]]),
    );
    if (Object.keys(next).some((key) => next[key] !== current[key])) {
      db.prepare(
        `UPDATE stations SET
           operator_id = :operator_id, sumber_data = :sumber_data,
           tahun_pengadaan = :tahun_pengadaan, perawatan_terakhir = :perawatan_terakhir,
           lat = :lat, long = :long, is_active = :is_active
         WHERE id = :id`,
      ).run({ ...next, id: stationId });
    }

    let status = "no-timestamp";
    if (measurement.measured_at) {
      const { changes } = db
        .prepare(INSERT_MEASUREMENT)
        .run({ station_id: stationId, ...measurement });
      status = changes > 0 ? "inserted" : "existing";
    }

    db.exec("COMMIT");
    return { status, active };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Scrape every station once. Returns the totals ({ inserted, existing, "no-timestamp",
 * inactive, failed }); a failing station is logged and counted, it does not throw.
 * Throws only for problems that stop the whole run (no base URL, no stations ...).
 */
export async function scrapeMeasurements() {
  const base = getBaseUrl();
  const db = openDb();

  try {
    // all stations, inactive ones too: they are checked again and re-activated once fresh
    const stations = db
      .prepare("SELECT id, uuid, spku FROM stations ORDER BY id")
      .all();
    if (stations.length === 0) {
      throw new Error(
        'No stations in the database, run "pnpm scrape:stations" first',
      );
    }

    const totals = {
      inserted: 0,
      existing: 0,
      "no-timestamp": 0,
      inactive: 0,
      failed: 0,
    };
    const messages = {
      inserted: "new reading saved",
      existing: "already stored, skipped",
      "no-timestamp": "no 'Update Terakhir' on the page, no reading saved",
    };

    for (const [i, station] of stations.entries()) {
      const label = `[${i + 1}/${stations.length}] ${station.spku ?? station.uuid}`;
      try {
        const html = await fetchHtml(new URL(`spku/${station.uuid}`, base));
        const { status, active } = saveScrape(
          db,
          station.id,
          parseStationPage(html),
        );
        totals[status]++;
        if (active === false) totals.inactive++;
        console.log(
          `${label}: ${messages[status]}` +
            (active === false ? " (inactive: last update over 24 h ago)" : ""),
        );
      } catch (err) {
        totals.failed++;
        console.error(`${label}: FAILED - ${err.message}`);
      }
      if (i < stations.length - 1) await sleep(REQUEST_DELAY_MS);
    }

    console.log(
      `Done: ${totals.inserted} new, ${totals.existing} already stored, ` +
        `${totals["no-timestamp"]} without timestamp, ${totals.inactive} inactive, ${totals.failed} failed.`,
    );
    return totals;
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  scrapeMeasurements()
    .then((totals) => {
      if (totals.failed > 0) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    });
}
