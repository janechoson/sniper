// Isolated process fixture: no Engine, market providers, wallet or execution capabilities.
import { ModeManager } from "../src/mode-manager.js";
import { Store } from "../src/store.js";
const store = new Store(process.argv[2]!);
const manager = new ModeManager(
  store,
  () => ({
    running: false as boolean,
    async start() {
      this.running = true;
    },
    async stop() {
      this.running = false;
    },
  }),
  async () => {
    throw Error("LIVE_FORBIDDEN");
  },
);
await manager.startDefault();
process.send?.({ ready: true });
// Parent intentionally kills this process to exercise crash/stale-PID recovery.
setInterval(() => {}, 1000);
