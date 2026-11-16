// Start the API and the scraper scheduler.
// Configure with PORT (default 4000), HOST (default 127.0.0.1) and SCHEDULER=off to skip the scheduler.
import { loadEnv } from "./config.js";
import { openDb } from "./db.js";
import { buildApp } from "./app.js";
import { startScheduler } from "./scheduler.js";

loadEnv();

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";

const db = openDb();
const app = await buildApp({ db, logger: true });
app.addHook("onClose", async () => db.close());

// Background scraping (node-cron). Set SCHEDULER=off to run the API only.
if (process.env.SCHEDULER === "off") {
  app.log.info("scheduler disabled (SCHEDULER=off)");
} else if (!process.env.DATASOURCE_BASEURL) {
  app.log.warn("DATASOURCE_BASEURL is not set, scheduler not started");
} else {
  const scheduler = startScheduler({ log: app.log });
  app.addHook("onClose", async () => scheduler.stop());
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => app.close().then(() => process.exit(0)));
}

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
