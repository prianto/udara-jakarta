import Fastify from "fastify";
import {
  addHours,
  isRealDate,
  startOfHour,
  startOfMinute,
  toWibIso,
  wibNow,
} from "./time.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

// optional ?station=<uuid> narrows every endpoint to one station
const stationParam = { type: "string", pattern: UUID_PATTERN };

const SELECT_READINGS = `
  SELECT s.uuid AS station_uuid, s.spku AS station_name, s.lat, s.long,
         m.wind_speed, m.humidity, m.temperature,
         m.pm25_index, m.pm10_index, m.co_index, m.so2_index, m.no2_index, m.o3_index, m.ispu_index,
         m.ispu_source, m.ispu_concentration,
         m.measured_at
    FROM measurements m
    JOIN stations s ON s.id = m.station_id`;

// Windows over measured_at. The WIB string format sorts like time, so plain comparison works.
const WINDOWS = {
  halfOpen: "m.measured_at >= :from AND m.measured_at < :until", // [from, until)
  upToNow: "m.measured_at > :from AND m.measured_at <= :until", //  (from, until]
};

function toRecord(row) {
  return {
    station_uuid: row.station_uuid,
    station_name: row.station_name,
    lat_long:
      row.lat !== null && row.long !== null ? [row.lat, row.long] : null,
    wind_speed: row.wind_speed,
    humidity: row.humidity,
    temperature: row.temperature,
    pm25_index: row.pm25_index,
    pm10_index: row.pm10_index,
    co_index: row.co_index,
    so2_index: row.so2_index,
    no2_index: row.no2_index,
    o3_index: row.o3_index,
    ispu_index: row.ispu_index,
    ispu_source: row.ispu_source,
    ispu_concentration: row.ispu_concentration,
    datetime: toWibIso(row.measured_at), // WIB, e.g. 2026-11-06T13:00:00+07:00
  };
}

/**
 * @param {object} options
 * @param {import("node:sqlite").DatabaseSync} options.db
 * @param {() => Date} [options.clock] current time, injectable for tests
 * @param {boolean|object} [options.logger]
 */
export function buildApp({ db, clock = () => new Date(), logger = false }) {
  const app = Fastify({ logger });

  // `from` and `until` are WIB strings; `window` (see WINDOWS) says which ends are included
  function readings(from, until, station, window = "halfOpen") {
    const params = { from, until };
    let sql = `${SELECT_READINGS} WHERE ${WINDOWS[window]}`;
    if (station) {
      sql += " AND s.uuid = :station";
      params.station = station.toLowerCase();
    }
    sql += " ORDER BY s.spku, m.measured_at";

    const data = db.prepare(sql).all(params).map(toRecord);
    return {
      from: toWibIso(from),
      until: toWibIso(until),
      count: data.length,
      data,
    };
  }

  const currentHourStart = () => startOfHour(wibNow(clock()));

  // The last hour up to this very minute (WIB): until = now with the seconds dropped,
  // from = until - 1 hour. The window is (from, until], so hourly data gives exactly one
  // reading per station, and a reading stamped exactly `until` is included.
  app.get(
    "/api/measurements/now",
    {
      schema: {
        querystring: { type: "object", properties: { station: stationParam } },
      },
    },
    async (request) => {
      const until = startOfMinute(wibNow(clock()));
      return readings(
        addHours(until, -1),
        until,
        request.query.station,
        "upToNow",
      );
    },
  );

  // 24 hourly readings ending with the current hour.
  app.get(
    "/api/measurements/last-24-hours",
    {
      schema: {
        querystring: { type: "object", properties: { station: stationParam } },
      },
    },
    async (request) => {
      const until = addHours(currentHourStart(), 1);
      return readings(addHours(until, -24), until, request.query.station);
    },
  );

  // A whole calendar day, 00:00 up to (not including) 00:00 of the next day, WIB.
  app.get(
    "/api/measurements/daily",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            station: stationParam,
          },
        },
      },
    },
    async (request, reply) => {
      const date = request.query.date ?? wibNow(clock()).slice(0, 10);
      if (!isRealDate(date)) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "date must be a real calendar date written as YYYY-MM-DD",
        });
      }
      const from = `${date} 00:00:00`;
      return readings(from, addHours(from, 24), request.query.station);
    },
  );

  return app;
}
