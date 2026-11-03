import { test } from "node:test";
import assert from "node:assert/strict";
import { Http } from "../src/util.js";
import { ProviderFailure } from "../src/domain.js";
import { UNSIGNED_EXECUTION_TIMEOUT_MS as LIMIT } from "../src/execution-deadline.js";
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = async () => {
  for (let n = 0; n < 50; n++) await Promise.resolve();
};
const ok = () =>
  new Response('{"ok":true}', {
    headers: { "content-type": "application/json" },
  });

for (const phase of ["fetch", "body"] as const)
  test(
    "Jupiter total deadline releases hung " +
      phase +
      " and permits next request",
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      const entered = deferred<void>(),
        late = deferred<Response | object>();
      let calls = 0,
        signal: AbortSignal | undefined;
      t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, init?: RequestInit) => {
          calls++;
          signal = init?.signal ?? undefined;
          if (calls > 1) return ok();
          if (phase === "fetch") {
            entered.resolve();
            return late.promise as Promise<Response>;
          }
          const response = ok();
          response.json = async () => {
            entered.resolve();
            return late.promise;
          };
          return response;
        },
      );
      const http = new Http("JUPITER", 0, LIMIT);
      const first = http.request("http://127.0.0.1/fixture").catch((e) => e);
      await flush();
      t.mock.timers.tick(0);
      await entered.promise;
      t.mock.timers.tick(LIMIT);
      const failure = await first;
      assert.ok(failure instanceof ProviderFailure);
      assert.equal(failure.code, "JUPITER_REQUEST_TIMEOUT");
      assert.equal(signal?.aborted, true);
      assert.equal(http.health.reason, "JUPITER_REQUEST_TIMEOUT");
      const next = http.request("http://127.0.0.1/next");
      await flush();
      t.mock.timers.tick(0);
      assert.deepEqual(await next, { ok: true });
      const healthAt = http.health.at;
      late.resolve(phase === "fetch" ? ok() : { late: true });
      await flush();
      assert.equal(http.health.state, "READY");
      assert.equal(http.health.at, healthAt);
      assert.equal(calls, 2);
    },
  );

test("queued timeout never fetches later or lets followers skip its active predecessor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const http = new Http("JUPITER", 0, LIMIT),
    prior = deferred<void>();
  let calls = 0;
  // Model a transport predecessor already holding the queue; no network is used.
  Object.assign(http, { tail: prior.promise });
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return ok();
  });
  const expired = http.request("http://127.0.0.1/queued").catch((e) => e);
  t.mock.timers.tick(LIMIT);
  const failure = await expired;
  assert.ok(failure instanceof ProviderFailure);
  assert.equal(failure.code, "JUPITER_REQUEST_TIMEOUT");
  assert.equal(calls, 0);
  const follower = http.request("http://127.0.0.1/follower");
  await flush();
  t.mock.timers.tick(0);
  assert.equal(calls, 0);
  prior.resolve();
  await flush();
  t.mock.timers.tick(0);
  assert.deepEqual(await follower, { ok: true });
  assert.equal(calls, 1);
});
