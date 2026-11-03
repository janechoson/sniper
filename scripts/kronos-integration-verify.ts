/** Offline reference/native verification. No app config, DB, signer or provider. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { KronosWorker, kronosWorkerEnvironment } from "../src/kronos-worker.js";
import {
  decideForecast,
  type Forecast,
  type LabCandle,
} from "../src/kronos-domain.js";

const reference = resolve(process.argv[2] ?? "../sniper");
const runtime = join(homedir(), "AppData", "Local", "gmgn-kronos-runtime");
const fakeNames = [
  "SOLANA_PRIVATE_KEY",
  "KRONOS_PRIVATE_KEY",
  "WALLET_PRIVATE_KEY",
  "MNEMONIC",
  "JUPITER_API_KEY",
  "GMGN_API_KEY",
  "GMGN_PRIVATE_KEY",
  "SOLANA_KEYPAIR_PATH",
  "TYPESAFE_API_KEY",
];
for (const key of fakeNames) process.env[key] = "SYNTHETIC_SECRET_" + key;
const childEnv = kronosWorkerEnvironment(runtime);
assert.equal(
  fakeNames.some((key) => key in childEnv),
  false,
);
const probe = spawnSync(
  join(runtime, "venv", "Scripts", "python.exe"),
  ["-I", "-B", resolve("lab/kronos/worker.py"), "--isolation-probe"],
  { env: childEnv, encoding: "utf8", windowsHide: true, timeout: 30000 },
);
assert.equal(probe.status, 0, "Python isolation probe failed");
const result = JSON.parse(probe.stdout);
assert.deepEqual(Object.values(result.blocked), [true, true, true, true, true]);
assert.equal(
  fakeNames.some((key) => result.envNames.includes(key)),
  false,
);
assert.equal(
  fakeNames.some((key) =>
    (probe.stdout + probe.stderr).includes(process.env[key]!),
  ),
  false,
);

const refDomain = await import(
  pathToFileURL(join(reference, "src/kronos-domain.ts")).href
);
const refWorker = await import(
  pathToFileURL(join(reference, "src/kronos-worker.ts")).href
);
const at = Date.now(),
  end = Math.floor(at / 60000) * 60000;
const rows: LabCandle[] = Array.from({ length: 40 }, (_, i) => ({
  at: end - (40 - i) * 60000,
  open: 1 + i * 0.001,
  high: 1.02 + i * 0.001,
  low: 0.98 + i * 0.001,
  close: 1 + i * 0.001,
}));
const main = new KronosWorker(runtime),
  old = new refWorker.KronosWorker(join(reference, "runtime"));
try {
  const a = await main.forecast(rows, at),
    b = await old.forecast(rows, at);
  const stable = (f: Forecast) => {
    const { loadMs: _load, latencyMs: _latency, rssBytes: _rss, ...rest } = f;
    return rest;
  };
  assert.deepEqual(stable(a), stable(b));
  for (const open of [false, true])
    assert.deepEqual(
      decideForecast(a, rows, open, at),
      refDomain.decideForecast(a, rows, open, at),
    );
  for (const ends of [
    [1.01, 1.02, 1.03],
    [0.99, 0.98, 0.97],
    [1, 1, 1],
    [1.01, 0.99, 1],
  ])
    for (const open of [false, true]) {
      const f = {
        ...a,
        paths: ends.map((x) => Array(5).fill(rows.at(-1)!.close * x)),
      };
      assert.deepEqual(
        decideForecast(f, rows, open, at),
        refDomain.decideForecast(f, rows, open, at),
      );
    }
  const text = JSON.stringify(a) + JSON.stringify(main.status());
  assert.equal(
    fakeNames.some((key) => text.includes(process.env[key]!)),
    false,
  );
  assert.equal(
    readFileSync("lab/kronos/pins.json", "utf8"),
    readFileSync(join(reference, "lab/kronos/pins.json"), "utf8"),
  );
  console.log(
    JSON.stringify({
      nativeForecastParity: true,
      decisionParity: true,
      isolationProbe: result.blocked,
      secretLeak: false,
      artifactsWritten: 0,
    }),
  );
} finally {
  main.stop();
  old.stop();
}
