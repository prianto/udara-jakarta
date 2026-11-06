// Runs the scrapers on a schedule (node-cron) inside the API process:
//   scrape-stations      every day at 00:00 (WIB)
//   scrape-measurements  every 30 minutes
//
// Jobs run one at a time, so the 00:00 station refresh finishes before the 00:00 measurements
// run starts. A job that is still running or already waiting is not queued a second time.
import cron from "node-cron";
import { scrapeStations } from "../scripts/scrape-stations.js";
import { scrapeMeasurements } from "../scripts/scrape-measurements.js";

export const TIMEZONE = "Asia/Jakarta";
export const SCHEDULE = {
  stations: "0 0 * * *",
  measurements: "*/30 * * * *",
};

/**
 * @param {object} options
 * @param {{ info: Function, warn: Function, error: Function }} options.log e.g. the Fastify logger
 * @param {object} [options.cronLib] node-cron (injectable for tests)
 * @param {Record<string, () => Promise<object>>} [options.jobs] injectable for tests
 */
export function startScheduler({
  log,
  cronLib = cron,
  jobs = { stations: scrapeStations, measurements: scrapeMeasurements },
}) {
  const queued = new Set(); // names that are running or waiting
  let chain = Promise.resolve();

  function enqueue(name) {
    if (queued.has(name)) {
      log.warn(
        `scheduler: ${name} is still running or waiting, skipping this tick`,
      );
      return;
    }
    queued.add(name);
    chain = chain.then(async () => {
      log.info(`scheduler: ${name} started`);
      try {
        const result = await jobs[name]();
        if (result?.failed > 0)
          log.warn(result, `scheduler: ${name} finished with failures`);
        else log.info(result, `scheduler: ${name} finished`);
      } catch (err) {
        log.error(err, `scheduler: ${name} failed`);
      } finally {
        queued.delete(name);
      }
    });
  }

  const tasks = Object.entries(SCHEDULE).map(([name, expression]) =>
    cronLib.schedule(expression, () => enqueue(name), {
      name,
      timezone: TIMEZONE,
    }),
  );
  log.info({ schedule: SCHEDULE, timezone: TIMEZONE }, "scheduler started");

  return {
    /** Stop scheduling. A run already in progress is not interrupted. */
    stop() {
      for (const task of tasks) (task.destroy ?? task.stop).call(task);
    },
    /** Resolves when every job queued so far has finished (used by tests). */
    idle: () => chain,
  };
}
