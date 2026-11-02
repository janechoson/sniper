import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { MintLayout } from "@solana/spl-token";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { ROOT, localPath, runtimeConfig } from "../src/config.js";
import { startKronos } from "../src/server.js";
import { KronosStore } from "../src/kronos-store.js";
import { KronosMarket } from "../src/kronos-market.js";
import { KronosWorker, kronosWorkerEnvironment } from "../src/kronos-worker.js";
import { TOKEN_PROGRAM_ID } from "../src/token-program.js";
import {
  KRONOS,
  decideForecast,
  validateCandles,
} from "../src/kronos-domain.js";
import {
  decideForecast as oldDecide,
  KRONOS as OLD,
} from "./baseline-domain.js";
import { KronosLab as OldLab } from "./baseline-lab.js";
import { MINT, bars, forecast, fixture } from "./fixtures.js";

function directory() {
  mkdirSync(join(ROOT, "data"), { recursive: true });
  return mkdtempSync(join(ROOT, "data", "test-"));
}

test("empty installation has zero trials, positions, fills, history and no legacy names", () => {
  const s = new KronosStore(join(directory(), "new.sqlite"));
  try {
    assert.equal(s.summary().records, 0);
    assert.equal(s.summary().paperBuys, 0);
    assert.equal(s.summary().open, 0);
    assert.equal(s.summary().closed, 0);
    assert.equal(s.summary().totalPaperPnlPct, null);
    for (const table of [
      "lab_trials",
      "lab_decisions",
      "lab_events",
      "lab_meta",
    ])
      assert.equal(s.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
    assert(!JSON.stringify(s.trials()).includes("GATO"));
    assert(!JSON.stringify(s.trials()).includes("Dacity"));
  } finally {
    s.close();
  }
});

test("own paths only, no sibling BOT directory or external DB; accidental LIVE fails closed", () => {
  assert.equal(runtimeConfig({}).mode, "paper");
  assert.equal(runtimeConfig({}).realExecutionEnabled, false);
  assert.equal(runtimeConfig({ TRADING_MODE: "live" }).mode, "live");
  assert.equal(runtimeConfig({ TRADING_MODE: "invalid" }).mode, "paper");
  assert.throws(() => localPath("../other/data.sqlite"), /OUTSIDE_PROJECT/);
  assert.throws(() => new KronosStore("../other.sqlite"), /OUTSIDE_PROJECT/);
  assert(relative(ROOT, runtimeConfig({}).database).startsWith("data"));
});

test("unlimited trials beyond 200 count rejects/errors, no eviction or appearance duplicates", () => {
  const s = new KronosStore(":memory:");
  try {
    for (let i = 0; i < 300; i++) {
      const t = s.add({
        mint: "mint" + i,
        appearance: "appearance" + i,
        discoveredAt: Date.now(),
      })!;
      assert(t);
      if (i % 2) {
        t.status = "REJECTED";
        s.save(t);
      }
    }
    const before = s.db
      .prepare("SELECT * FROM lab_trials ORDER BY rowid")
      .all();
    assert.ok(
      s.add({
        mint: "overflow",
        appearance: "overflow",
        discoveredAt: Date.now(),
      }),
    );
    assert.equal(
      s.add({
        mint: "mint0",
        appearance: "appearance0",
        discoveredAt: Date.now(),
      }),
      undefined,
    );
    assert.deepEqual(
      s.db
        .prepare("SELECT * FROM lab_trials WHERE rowid<=300 ORDER BY rowid")
        .all(),
      before,
    );
    assert.equal(s.summary().records, 301);
    assert.equal("limit" in s.summary(), false);
  } finally {
    s.close();
  }
});

test("real Lab lifecycle PAPER BUY/HOLD/SELL: zero wallet/sign/send, JEV and Jupiter never requested", async () => {
  const forbidden = [
    mock.method(VersionedTransaction.prototype, "sign", () => {
      throw Error("SIGN_FORBIDDEN");
    }),
    mock.method(Connection.prototype, "sendTransaction", () => {
      throw Error("SUBMIT_FORBIDDEN");
    }),
  ];
  const previous = globalThis.fetch,
    network: string[] = [];
  globalThis.fetch = async (u) => {
    network.push(String(u));
    throw Error("ANY_NETWORK_FORBIDDEN");
  };
  const h = fixture();
  try {
    await h.lab.discover();
    const id = h.store.trials()[0]!.id;
    await h.lab.step(id);
    assert.equal(h.store.trials()[0]!.status, "OPEN");
    assert.equal(h.store.trials()[0]!.entry!.value, 1);
    h.fresh();
    await h.lab.step(id);
    assert.equal(h.store.trials()[0]!.latest!.action, "HOLD");
    h.set({ direction: -1, price: 1.1 });
    h.fresh();
    await h.lab.step(id);
    const t = h.store.trials()[0]!;
    assert.equal(t.status, "CLOSED");
    assert(Math.abs(t.pnlPct! - 10) < 1e-8);
    assert.equal(h.store.decisions(id).length, 3);
    assert.deepEqual(network, []);
    for (const g of forbidden) assert.equal(g.mock.callCount(), 0);
  } finally {
    h.store.close();
    globalThis.fetch = previous;
    for (const g of forbidden) g.mock.restore();
  }
});

test("native input / consensus / paper prices exactly match old policy, cap change is explicit", () => {
  assert.equal(OLD.maxRecords, 300);
  assert.equal("maxRecords" in KRONOS, false);
  const { maxRecords: _max, decisionCap: _cap, ...policy } = OLD;
  assert.deepEqual(policy, KRONOS);
  const rows = bars(),
    now = Date.now();
  for (const dir of [-1, 0, 1])
    for (const open of [false, true]) {
      const f = forecast(rows, now, dir);
      assert.deepEqual(
        decideForecast(f, rows, open, now),
        oldDecide(f, rows, open, now),
      );
    }
  assert.throws(() => validateCandles(rows.slice(0, 4), now));
  const f = forecast(rows, now);
  f.paths[0] = Array(5).fill(0.99);
  assert.equal(decideForecast(f, rows, false, now).action, "WAIT");
  assert.equal(decideForecast(f, rows, true, now).action, "HOLD");
});

test("new candidate model failure has no BUY; OPEN failure never fakes SELL or calls JEV", async () => {
  for (const open of [false, true]) {
    const h = fixture();
    try {
      await h.lab.discover();
      const id = h.store.trials()[0]!.id;
      if (open) await h.lab.step(id);
      h.fresh();
      h.set({ fail: true, price: 0.8 });
      await h.lab.step(id);
      const t = h.store.trials()[0]!;
      assert.equal(t.latest?.action, "UNAVAILABLE");
      assert.equal(t.exit, undefined);
      assert.equal(!!t.entry, open);
      assert.equal(t.status, open ? "OPEN" : "ERROR");
    } finally {
      h.store.close();
    }
  }
});

test("pending PAPER sell requires valid post-decision price, no forecast/fill invented", async () => {
  const h = fixture();
  try {
    await h.lab.discover();
    const id = h.store.trials()[0]!.id;
    await h.lab.step(id);
    h.fresh();
    h.set({ direction: -1, price: null });
    await h.lab.step(id);
    assert.equal(h.store.trials()[0]!.status, "SELL_DECIDED_PRICE_PENDING");
    const calls = h.calls();
    h.set({ price: 0.9 });
    await h.lab.step(id);
    assert.equal(h.store.trials()[0]!.status, "CLOSED");
    assert.equal(h.calls(), calls);
  } finally {
    h.store.close();
  }
});

test("slow discovery does not block OPEN monitor; inference stays serial", async () => {
  const h = fixture();
  let release!: () => void;
  try {
    await h.lab.discover();
    const id = h.store.trials()[0]!.id;
    await h.lab.step(id);
    h.fresh();
    h.set({ price: 1.2 });
    h.market.discover = () =>
      new Promise((r) => {
        release = () => r([]);
      });
    h.lab.setEnabled(true);
    await h.lab.tick();
    assert.equal(h.store.trials()[0]!.current?.value, 1.2);
    assert.equal(h.lab.status().concurrency, 1);
    release();
    h.lab.setEnabled(false);
    await h.lab.stop();
  } finally {
    release?.();
    h.store.close();
  }
});

test("200 queued trials never run concurrent model inferences", async () => {
  const h = fixture();
  let release!: () => void,
    active = 0,
    maximum = 0;
  try {
    h.market.discover = async () =>
      Array.from({ length: 200 }, (_, i) => ({
        mint: "serial" + i,
        source: "gmgn:trending",
        discoveredAt: Date.now(),
      }));
    await h.lab.discover();
    h.inference.forecast = async (rows, at) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((r) => {
        release = r;
      });
      active--;
      return forecast(rows, at);
    };
    h.market.discover = async () => [];
    h.lab.setEnabled(true);
    const first = h.lab.tick();
    while (!release) await new Promise((r) => setImmediate(r));
    await Promise.all(Array.from({ length: 200 }, () => h.lab.tick()));
    assert.equal(maximum, 1);
    release();
    await first;
    h.lab.setEnabled(false);
    assert.equal(h.store.trials().length, 200);
  } finally {
    release?.();
    h.store.close();
  }
});

test("invalid model output never invents BUY or exits OPEN", async () => {
  for (const open of [false, true]) {
    const h = fixture();
    try {
      await h.lab.discover();
      const id = h.store.trials()[0]!.id;
      if (open) await h.lab.step(id);
      h.fresh();
      h.inference.forecast = async (rows, at) => ({
        ...forecast(rows, at),
        model: { id: "invalid", revision: "HEAD" },
      });
      await h.lab.step(id);
      const t = h.store.trials()[0]!;
      assert.equal(t.latest?.action, "UNAVAILABLE");
      assert.equal(t.exit, undefined);
      assert.equal(!!t.entry, open);
    } finally {
      h.store.close();
    }
  }
});

test("restart own DB preserves OPEN entry and no duplicate appearance BUY", async () => {
  const path = join(directory(), "own.sqlite");
  const h = fixture(path);
  await h.lab.discover();
  const id = h.store.trials()[0]!.id;
  await h.lab.step(id);
  const original = h.store.trials()[0]!;
  h.store.close();
  const next = fixture(path);
  try {
    await next.lab.discover();
    assert.equal(next.store.trials().length, 1);
    await next.lab.step(id);
    assert.deepEqual(next.store.trials()[0]!.entry, original.entry);
    assert.equal(next.store.trials()[0]!.status, "OPEN");
  } finally {
    next.store.close();
  }
});

test("fresh security, mint, M1 history and flow run directly without BOT API; reject stops model", async () => {
  const previous = globalThis.fetch;
  let critical = false;
  const requests: string[] = [];
  const base = Buffer.alloc(82);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1000000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    base,
  );
  globalThis.fetch = async (u, init) => {
    const url = new URL(String(u));
    requests.push(url.pathname);
    assert(!url.pathname.startsWith("/api/"));
    if (url.pathname === "/rpc") {
      assert.equal(JSON.parse(String(init?.body)).method, "getAccountInfo");
      return Response.json({
        result: {
          value: {
            owner: TOKEN_PROGRAM_ID.toBase58(),
            data: [base.toString("base64"), "base64"],
            lamports: 1000000,
            executable: false,
            rentEpoch: 0,
          },
        },
      });
    }
    assert.equal(init?.method ?? "GET", "GET");
    let data: unknown;
    if (url.pathname.endsWith("/security"))
      data = {
        renounced_mint: true,
        renounced_freeze_account: true,
        is_honeypot: critical,
        rug_ratio: 0.1,
      };
    else if (url.pathname.endsWith("token_kline"))
      data = { list: bars().map((x) => ({ ...x, time: x.at, volume: 1000 })) };
    else if (url.pathname.endsWith("/rank")) {
      assert.equal(url.searchParams.get("limit"), "50");
      data = {
        rank: [
          {
            address: MINT,
            symbol: "NEW",
            creation_timestamp: Math.floor(Date.now() / 1000) - 3600,
            logo: "https://gmgn.ai/external-res/fixture.png",
          },
        ],
      };
    } else
      data = {
        decimals: 6,
        liquidity: 50000,
        creation_timestamp: Math.floor(Date.now() / 1000) - 3600,
        price: {
          price: 1,
          volume_1m: 300,
          buy_volume_1m: 200,
          sell_volume_1m: 100,
        },
      };
    return Response.json({ code: 0, data });
  };
  try {
    const market = new KronosMarket("fixture-only", "http://127.0.0.1/rpc");
    Object.defineProperty(market, "next", { get: () => 0, set: () => {} });
    const cs = await market.discover();
    assert.equal(cs[0]!.logo, "https://gmgn.ai/external-res/fixture.png");
    const h = fixture();
    const gates: string[] = [];
    const result = await market.prepare(cs[0]!, async (n, w) => {
      gates.push(n);
      return w();
    });
    assert.equal(result.candles.length, 40);
    assert.deepEqual(gates, [
      "CHEAP_FILTER",
      "SECURITY",
      "COMPATIBILITY",
      "HISTORY",
      "CAPITAL_FLOW",
    ]);
    critical = true;
    h.market.prepare = market.prepare.bind(market);
    await h.lab.discover();
    await h.lab.step(h.store.trials()[0]!.id);
    assert.equal(h.store.trials()[0]!.status, "REJECTED");
    assert.equal(h.calls(), 0);
    h.store.close();
    assert(requests.every((p) => !/jev|systemone|swap|trade|jupiter/.test(p)));
  } finally {
    globalThis.fetch = previous;
  }
});

test("worker env has no secrets or PATH forwarding; no JEV, BOT bridge or strategy additions", () => {
  const e = kronosWorkerEnvironment(join(ROOT, "runtime"));
  for (const k of Object.keys(e))
    assert(
      k === "PYTHONHASHSEED" ||
        !/PRIVATE|SECRET|API_KEY|WALLET|JEV|JUPITER|SOLANA|PATH$/.test(k),
    );
  assert.equal(e.HF_HUB_OFFLINE, "1");
  const files = readdirSync(join(ROOT, "src"));
  assert(
    !files.some((n) => /jev|store\.sqlite|structure-evidence|markup/.test(n)),
  );
  const workerSource = readFileSync(
    join(ROOT, "src", "kronos-worker.ts"),
    "utf8",
  );
  assert(
    !/from ["'].*(?:executor|execution-provider|live-config|solana)/.test(
      workerSource,
    ),
  );
  for (const n of files)
    assert(
      !/gmgn-sniper|api\.typesafe\.ai|\/api\/tokens|\/api\/kronos\/settings/.test(
        readFileSync(join(ROOT, "src", n), "utf8"),
      ),
    );
});

test("server starts without JEV/provider keys paused, local paths, no active loop or execution endpoints", async () => {
  const dir = directory();
  const cfg = runtimeConfig({
    KRONOS_PORT: String(47000 + Math.floor(Math.random() * 1000)),
    KRONOS_DATABASE_PATH: join(dir, "api.sqlite"),
    KRONOS_RUNTIME: join(dir, "runtime"),
    KRONOS_LOG_DIR: join(dir, "logs"),
  });
  const app = await startKronos(cfg);
  try {
    const base = `http://127.0.0.1:${cfg.port}`;
    const status = await fetch(base + "/api/status").then((r) => r.json());
    assert.equal(status.mode, "paper");
    assert.equal(status.sizing.positionSizePercent, 1);
    assert.equal(status.sizing.editable, false);
    assert.equal(status.sizing.basis, "SPENDABLE_SOL_AFTER_RESERVE");
    assert.equal(status.realExecutionEnabled, false);
    assert.deepEqual(status.wallet, {
      lamports: null,
      at: null,
      stale: true,
      state: "NOT_CONFIGURED",
    });
    const overview = await fetch(base + "/api/overview").then((r) => r.json());
    assert.deepEqual(overview.wallet, status.wallet);
    const data = await fetch(base + "/api/kronos").then((r) => r.json());
    assert.equal(data.enabled, false);
    assert.equal(data.summary.records, 0);
    assert.equal("limit" in data.summary, false);
    assert.equal(
      (await fetch(base + "/api/exit", { method: "POST" })).status,
      404,
    );
    assert.equal(
      (await fetch(base + "/api/kronos/control", { method: "POST" })).status,
      403,
    );
    assert.equal((await fetch(base + "/")).status, 200);
  } finally {
    await app.stop();
  }
});

test(
  "pinned real model produces old/new equivalent forecast and paper decisions on same fixed candles",
  { timeout: 90000 },
  async () => {
    const rows = bars(),
      at = Date.now();
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "lab/kronos/model-files.json"), "utf8"),
    );
    for (const file of manifest.files)
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(ROOT, "runtime", file.group, file.name)))
          .digest("hex"),
        file.sha256,
      );
    const worker = new KronosWorker(join(ROOT, "runtime"));
    try {
      const first = await worker.forecast(rows, at),
        second = await worker.forecast(rows, at);
      const normalize = (f: typeof first) => {
        const {
          loadMs: _load,
          latencyMs: _latency,
          rssBytes: _rss,
          ...rest
        } = f;
        return rest;
      };
      assert.deepEqual(normalize(first), normalize(second));
      writeFileSync(
        join(ROOT, "evidence/model-regression.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            candles: rows,
            first: normalize(first),
            second: normalize(second),
            equivalent: true,
            baselineWorkerIsCopiedUnchanged: true,
          },
          null,
          2,
        ),
      );
      assert.deepEqual(
        decideForecast(first, rows, false, at),
        oldDecide(first, rows, false, at),
      );
      const oldFixture = fixture(),
        newFixture = fixture();
      const oldLab = new OldLab(oldFixture.store, oldFixture.market, {
        forecast: async () => first,
        stop() {},
        status: () => ({}),
      });
      newFixture.inference.forecast = async () => first;
      await oldLab.discover();
      await newFixture.lab.discover();
      await oldLab.step(oldFixture.store.trials()[0]!.id);
      await newFixture.lab.step(newFixture.store.trials()[0]!.id);
      assert.equal(
        oldFixture.store.trials()[0]!.latest?.action,
        newFixture.store.trials()[0]!.latest?.action,
      );
      oldFixture.store.close();
      newFixture.store.close();
    } finally {
      worker.stop();
    }
  },
);
