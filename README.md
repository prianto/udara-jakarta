# Udara Jakarta

This project collects air-quality readings (ISPU) from the Udara Jakarta,
stores them in SQLite, and serves them through a small HTTP API.

```
data source (HTML)  ──scrape──▶  SQLite (db/data.sqlite)  ──▶  Fastify API
```

- **Scrapers** fetch the station list and each station's latest reading, parse the HTML with cheerio.
- **Scheduler** (node-cron) runs the scrapers automatically while the API is running.
- **API** returns readings for the last hour, the last 24 hours, or a whole day.

## Requirements

- Node.js **22.13 or newer** (uses the built-in `node:sqlite`, no native build needed)
- [pnpm](https://pnpm.io) (the exact version is pinned in `package.json`)

## Quick start

```sh
pnpm install
echo 'DATASOURCE_BASEURL=https://example.com' > .env   # base URL of the data source
pnpm db:init               # create db/data.sqlite
pnpm scrape:stations       # fill the stations table
pnpm scrape:measurements   # fetch the latest reading of every station
pnpm start                 # API on http://127.0.0.1:3000 (+ scheduler)
```

Node prints an "ExperimentalWarning: SQLite is an experimental feature" message. It is harmless.
To hide it, run Node with `--disable-warning=ExperimentalWarning`.

## Configuration

Settings come from `.env` in the project root or from real environment variables (which win).

| Variable             | Default                   | Meaning                                                      |
| -------------------- | ------------------------- | ------------------------------------------------------------ |
| `DATASOURCE_BASEURL` | _(required for scraping)_ | Base URL of the data source, with or without trailing slash  |
| `PORT`               | `3000`                    | API port                                                     |
| `HOST`               | `127.0.0.1`               | API bind address (use `0.0.0.0` to listen on all interfaces) |
| `SCHEDULER`          | _(on)_                    | Set to `off` to run the API without the scheduler            |
| `REQUEST_DELAY_MS`   | `300`                     | Pause between station requests in `scrape-measurements`      |

## Commands

| Command                    | What it does                                                                     |
| -------------------------- | -------------------------------------------------------------------------------- |
| `pnpm start`               | Start the API and the scheduler                                                  |
| `pnpm dev`                 | Same, restarting on file changes                                                 |
| `pnpm scrape:stations`     | Fetch `<DATASOURCE_BASEURL>/lokasi-spku` and save the stations                   |
| `pnpm scrape:measurements` | Fetch `<DATASOURCE_BASEURL>/spku/<uuid>` for every station and save the readings |
| `pnpm db:init`             | Create `db/data.sqlite` from `db/schema.sql` (safe to re-run)                    |
| `pnpm db:example`          | Regenerate `db/data.sqlite.example`                                              |
| `pnpm test`                | Run the tests (Node's built-in test runner)                                      |

## Database

`db/schema.sql` is the single source of truth. `db/data.sqlite` is local and git-ignored;
`db/data.sqlite.example` is an empty database with the tables, committed as a template
(copy it to `db/data.sqlite`, or run `pnpm db:init`).

**All timestamps are WIB (UTC+7)** wall-clock time, written as `YYYY-MM-DD HH:MM:SS`, the same as
the data source shows them. This includes `created_at`, `updated_at` and `measured_at`.

| Table          | Columns                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operators`    | `id`, `name` (unique), `created_at`, `updated_at`                                                                                                                                                           |
| `stations`     | `id`, `operator_id`, `uuid` (unique), `spku` (name), `parameter`, `sumber_data`, `kecamatan`, `kota`, `lat`, `long`, `is_active`, `tahun_pengadaan`, `perawatan_terakhir`, `created_at`, `updated_at`       |
| `measurements` | `id`, `station_id`, `wind_speed`, `humidity`, `temperature`, `pm25_index`, `pm10_index`, `co_index`, `so2_index`, `no2_index`, `o3_index`, `ispu_index`, `ispu_source`, `ispu_concentration`, `measured_at` |

- Relations (`stations.operator_id`, `measurements.station_id`) are optional; deleting the parent sets them to null.
- `ispu_source` is the parameter that determines the ISPU, lowercase without a dot (`pm25`, `pm10`, `o3` ...);
  `ispu_concentration` is its concentration as a number (`9.81`).
- The index columns may be null when the page does not report them.

`CREATE TABLE IF NOT EXISTS` never changes an existing table. After the schema gains a column, add it to
your local database with `ALTER TABLE ... ADD COLUMN ...`, or delete `db/data.sqlite`, run `pnpm db:init`
and scrape again.

## Scrapers

### `scripts/scrape-stations.js`

Reads the station table on `/lokasi-spku`. Stations are matched by the uuid in each row's
`data-redirect="/spku/<uuid>"`, so running it again updates existing stations instead of duplicating them.
`parameter` is saved as a comma-separated list (`PM25,AIR_HUMID,DD`). If no rows can be parsed
(for example the layout changed), nothing is saved and the script fails.

### `scripts/scrape-measurements.js`

For every station it reads `/spku/<uuid>` and:

- inserts one row into `measurements` (the indexes come from the page's JSON-LD block, the weather from the
  wind / droplets / thermometer icons, the ISPU source and concentration from `#ispu-parameter` and
  `#ispu-concentration`). It is skipped if that station already has a reading with the same
  "Update Terakhir" time;
- fills in the station's operator (creating it in `operators` if new), type (`sumber_data`), procurement year,
  last maintenance and coordinates. A `-` on the page never overwrites a stored value;
- sets `stations.is_active` to `0` when "Update Terakhir" is more than 24 hours old, and back to `1` when the
  station reports fresh data again.

One failing station is logged and does not stop the others; the script then exits with code 1.

## Scheduler

While the API is running (`pnpm start`), node-cron runs, in the `Asia/Jakarta` time zone:

| Job                   | Schedule           |
| --------------------- | ------------------ |
| `scrape-stations`     | every day at 00:00 |
| `scrape-measurements` | every 30 minutes   |

Jobs run one at a time and a job that is still running or waiting is not queued twice. Failures are logged
and never stop later runs. Nothing is scraped at startup, so after a restart the first run is at the next
scheduled time (run the scrape commands by hand if you need data sooner). The scheduler does not start when
`DATASOURCE_BASEURL` is unset or `SCHEDULER=off`.

## API

All endpoints are `GET`, return JSON, and accept an optional `station=<uuid>` to limit the result to one station.

| Endpoint                                  | Returns                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `/api/measurements/now`                   | Readings of the last hour up to the current minute: `(now - 1 hour, now]`, WIB |
| `/api/measurements/last-24-hours`         | 24 hourly readings ending with the current hour                                |
| `/api/measurements/daily?date=YYYY-MM-DD` | A whole day, 00:00 up to the next 00:00 (WIB). `date` defaults to today        |

Notes:

- `/now` is empty when nothing was published in the last hour.
- An invalid `date` (for example `2026-02-31`) or `station` returns `400`.
- Results are ordered by station name, then time.

Example: `GET /api/measurements/daily?date=2026-11-06`

```json
{
  "from": "2026-11-06T00:00:00+07:00",
  "until": "2026-11-07T00:00:00+07:00",
  "count": 1,
  "data": [
    {
      "station_uuid": "2d554554-7567-4ac1-ab87-536260d2ba79",
      "station_name": "DKI01 Bundaran HI",
      "lat_long": [-6.2445, 106.7906],
      "wind_speed": 0.5,
      "humidity": 83,
      "temperature": 30,
      "pm25_index": 142,
      "pm10_index": 67,
      "co_index": 4,
      "so2_index": 39,
      "no2_index": 65,
      "o3_index": 27,
      "ispu_index": 142,
      "ispu_source": "pm25",
      "ispu_concentration": 9.81,
      "datetime": "2026-11-06T13:00:00+07:00"
    }
  ]
}
```

`lat_long` is `[lat, long]`, or `null` when the station has no coordinates.

## Project layout

```
.
├── db/
│   ├── schema.sql              # all tables
│   ├── data.sqlite             # local database (git-ignored)
│   └── data.sqlite.example     # empty template (committed)
├── scripts/
│   ├── init-db.js              # builds a database from schema.sql
│   ├── scrape-stations.js
│   ├── scrape-measurements.js
│   └── lib/common.js           # base URL, fetch helper (user agent lives here)
├── src/
│   ├── server.js               # starts the API and the scheduler
│   ├── app.js                  # Fastify routes
│   ├── scheduler.js            # node-cron jobs
│   ├── db.js                   # opens db/data.sqlite
│   ├── config.js               # project root, .env loading
│   └── time.js                 # WIB time helpers
└── test/                       # node:test files
```

## Troubleshooting

- **`HTTP 403` from the scrapers**: the data source is rejecting the request. The user agent is set in
  `scripts/lib/common.js`.
- **`DATASOURCE_BASEURL is not set`**: add it to `.env`.
- **`db/data.sqlite not found`**: run `pnpm db:init`.
- **"No station rows found"**: the station page layout probably changed; the selectors are in `parseStations`
  in `scripts/scrape-stations.js`.
