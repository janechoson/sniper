import { env } from "../src/config.js";
import { Store } from "../src/store.js";
import { TradingMemory } from "../src/trading-memory.js";
import { acquireLock } from "../src/server.js";
import { json, safeError } from "../src/util.js";
let release: (() => void) | undefined;
let store: Store | undefined;
try {
  const command = process.argv[2];
  if (command !== "report" && command !== "rebuild") throw new Error("Unknown learning command");
  if (command === "rebuild") release = acquireLock(env.DATABASE_PATH);
  store = new Store(env.DATABASE_PATH, { readOnly: command === "report" });
  const memory = new TradingMemory(store);
  if (command === "rebuild")
    process.stdout.write(
      json({ title: "BOT B LEARNING REBUILD", ...memory.rebuild() }) + "\n",
    );
  else if (command === "report") {
    store.db.exec("BEGIN");
    const report = memory.report(env.TRADING_MODE);
    store.db.exec("COMMIT");
    process.stdout.write(json(report) + "\n");
  }
  else throw new Error("Unknown learning command");
} catch (error) {
  process.stdout.write(
    json({ status: "BLOCKED", reason: safeError(error) }) + "\n",
  );
  process.exitCode = 2;
} finally {
  store?.close();
  release?.();
}
