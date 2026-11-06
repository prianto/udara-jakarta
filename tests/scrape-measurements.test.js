import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  parseDate,
  parseMeasuredAt,
  parseStationPage,
  saveScrape,
} from "../scripts/scrape-measurements.js";

const pageHtml = `
<script type="application/ld&#x2B;json">
{
  "@context": "https://schema.org",
  "@type": "Dataset",
  "name": "Data Kualitas Udara DKI1 - KOTA ADM. JAKARTA PUSAT",
  "variableMeasured": [
    { "@type": "PropertyValue", "name": "CO", "unitText": "Indeks", "value": 4 },
    { "@type": "PropertyValue", "name": "NO2", "unitText": "Indeks", "value": 65 },
    { "@type": "PropertyValue", "name": "SO2", "unitText": "Indeks", "value": 39 },
    { "@type": "PropertyValue", "name": "PM2.5", "unitText": "Indeks", "value": 142 },
    { "@type": "PropertyValue", "name": "O3", "unitText": "Indeks", "value": 27 },
    { "@type": "PropertyValue", "name": "PM10", "unitText": "Indeks", "value": 67 },
    { "@type": "PropertyValue", "name": "ISPU", "unitText": "Indeks", "value": 142 }
  ]
}
</script>
<div>
  <div>
    <div><div><p>Dioperasikan Oleh</p><p>Dinas Lingkungan Hidup</p></div></div>
    <div><div><p>Tipe</p><p>Sensor</p></div></div>
    <div><div><p>Tahun Pengadaan</p><p>-</p></div></div>
    <div><div><p>Perawatan Terakhir</p><p>-</p></div></div>
    <a href="https://www.google.com/maps/@-6.244491,106.790577,15z" target="_blank">
      <div><i data-lucide="locate-fixed"></i></div>
      <div><p>Titik Koordinat</p><p>-6.2445, 106.7906</p></div>
    </a>
  </div>
  <p>
    Update Terakhir: <span title="Jumat, 6 November 2026 13.00 WIB">Jumat, 6 November 2026 13.00 WIB</span>
  </p>
</div>
<div>
  <div>
    <div><div><i data-lucide="wind"></i></div><p>
      0.5 km/h
    </p></div>
    <div><div><i data-lucide="droplets"></i></div><p>
      83%
    </p></div>
    <div><div><i data-lucide="thermometer"></i></div><p>
      30°
    </p></div>
  </div>
</div>`;

const NOW = "2026-11-06 15:24:00"; // "current time" (WIB) used by the saveScrape tests

function newDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec(
    "INSERT INTO stations (uuid, spku) VALUES ('2d554554-7567-4ac1-ab87-536260d2ba79', 'DKI01')",
  );
  return db;
}

test("parseStationPage reads station details, weather and ISPU indexes", () => {
  const { station, measurement } = parseStationPage(pageHtml);

  assert.deepEqual(station, {
    operator: "Dinas Lingkungan Hidup",
    sumber_data: "Sensor",
    tahun_pengadaan: null,
    perawatan_terakhir: null,
    lat: -6.2445,
    long: 106.7906,
  });

  assert.deepEqual(measurement, {
    wind_speed: 0.5,
    humidity: 83,
    temperature: 30,
    co_index: 4,
    no2_index: 65,
    so2_index: 39,
    pm25_index: 142,
    o3_index: 27,
    pm10_index: 67,
    ispu_index: 142,
    measured_at: "2026-11-06 13:00:00", // exactly as shown on the page (WIB)
  });
});

test("an index missing from the page becomes null", () => {
  const html = pageHtml.replace(/\{[^{}]*"name": "O3"[^{}]*\},?/, "");
  const { measurement } = parseStationPage(html);
  assert.equal(measurement.o3_index, null);
  assert.equal(measurement.pm10_index, 67);
});

test("date helpers keep the WIB time as displayed", () => {
  assert.equal(
    parseMeasuredAt("Jumat, 6 November 2026 13.00 WIB"),
    "2026-11-06 13:00:00",
  );
  assert.equal(
    parseMeasuredAt("Sabtu, 7 Maret 2026 02:30 WIB"),
    "2026-03-07 02:30:00",
  );
  assert.equal(parseMeasuredAt("17 Agustus 2026 08.15"), "2026-08-17 08:15:00"); // zone text is optional
  assert.equal(parseMeasuredAt("2026-11-06 00:00"), "2026-11-06 00:00:00");
  assert.equal(parseMeasuredAt("-"), null);
  assert.equal(parseMeasuredAt("6 November 2026"), null); // no time -> unusable
  assert.equal(parseMeasuredAt("6 November 2026 25.00 WIB"), null); // impossible time

  assert.equal(parseDate("12 Mei 2025"), "2025-05-12");
  assert.equal(parseDate("2025-05-12"), "2025-05-12");
  assert.equal(parseDate("-"), null);
  assert.equal(parseDate(null), null);
});

test("saveScrape stores the reading once and fills in station details", () => {
  const db = newDb();
  const parsed = parseStationPage(pageHtml);

  assert.equal(saveScrape(db, 1, parsed, NOW).status, "inserted");
  assert.equal(saveScrape(db, 1, parsed, NOW).status, "existing"); // same "Update Terakhir"

  assert.equal(db.prepare("SELECT count(*) AS n FROM measurements").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM operators").get().n, 1);

  const station = db.prepare("SELECT * FROM stations WHERE id = 1").get();
  assert.equal(station.sumber_data, "Sensor");
  assert.equal(station.lat, -6.2445);
  assert.equal(station.long, 106.7906);
  assert.equal(station.operator_id, 1);

  // a newer reading is added
  parsed.measurement.measured_at = "2026-11-06 14:00:00";
  assert.equal(saveScrape(db, 1, parsed, NOW).status, "inserted");
  assert.equal(db.prepare("SELECT count(*) AS n FROM measurements").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM operators").get().n, 1);

  const row = db
    .prepare("SELECT * FROM measurements ORDER BY id LIMIT 1")
    .get();
  assert.equal(row.ispu_index, 142);
  assert.equal(row.measured_at, "2026-11-06 13:00:00");
});

test('a "-" on the page does not wipe values already stored', () => {
  const db = newDb();
  db.exec(
    "UPDATE stations SET tahun_pengadaan = 2020, perawatan_terakhir = '2025-05-12' WHERE id = 1",
  );

  saveScrape(db, 1, parseStationPage(pageHtml), NOW); // page says "-" for both
  const station = db
    .prepare(
      "SELECT tahun_pengadaan, perawatan_terakhir FROM stations WHERE id = 1",
    )
    .get();
  assert.equal(station.tahun_pengadaan, 2020);
  assert.equal(station.perawatan_terakhir, "2025-05-12");
});

test("a page without a usable timestamp saves no measurement", () => {
  const db = newDb();
  const parsed = parseStationPage(pageHtml);
  parsed.measurement.measured_at = null;
  const result = saveScrape(db, 1, parsed, NOW);
  assert.deepEqual(result, { status: "no-timestamp", active: null });
  assert.equal(db.prepare("SELECT count(*) AS n FROM measurements").get().n, 0);
  assert.equal(
    db.prepare("SELECT is_active FROM stations WHERE id = 1").get().is_active,
    1,
  ); // untouched
});

test("stations go inactive when the last update is more than 24 hours old, and come back", () => {
  const db = newDb();
  const isActive = () =>
    db.prepare("SELECT is_active FROM stations WHERE id = 1").get().is_active;
  const scrapeAt = (measuredAt) => {
    const parsed = parseStationPage(pageHtml);
    parsed.measurement.measured_at = measuredAt;
    return saveScrape(db, 1, parsed, NOW); // NOW = 2026-11-06 15:24:00 WIB
  };

  assert.equal(scrapeAt("2026-11-06 13:00:00").active, true);
  assert.equal(isActive(), 1);

  assert.equal(scrapeAt("2026-11-05 15:24:00").active, true); // exactly 24 h: not "more than"
  assert.equal(isActive(), 1);

  assert.equal(scrapeAt("2026-11-05 15:23:00").active, false); // 24 h 1 min
  assert.equal(isActive(), 0);

  assert.equal(scrapeAt("2026-11-06 14:00:00").active, true); // reports again -> active again
  assert.equal(isActive(), 1);
});
