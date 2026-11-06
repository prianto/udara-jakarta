import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/app.js";

const UUID_A = "2d554554-7567-4ac1-ab87-536260d2ba79";
const UUID_B = "d0d713ca-1e2d-430c-980a-7c288f7f5210";

// "now" for all tests: 2026-11-06 15:24 WIB (= 08:24 UTC)
const clock = () => new Date("2026-11-06T08:24:00Z");

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  db.exec(`
    INSERT INTO stations (uuid, spku, lat, long) VALUES ('${UUID_A}', 'DKI01 Bundaran HI', -6.2445, 106.7906);
    INSERT INTO stations (uuid, spku) VALUES ('${UUID_B}', 'DKI17 SDN 07 Kramat Pela');
  `);
  const insert = db.prepare(
    "INSERT INTO measurements (station_id, measured_at, ispu_index, pm25_index, wind_speed) VALUES (?, ?, ?, ?, ?)",
  );
  // station A (id 1): every hour from yesterday 14:00 until today 16:00 (16:00 is "in the future")
  for (
    let t = Date.UTC(2026, 10, 5, 14);
    t <= Date.UTC(2026, 10, 6, 16);
    t += 3_600_000
  ) {
    insert.run(
      1,
      new Date(t).toISOString().slice(0, 19).replace("T", " "),
      100,
      142,
      0.5,
    );
  }
  // station B (id 2): two readings
  insert.run(2, "2026-11-06 15:00:00", 50, 20, null);
  insert.run(2, "2026-11-05 09:00:00", 55, 22, null);
  // a reading that belongs to no station must never show up
  insert.run(null, "2026-11-06 15:00:00", 1, 1, null);

  const app = buildApp({ db, clock });
  return { db, app };
}

const get = async (app, url) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() };
};

test("/now returns the readings of the current hour, one record per station", async () => {
  const { app } = setup();
  const { status, body } = await get(app, "/api/measurements/now");

  assert.equal(status, 200);
  assert.equal(body.from, "2026-11-06T15:00:00+07:00");
  assert.equal(body.until, "2026-11-06T16:00:00+07:00");
  assert.equal(body.count, 2);

  assert.deepEqual(body.data[0], {
    station_uuid: UUID_A,
    station_name: "DKI01 Bundaran HI",
    lat_long: [-6.2445, 106.7906],
    wind_speed: 0.5,
    humidity: null,
    temperature: null,
    pm25_index: 142,
    pm10_index: null,
    co_index: null,
    so2_index: null,
    no2_index: null,
    o3_index: null,
    ispu_index: 100,
    datetime: "2026-11-06T15:00:00+07:00",
  });
  assert.equal(body.data[1].station_name, "DKI17 SDN 07 Kramat Pela");
  assert.equal(body.data[1].lat_long, null); // no coordinates stored
});

test("/now is empty when the current hour has not been published yet", async () => {
  const { db } = setup();
  db.exec(
    "DELETE FROM measurements WHERE measured_at >= '2026-11-06 15:00:00'",
  );
  const app = buildApp({ db, clock });
  const { body } = await get(app, "/api/measurements/now");
  assert.equal(body.count, 0);
  assert.deepEqual(body.data, []);
});

test("/last-24-hours returns the 24 hours ending with the current hour", async () => {
  const { app } = setup();
  const { body } = await get(
    app,
    "/api/measurements/last-24-hours?station=" + UUID_A,
  );

  assert.equal(body.from, "2026-11-05T16:00:00+07:00");
  assert.equal(body.until, "2026-11-06T16:00:00+07:00");
  assert.equal(body.count, 24);
  assert.equal(body.data[0].datetime, "2026-11-05T16:00:00+07:00");
  assert.equal(body.data[23].datetime, "2026-11-06T15:00:00+07:00");
  assert.ok(body.data.every((r) => r.station_uuid === UUID_A));
});

test("/last-24-hours without a station mixes stations, ordered by station then time", async () => {
  const { app } = setup();
  const { body } = await get(app, "/api/measurements/last-24-hours");
  assert.equal(body.count, 25); // 24 for A + 1 for B (B's 11-05 09:00 is too old)
  assert.equal(body.data[0].station_name, "DKI01 Bundaran HI");
  assert.equal(body.data[24].station_name, "DKI17 SDN 07 Kramat Pela");
});

test("/daily returns 00:00 up to the next 00:00 of the given date", async () => {
  const { app } = setup();
  const { status, body } = await get(
    app,
    `/api/measurements/daily?date=2026-11-05&station=${UUID_A}`,
  );

  assert.equal(status, 200);
  assert.equal(body.from, "2026-11-05T00:00:00+07:00");
  assert.equal(body.until, "2026-11-06T00:00:00+07:00");
  assert.equal(body.count, 10); // station A has 14:00..23:00 on that day
  assert.equal(body.data[0].datetime, "2026-11-05T14:00:00+07:00");
  assert.equal(body.data[9].datetime, "2026-11-05T23:00:00+07:00");
});

test("/daily defaults to today (WIB)", async () => {
  const { app } = setup();
  const { body } = await get(app, `/api/measurements/daily?station=${UUID_A}`);
  assert.equal(body.from, "2026-11-06T00:00:00+07:00");
  assert.equal(body.count, 17); // 00:00..16:00
});

test("bad input gives 400", async () => {
  const { app } = setup();
  for (const url of [
    "/api/measurements/daily?date=2026-02-31",
    "/api/measurements/daily?date=yesterday",
    "/api/measurements/now?station=not-a-uuid",
  ]) {
    const { status, body } = await get(app, url);
    assert.equal(status, 400, url);
    assert.equal(body.statusCode, 400);
  }
});

test("an unknown station gives an empty list", async () => {
  const { app } = setup();
  const { status, body } = await get(
    app,
    "/api/measurements/now?station=11111111-1111-4111-8111-111111111111",
  );
  assert.equal(status, 200);
  assert.equal(body.count, 0);
});
