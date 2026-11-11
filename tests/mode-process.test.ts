import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { env } from "../src/config.js";
import { ModeManager } from "../src/mode-manager.js";
import { Store } from "../src/store.js";

test(
  "real second process cannot claim a running session; dead PID recovery preserves funding",
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "rug-session-process-")),
      path = join(dir, "fixture.sqlite"),
      saved = env.TRADING_MODE;
    env.TRADING_MODE = "demo";
    const child = spawn(
      process.execPath,
      [
        "--import",
        "./scripts/test-env.mjs",
        "--import",
        "tsx",
        "tests/mode-session-worker.ts",
        path,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    let store: Store | undefined;
    try {
      const ready = await Promise.race([
        once(child, "message"),
        exited.then(() => {
          throw Error("SESSION_WORKER_EXITED_BEFORE_READY");
        }),
      ]);
      assert.equal((ready[0] as { ready: boolean }).ready, true);
      store = new Store(path);
      const account = store.demoAccountId();
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
        async () => {},
      );
      await assert.rejects(
        manager.startDefault(),
        /ENGINE_SESSION_ALREADY_ACTIVE/,
      );
      child.kill();
      await exited;
      await manager.startDefault();
      assert.equal(manager.engine!.running, true);
      assert.equal(store.demoAccountId(), account);
      assert.equal(
        store.db
          .prepare("SELECT count(*) n FROM demo_ledger WHERE kind='FUNDING'")
          .get()!.n,
        1,
      );
      await manager.stop();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      store?.close();
      env.TRADING_MODE = saved;
      assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);
