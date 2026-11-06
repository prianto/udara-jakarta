// Start the API. Configure with PORT (default 3000) and HOST (default 127.0.0.1).
import { loadEnv } from "./config.js";
import { openDb } from "./db.js";
import { buildApp } from "./app.js";

loadEnv();

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const db = openDb();
const app = buildApp({ db, logger: true });
app.addHook("onClose", async () => db.close());

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => app.close().then(() => process.exit(0)));
}

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
