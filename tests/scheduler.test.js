import { test } from "node:test";
import assert from "node:assert/strict";
import { startScheduler } from "../src/scheduler.js";

// stand-in for node-cron: remembers what was scheduled so a test can "fire" it
function fakeCron() {
  const tasks = [];
  return {
    tasks,
    schedule(expression, fn, options) {
      const task = {
        expression,
        fn,
        options,
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
      tasks.push(task);
      return task;
    },
  };
}

function fakeLog() {
  const log = { infos: [], warns: [], errors: [] };
  log.info = (...args) => log.infos.push(args);
  log.warn = (...args) => log.warns.push(args);
  log.error = (...args) => log.errors.push(args);
  return log;
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("schedules the stations job daily at 00:00 and measurements every 30 minutes, in WIB", () => {
  const cronLib = fakeCron();
  startScheduler({ log: fakeLog(), cronLib, jobs: {} });

  assert.equal(cronLib.tasks.length, 2);
  assert.equal(cronLib.tasks[0].expression, "0 0 * * *");
  assert.equal(cronLib.tasks[0].options.name, "stations");
  assert.equal(cronLib.tasks[1].expression, "*/30 * * * *");
  assert.equal(cronLib.tasks[1].options.name, "measurements");
  assert.ok(
    cronLib.tasks.every((task) => task.options.timezone === "Asia/Jakarta"),
  );
});

test("jobs run one after another, and a job that is already waiting is not queued twice", async () => {
  const order = [];
  let finishStations;
  const jobs = {
    stations: () =>
      new Promise((resolve) => {
        order.push("stations start");
        finishStations = () => {
          order.push("stations end");
          resolve({ total: 1 });
        };
      }),
    measurements: async () => {
      order.push("measurements");
      return { failed: 0 };
    },
  };
  const cronLib = fakeCron();
  const log = fakeLog();
  const scheduler = startScheduler({ log, cronLib, jobs });
  const [stationsTask, measurementsTask] = cronLib.tasks;

  stationsTask.fn(); //      starts right away
  measurementsTask.fn(); //  waits for stations to finish
  measurementsTask.fn(); //  already waiting: skipped
  await nextTick();
  assert.deepEqual(order, ["stations start"]);

  finishStations();
  await scheduler.idle();
  assert.deepEqual(order, ["stations start", "stations end", "measurements"]);
  assert.equal(log.warns.length, 1); // the skipped tick

  // once finished, the job can be scheduled again
  measurementsTask.fn();
  await scheduler.idle();
  assert.equal(order.filter((step) => step === "measurements").length, 2);
});

test("a failing job is logged and does not stop the next one", async () => {
  const ran = [];
  const jobs = {
    stations: async () => {
      throw new Error("site is down");
    },
    measurements: async () => {
      ran.push("measurements");
      return { failed: 2 };
    },
  };
  const cronLib = fakeCron();
  const log = fakeLog();
  const scheduler = startScheduler({ log, cronLib, jobs });

  cronLib.tasks[0].fn();
  cronLib.tasks[1].fn();
  await scheduler.idle();

  assert.deepEqual(ran, ["measurements"]);
  assert.equal(log.errors.length, 1);
  assert.match(String(log.errors[0][0].message), /site is down/);
  assert.equal(log.warns.length, 1); // measurements finished with failed > 0
});

test("stop() stops every scheduled task", () => {
  const cronLib = fakeCron();
  const scheduler = startScheduler({ log: fakeLog(), cronLib, jobs: {} });
  scheduler.stop();
  assert.ok(cronLib.tasks.every((task) => task.stopped));
});
