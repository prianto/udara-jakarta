import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { parseStations, saveStations } from "../scripts/scrape-stations.js";

const html = `
<table>
  <thead><tr><th>No</th><th>SPKU</th><th>PARAMETER</th><th>KECAMATAN</th><th>KOTA</th></tr></thead>
  <tbody>
    <tr data-redirect="/spku/d0d713ca-1e2d-430c-980a-7c288f7f5210">
      <td>1</td>
      <td>
        DKI17 SDN 07 Kramat Pela
        <div>JL GANDARIA TENGAH No.5, RT.2/RW.1, Kramat Pela, Kebayoran Baru, South Jakarta City, Jakarta 12130</div>
      </td>
      <td><div><span>PM25</span><span>AIR_HUMID</span><span>DD</span><span>FF</span><span>AT</span></div></td>
      <td>KEBAYORAN  BARU</td>
      <td>KOTA ADM. JAKARTA SELATAN</td>
    </tr>
    <tr data-redirect="/spku/2d554554-7567-4ac1-ab87-536260d2ba79">
      <td>2</td>
      <td>
        DKI01 Bundaran HI
        <div>Jl. M.H. Thamrin, Menteng</div>
      </td>
      <td><div><span>CO</span><span>NO2</span><span>PM10</span></div></td>
      <td>MENTENG</td>
      <td>KOTA ADM. JAKARTA PUSAT</td>
    </tr>
    <tr data-redirect="/somewhere-else"><td>3</td><td>No uuid</td><td></td><td></td><td></td></tr>
  </tbody>
</table>`;

test("parseStations extracts uuid, name, parameters, kecamatan and kota", () => {
  const { stations, skipped } = parseStations(html);
  assert.equal(skipped, 1);
  assert.deepEqual(stations, [
    {
      uuid: "d0d713ca-1e2d-430c-980a-7c288f7f5210",
      spku: "DKI17 SDN 07 Kramat Pela",
      parameter: "PM25,AIR_HUMID,DD,FF,AT",
      kecamatan: "KEBAYORAN BARU",
      kota: "KOTA ADM. JAKARTA SELATAN",
    },
    {
      uuid: "2d554554-7567-4ac1-ab87-536260d2ba79",
      spku: "DKI01 Bundaran HI",
      parameter: "CO,NO2,PM10",
      kecamatan: "MENTENG",
      kota: "KOTA ADM. JAKARTA PUSAT",
    },
  ]);
});

test("saveStations is idempotent and only reports real changes", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const { stations } = parseStations(html);

  assert.deepEqual(saveStations(db, stations), {
    inserted: 2,
    updated: 0,
    unchanged: 0,
  });
  assert.deepEqual(saveStations(db, stations), {
    inserted: 0,
    updated: 0,
    unchanged: 2,
  });

  stations[1].kota = "KOTA ADM. JAKARTA BARAT";
  assert.deepEqual(saveStations(db, stations), {
    inserted: 0,
    updated: 1,
    unchanged: 1,
  });

  const row = db.prepare("SELECT count(*) AS n, is_active FROM stations").get();
  assert.equal(row.n, 2);
  assert.equal(row.is_active, 1);
});
