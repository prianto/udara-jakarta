// Every timestamp in the database is WIB (UTC+7) wall-clock time, "YYYY-MM-DD HH:MM:SS".
// WIB has no daylight saving, so a fixed +7 h offset is exact. Because the format sorts
// the same way as time, plain string comparison works in SQL (measured_at >= '2026-11-06 00:00:00').
const HOUR_MS = 3_600_000;
const WIB_OFFSET_MS = 7 * HOUR_MS;

const format = (ms) =>
  new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** WIB string -> milliseconds, only meant for comparing/adding WIB strings with each other. */
export const wibToMs = (wib) => Date.parse(`${wib.replace(" ", "T")}Z`);

/** The current time as a WIB string. */
export const wibNow = (date = new Date()) =>
  format(date.getTime() + WIB_OFFSET_MS);

export const addHours = (wib, hours) => format(wibToMs(wib) + hours * HOUR_MS);

/** "2026-11-06 15:24:09" -> "2026-11-06 15:00:00" */
export const startOfHour = (wib) => `${wib.slice(0, 13)}:00:00`;

/** "2026-11-06 13:00:00" -> "2026-11-06T13:00:00+07:00" */
export const toWibIso = (wib) => `${wib.replace(" ", "T")}+07:00`;

/** True for a real calendar date written as YYYY-MM-DD (rejects 2026-02-31). */
export function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}
