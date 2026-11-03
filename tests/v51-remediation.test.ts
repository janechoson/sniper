import { setup, mockExecutionCase } from "./one-shot-fixtures.js";
import { qualifiedWatch } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Gmgn, normalizeSecurity } from "../src/gmgn.js";
import { GmgnCoordinator, GmgnRateLimited } from "../src/gmgn-coordinator.js";
import { GmgnProviderState } from "../src/gmgn-provider-state.js";
import { transportRetryDelay } from "../src/gmgn-rate-metadata.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { RiskEngine } from "../src/risk.js";
import { TradingMemory } from "../src/trading-memory.js";
import { Jev } from "../src/jev.js";
import { CandidateRejected, ProviderFailure } from "../src/domain.js";
import { env } from "../src/config.js";
import {
  settings,
  candidate,
  position,
  snapshot,
  securityRaw,
  info,
  MINT,
} from "./fixtures.js";
import { typedJevFixture } from "./learning-fixtures.js";

test("H1 endpoint critical wins; unknown retains current critical; newer safe endpoint supersedes bounded old listing", () => {
  const c = {
    ...candidate(),
    discoveredAt: Date.now() - 1000,
    listing: { rug_ratio: 0 },
  };
  const critical = normalizeSecurity(
    { ...securityRaw, rug_ratio: 0.99 },
    c,
    settings,
  );
  assert(critical.findings.some((f) => f.level === "CRITICAL"));
  const bad = { ...c, listing: { rug_ratio: 0.99 } };
  assert(
    normalizeSecurity(
      { ...securityRaw, rug_ratio: null },
      bad,
      settings,
    ).findings.some((f) => f.code === "GMGN_RUG_RISK"),
  );
  assert(
    !normalizeSecurity(
      { ...securityRaw, rug_ratio: 0 },
      bad,
      settings,
    ).findings.some((f) => f.code === "GMGN_RUG_RISK"),
  );
  const expired = {
    ...bad,
    discovery: undefined,
    discoveredAt: Date.now() - settings.maxSnapshotAgeMs - 1,
  };
  assert.equal(
    normalizeSecurity({ ...securityRaw, rug_ratio: null }, expired, settings)
      .rugRatio.state,
    "UNKNOWN",
  );
  const snap = snapshot();
  snap.security = critical;
  assert.equal(
    new RiskEngine().evaluate(snap, settings, {
      balance: 1000000000n,
      pending: 0n,
      positions: 0,
      duplicate: false,
      entriesEnabled: true,
    }).allowed,
    false,
  );
});

test("H2 stale safe holder cannot approve, final fresh holders block, provider cooldown propagates without signing", async () => {
  let unsafe = false,
    unavailable = false,
    holderCalls = 0;
  const g = new Gmgn(async (args) => {
    if (args[1] === "holders") {
      holderCalls++;
      if (unavailable) throw new GmgnRateLimited(120000);
      return {
        list: [
          {
            address: "fixture-holder",
            addr_type: 0,
            amount_percentage: unsafe ? 0.9 : 0.01,
          },
        ],
      };
    }
    return {};
  });
  const c = candidate(),
    sec = normalizeSecurity(securityRaw, c, settings);
  const first = await g.intelligence(c, info(), sec, settings, true);
  const snap = snapshot();
  snap.intelligence = structuredClone(first);
  snap.intelligence.riskEvidence!.fetchedAt = Date.now() - 61000;
  const context = {
    balance: 1000000000n,
    pending: 0n,
    positions: 0,
    duplicate: false,
    entriesEnabled: true,
  };
  assert.equal(
    new RiskEngine().evaluate(snap, settings, context).allowed,
    false,
  );
  unsafe = true;
  snap.intelligence = await g.intelligence(c, info(), sec, settings, true);
  assert.match(
    new RiskEngine().evaluate(snap, settings, context).reason,
    /concentration/,
  );
  unavailable = true;
  await assert.rejects(
    g.intelligence(c, info(), sec, settings, true),
    GmgnRateLimited,
  );
  assert.equal(holderCalls, 3);
  await g.coordinator.stop();
});

test("H2 final one-shot analysis refetches holders and blocks new dangerous concentration", async () => {
  const f = mockExecutionCase();
  const original = f.e.gmgn.intelligence.bind(f.e.gmgn);
  let calls = 0;
  f.e.gmgn.intelligence = async (...args) => {
    const i = await original(...args);
    if (++calls > 1) i.holders.top1 = { state: "KNOWN", value: 90 };
    return i;
  };
  try {
    await assert.rejects(f.e.analyze(MINT));
    assert.equal(f.stats().signed, 0);
    assert.equal(f.e.attempts.current!.failedStage, "FINAL_ANALYSIS");
  } finally {
    await f.close();
  }
});

test("H3 actual CLI HTTP response through preload and adapter honors Retry-After and reset", async () => {
  const originalFetch = globalThis.fetch,
    write = process.stderr.write;
  let now = Date.now(),
    output = "";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 1,
        error: "RATE_LIMIT_EXCEEDED",
        message: "Rate limited",
      }),
      {
        status: 429,
        headers: {
          "Retry-After": "120",
          "x-ratelimit-reset": String(Math.ceil(now / 1000) + 150),
        },
      },
    );
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await import("../src/gmgn-fetch-metadata.js");
    const module = await import(
      pathToFileURL(
        resolve("node_modules/gmgn-cli/dist/client/OpenApiClient.js"),
      ).href
    );
    const cli = new module.OpenApiClient({
      apiKey: "fixture-only",
      privateKeyPem: "",
      host: "https://fixture.invalid",
    });
    await assert.rejects(cli.getTokenInfo("sol", MINT));
    assert(!output.includes("fixture-only"));
    const delay = transportRetryDelay(output, now)!;
    assert(delay >= 150000);
    const c = new GmgnCoordinator(
      () => ({
        intervalMs: 0,
        baseBackoffMs: 100,
        maxBackoffMs: 1000,
        maxQueue: 200,
      }),
      () => now,
      async (ms) => {
        now += ms;
      },
      () => 0,
    );
    await assert.rejects(
      c.read("rate", 0, async () => {
        throw new GmgnRateLimited(delay);
      }),
    );
    assert(c.status().cooldownUntil >= now + 150000);
    let calls = 0;
    await Promise.allSettled(
      Array.from({ length: 50 }, (_, n) =>
        c.read(String(n), 0, async () => {
          calls++;
          return {};
        }),
      ),
    );
    assert.equal(calls, 0);
    assert.equal(
      transportRetryDelay(
        'GMGN_RATE_METADATA:{"status":429,"retryAfter":"120"}',
        now,
      ),
      120000,
    );
    assert.equal(
      transportRetryDelay('GMGN_RATE_METADATA:{"status":429}', now),
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = write;
  }
});

test("M2 independent stores and a reopened store preserve the longest authoritative cooldown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gmgn-v51-")),
    path = join(dir, "provider.sqlite");
  const a = new GmgnProviderState(path),
    b = new GmgnProviderState(path);
  let now = 1000,
    calls = 0;
  const policy = () => ({
    intervalMs: 0,
    baseBackoffMs: 1000,
    maxBackoffMs: 5000,
    maxQueue: 200,
  });
  const ca = new GmgnCoordinator(
    policy,
    () => now,
    async () => {},
    () => 0,
    a,
  );
  const cb = new GmgnCoordinator(
    policy,
    () => now,
    async () => {},
    () => 0,
    b,
  );
  try {
    await assert.rejects(
      ca.read("a", 0, async () => {
        throw new GmgnRateLimited(120000);
      }),
    );
    await assert.rejects(
      cb.read("b", 0, async () => {
        calls++;
        return {};
      }),
    );
    assert.equal(calls, 0);
    const reopened = new GmgnProviderState(path);
    try {
      const cc = new GmgnCoordinator(
        policy,
        () => now,
        async () => {},
        () => 0,
        reopened,
      );
      assert.equal(cc.cooling, true);
      reopened.extend(2000, now);
      assert.equal(reopened.read(), 121000);
      now = 121001;
      assert.equal(cc.cooling, false);
    } finally {
      reopened.close();
    }
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true });
  }
});

test("M1 owned PASSED Sniper error stays POSITION, quantity and BOUGHT survive even without supplied position context", async () => {
  const db = new Store(":memory:"),
    g = new Gmgn(async () => ({})),
    e = new Engine(db, { gmgn: g });
  try {
    const c = candidate();
    db.discover(c);
    e.candidates.refill([c]);
    const structure = e.structure.observe(c)!;
    structure.status = "PASSED";
    structure.phase = "ENTRY_ELIGIBLE";
    db.db
      .prepare("UPDATE sniper_structure_watch SET payload=? WHERE mint=?")
      .run(JSON.stringify(structure), MINT);
    const p = { ...position(), mode: "paper" as const };
    db.savePosition(p);
    e.candidates.setState(MINT, "BOUGHT");
    await (
      e as unknown as {
        isolate(error: unknown, mint: string, stage: string): Promise<boolean>;
      }
    ).isolate(
      new CandidateRejected("TOKEN_DATA_INCOMPLETE"),
      MINT,
      "POSITION_MONITOR",
    );
    const after = db.positions("paper")[0]!;
    assert.equal(after.quantity, p.quantity);
    assert.equal(after.state, "OPEN");
    assert.equal(after.monitoring?.status, "DEGRADED");
    assert(after.monitoring!.nextCheckAt! > Date.now());
    assert.equal(e.candidates.get(MINT)?.state, "BOUGHT");
  } finally {
    await e.stop();
    db.close();
  }
});

test("legacy Watch observation cannot consume shared feed or start background candidate reads", async () => {
  const f = setup();
  try {
    f.engine.structure.admit(f.store.token(MINT)!, {
      authorityRevision: 0,
      snapshotHash: "old",
    });
    const before = JSON.stringify(f.engine.structure.get(MINT));
    await f.engine.observeStructureWatches();
    await f.engine.observeStructureWatches();
    assert.equal(f.p.calls.length, 0);
    assert.equal(JSON.stringify(f.engine.structure.get(MINT)), before);
    assert.equal(f.engine.candidates.list().length, 0);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test("removed Watch observer performs no provider calls and cannot manufacture an authorization incident", async () => {
  const db = new Store(":memory:");
  let calls = 0;
  const g = new Gmgn(async () => {
    calls++;
    throw new ProviderFailure("GMGN_AUTHORIZATION_FAILED", "GMGN", false);
  });
  const e = new Engine(db, { gmgn: g });
  try {
    qualifiedWatch(e, candidate(), false);
    await e.observeStructureWatches();
    assert.equal(calls, 0);
    assert.equal(db.get("haltReason"), undefined);
  } finally {
    await e.stop();
    db.close();
  }
});

test("H5 FINAL Jev provider body keeps bounded V5 context and explicit timestamps", async () => {
  const old = env.TYPESAFE_API_KEY;
  env.TYPESAFE_API_KEY = "fixture-only";
  const db = new Store(":memory:"),
    memory = new TradingMemory(db),
    j = new Jev();
  try {
    const snap = snapshot();
    const context = memory.jevContext(
      {
        market: snap.market,
        security: snap.security,
        discovery: { sources: ["SNIPER", "TRENDING"] },
        entryDiscoverySource: "TRENDING",
        sniperStructureAtEntry: {
          phase: "SUPPORT_FORMING",
          observations: Array(1000).fill("excluded"),
          structureWatchExpiresAt: Date.now() + 10000,
        },
        capitalFlow: {
          regime: "STRONG_INFLOW",
          at: Date.now(),
          features: { buyPressure: 0.6 },
        },
        gmgnQuality: {
          freshness: "STALE_USABLE",
          fetchedAt: Date.now() - 10000,
        },
      },
      memory.retrieve(snap, "paper"),
    );
    let body: { state?: { currentToken: Record<string, unknown> } } = {};
    j.http.request = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return typedJevFixture("SKIP", "UNAVAILABLE", "NONE");
    };
    await j.decide(context, true);
    const token = body.state!.currentToken;
    for (const key of [
      "discovery",
      "entryDiscoverySource",
      "sniperStructureAtEntry",
      "capitalFlow",
      "gmgnQuality",
      "marketObservedAt",
      "flowObservedAt",
    ])
      assert.notEqual(token[key], undefined, key);
    assert(!JSON.stringify(body).includes("excluded"));
    assert.equal(token.entryDiscoverySource, "TRENDING");
  } finally {
    env.TYPESAFE_API_KEY = old;
    db.close();
  }
});
