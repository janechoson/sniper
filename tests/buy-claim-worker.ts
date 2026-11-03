// Real Store on an isolated SQLite file; used only by the concurrent-claim test.
import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";
const unregister = register();
const { Store } = await import(
  new URL("../src/store.ts", import.meta.url).href
);
const store = new Store(workerData.path);
parentPort!.postMessage({ ready: true });
parentPort!.once("message", () => {
  let response;
  try {
    response = {
      result: store.claimMintForBuy(workerData.input, workerData.authority),
    };
  } catch (error) {
    response = {
      error: error instanceof Error ? error.message : "CLAIM_FAILED",
    };
  } finally {
    store.close();
    unregister();
  }
  parentPort!.postMessage(response);
  parentPort!.close();
});
