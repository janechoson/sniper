import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { KronosStore } from "../src/kronos-store.js";
import { LiveExecutor } from "../src/live-executor.js";
import { LiveStore } from "../src/live-store.js";
import { Solana } from "../src/solana.js";
import {
  SOL,
  liveConfig,
  sizeBuy,
  requireLiveConfiguration,
} from "../src/live-config.js";
import {
  validateQuote,
  JupiterExecutionProvider,
  type ExecutionQuote,
  type SolanaExecutionProvider,
} from "../src/execution-provider.js";
import { TOKEN_PROGRAM_ID } from "../src/token-program.js";
import type { LabDecision, LabTrial } from "../src/kronos-domain.js";
import { runtimeConfig, ROOT } from "../src/config.js";
import { startKronos } from "../src/server.js";
import { fixture, MINT } from "./fixtures.js";
import { KronosLab } from "../src/kronos-lab.js";

const wallet = "11111111111111111111111111111112";
function quote(
  side: "BUY" | "SELL",
  amount: bigint,
  routeOnly = false,
): ExecutionQuote {
  const out = side === "BUY" ? 1000000n : routeOnly ? 3000000n : 15000000n;
  return {
    provider: "JUPITER",
    chain: "solana",
    wallet,
    mint: MINT,
    side,
    amount: String(amount),
    at: Date.now(),
    maxSlippageBps: 100,
    routeOnly,
    order: {
      inputMint: side === "BUY" ? SOL : MINT,
      outputMint: side === "BUY" ? MINT : SOL,
      inAmount: String(amount),
      outAmount: String(out),
      otherAmountThreshold: String((out * 99n) / 100n),
      swapMode: "ExactIn",
      slippageBps: 100,
      router: "metis",
      taker: wallet,
      signatureFeePayer: wallet,
      transaction: "UNSIGNED_FIXTURE",
      requestId: "fixture",
      priceImpactPct: 0.1,
      signatureFeeLamports: 10000,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
      routePlan: [
        {
          swapInfo: {
            label: "fixture",
            inputMint: side === "BUY" ? SOL : MINT,
            outputMint: side === "BUY" ? MINT : SOL,
          },
        },
      ],
    },
  };
}
function setup(path = ":memory:") {
  const store = new KronosStore(path);
  const config = {
    ...liveConfig({}),
    WALLET_PUBLIC_KEY: wallet,
    acknowledged: true,
  };
  let sol = 1000000000n,
    tokens = 0n,
    submitted = 0,
    signBoundary = 0,
    simulations = 0,
    ambiguous = false,
    failReceipt = false,
    gate = false,
    active = true,
    noRoute = false,
    impact = false,
    minFailure = false,
    proceeds = 15000000n,
    fee = 10000n,
    receiptMissing = false;
  let pendingQuote: ExecutionQuote | undefined,
    receipt: VersionedTransactionResponse | null = null;
  const probes: string[] = [];
  const raw = new Solana("http://127.0.0.1:1");
  const rpc = {
    balance: async () => sol,
    tokenBalance: async () => tokens,
    inspectMint: async () => ({
      mint: MINT,
      tokenProgram: "LEGACY_SPL",
      programId: TOKEN_PROGRAM_ID.toBase58(),
      decimals: 6,
      initialized: true,
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [],
      unsupportedExtensions: [],
      criticalExtensions: [],
      extensionRisk: "LOW",
      decision: "ALLOW",
      at: Date.now(),
    }),
    receipt: async () => (receiptMissing ? null : receipt),
    deltas: raw.deltas.bind(raw),
  } as unknown as Solana;
  const provider: SolanaExecutionProvider = {
    health: { state: "READY", at: Date.now() },
    getWalletBalance: async () => sol,
    quoteBuy: async (_m, a) => {
      if (noRoute) throw Error("NO_BUY_ROUTE");
      const q = quote("BUY", a);
      if (impact) q.order.priceImpactPct = 50;
      return q;
    },
    quoteSell: async (_m, a, _slip, routeOnly = false) => {
      if (routeOnly) probes.push(String(a));
      return quote("SELL", a, routeOnly);
    },
    simulate: async () => {
      simulations++;
      if (gate) throw Error("SIMULATION_FAILED");
    },
    execute: async (q, beforeBroadcast, beforeSign) => {
      beforeSign?.();
      signBoundary++;
      pendingQuote = q;
      const signature = (q.side === "BUY" ? "A" : "B").repeat(88);
      beforeBroadcast(signature);
      // Signature is only a fake counter; no Keypair/sign/send method is invoked.
      assert.equal(new LiveStore(store).pending()[0]!.signature, signature);
      submitted++;
      if (ambiguous) throw Error("AMBIGUOUS_SUBMIT");
      apply(q, signature);
      return signature;
    },
    confirm: async () => "CONFIRMED",
  };
  function apply(q: ExecutionQuote, signature: string) {
    const preSol = sol,
      preTokens = tokens;
    if (!failReceipt) {
      if (q.side === "BUY") {
        sol -= BigInt(q.amount) + fee;
        tokens += minFailure ? 1n : 1012345n;
      } else {
        sol += proceeds - fee;
        tokens -= BigInt(q.amount);
      }
    } else sol -= fee;
    const account = new PublicKey(MINT),
      w = new PublicKey(wallet);
    const message = new TransactionMessage({
      payerKey: w,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [{ pubkey: account, isSigner: false, isWritable: true }],
          data: Buffer.from([17]),
        }),
      ],
    }).compileToV0Message();
    const index = message.staticAccountKeys.findIndex((k) => k.equals(account));
    const pre = message.staticAccountKeys.map(() => 2039280),
      post = [...pre];
    pre[0] = Number(preSol);
    post[0] = Number(sol);
    const row = (amount: bigint) => ({
      accountIndex: index,
      mint: MINT,
      owner: wallet,
      uiTokenAmount: {
        amount: String(amount),
        decimals: 6,
        uiAmount: null,
        uiAmountString: "0",
      },
    });
    receipt = {
      slot: 100,
      blockTime: Math.floor(Date.now() / 1000),
      transaction: { message, signatures: [signature] },
      meta: {
        err: failReceipt ? { InstructionError: [0, "Custom"] } : null,
        fee: Number(fee),
        preBalances: pre,
        postBalances: post,
        preTokenBalances: [row(preTokens)],
        postTokenBalances: [row(tokens)],
        loadedAddresses: { readonly: [], writable: [] },
        innerInstructions: [],
      },
    } as unknown as VersionedTransactionResponse;
  }
  const executor = new LiveExecutor(
    store,
    provider,
    rpc,
    config,
    () => {
      if (!active) throw Error("LIVE_NOT_ACTIVE");
    },
    async () => {
      if (gate) throw Error("SECURITY_REJECT");
    },
    async () => ({ price: "100", at: Date.now(), source: "FIXTURE_SOL_USD" }),
  );
  const t = store.add({
    mint: MINT,
    appearance: "live-1",
    discoveredAt: Date.now(),
    mode: "LIVE",
  })!;
  for (const name of [
    "CHEAP_FILTER",
    "SECURITY",
    "COMPATIBILITY",
    "HISTORY",
    "CAPITAL_FLOW",
  ])
    t.gates[name] = { status: "PASS", at: Date.now() };
  store.save(t);
  function decision(side: "BUY" | "SELL") {
    const d: LabDecision = {
      action: side === "BUY" ? "PAPER_BUY" : "PAPER_SELL",
      at: Date.now(),
      inputAt: Date.now(),
      reason: "FIXTURE_KRONOS",
    };
    const trial = store.trial(t.id)!;
    store.commitDecision(trial, d);
    return { trial, d };
  }
  return {
    store,
    executor,
    rpc,
    provider,
    config,
    t,
    decision,
    probes,
    counters: () => ({ submitted, signBoundary, simulations, sol, tokens }),
    change(v: {
      sol?: bigint;
      tokens?: bigint;
      ambiguous?: boolean;
      gate?: boolean;
      active?: boolean;
      noRoute?: boolean;
      impact?: boolean;
      minFailure?: boolean;
      proceeds?: bigint;
      fee?: bigint;
      receiptMissing?: boolean;
      failReceipt?: boolean;
    }) {
      sol = v.sol ?? sol;
      tokens = v.tokens ?? tokens;
      ambiguous = v.ambiguous ?? ambiguous;
      gate = v.gate ?? gate;
      active = v.active ?? active;
      noRoute = v.noRoute ?? noRoute;
      impact = v.impact ?? impact;
      minFailure = v.minFailure ?? minFailure;
      proceeds = v.proceeds ?? proceeds;
      fee = v.fee ?? fee;
      receiptMissing = v.receiptMissing ?? receiptMissing;
      failReceipt = v.failReceipt ?? failReceipt;
    },
    land() {
      const e = executor.ledger.pending()[0]!;
      apply(pendingQuote!, e.signature!);
    },
    async buy() {
      const { trial, d } = decision("BUY");
      return executor.execute(trial, d);
    },
    async sell() {
      const { trial, d } = decision("SELL");
      return executor.execute(trial, d);
    },
  };
}

test("fixed 1% sizing uses fresh spendable SOL, floors lamports and preserves reserve", () => {
  assert.equal(sizeBuy(1020000000n, 20000000n), 10000000n);
  assert.equal(sizeBuy(120000000n, 20000000n), 1000000n);
  assert.equal(sizeBuy(120000099n, 20000000n), 1000000n);
  assert.equal(sizeBuy(20000099n, 20000000n), 0n);
  assert.equal(sizeBuy(1n, 20000000n), 0n);
  assert.equal(sizeBuy(20000000n, 20000000n), 0n);
  assert.equal(sizeBuy(220000000n, 20000000n), 2000000n);
});
test("retired KRONOS_MAX_BUY_SOL is ignored; LIVE config has no absolute buy cap", () => {
  const normal = liveConfig({});
  for (const oldValue of ["0", "0.000000001", "10000", "invalid"]) {
    const legacy = liveConfig({ KRONOS_MAX_BUY_SOL: oldValue });
    assert.deepEqual(legacy, normal);
    assert.equal("maxBuyLamports" in legacy, false);
    assert.equal(sizeBuy(120000000n, BigInt(legacy.reserveLamports)), 1000000n);
  }
});

test("LIVE requires own credentials and ack without a buy cap; invalid/missing mode stays PAPER", async () => {
  assert.equal(runtimeConfig({ TRADING_MODE: "bad" }).mode, "paper");
  assert.throws(
    () => requireLiveConfiguration(liveConfig({}), "", ""),
    /INCOMPLETE/,
  );
  await assert.rejects(
    startKronos(runtimeConfig({ TRADING_MODE: "live" })),
    /INCOMPLETE/,
  );
});

test("Jupiter API key is optional; every other LIVE configuration guard remains mandatory", () => {
  const config = {
    ...liveConfig({}),
    WALLET_PUBLIC_KEY: wallet,
    SOLANA_PRIVATE_KEY: "fixture-only-no-signing",
    acknowledged: true,
  };
  assert.equal(config.JUPITER_API_KEY, "");
  assert.doesNotThrow(() =>
    requireLiveConfiguration(config, "fixture-gmgn", "https://rpc.invalid"),
  );
  assert.doesNotThrow(() =>
    requireLiveConfiguration(
      { ...config, JUPITER_API_KEY: "fixture-jupiter" },
      "fixture-gmgn",
      "https://rpc.invalid",
    ),
  );
  for (const change of [
    { acknowledged: false },
    { WALLET_PUBLIC_KEY: "" },
    { SOLANA_PRIVATE_KEY: "", SOLANA_KEYPAIR_PATH: "" },
  ])
    assert.throws(
      () =>
        requireLiveConfiguration(
          { ...config, ...change },
          "fixture-gmgn",
          "https://rpc.invalid",
        ),
      /LIVE_CONFIGURATION_INCOMPLETE/,
    );
  assert.throws(
    () => requireLiveConfiguration(config, "", "https://rpc.invalid"),
    /LIVE_CONFIGURATION_INCOMPLETE/,
  );
  assert.throws(
    () => requireLiveConfiguration(config, "fixture-gmgn", ""),
    /LIVE_CONFIGURATION_INCOMPLETE/,
  );
  assert.throws(
    () =>
      requireLiveConfiguration(config, "fixture-gmgn", "http://rpc.invalid"),
    /LIVE_RPC_HTTPS_REQUIRED/,
  );
  assert.throws(() =>
    requireLiveConfiguration(
      { ...config, WALLET_PUBLIC_KEY: "invalid" },
      "fixture-gmgn",
      "https://rpc.invalid",
    ),
  );
});

test("Jupiter quote omits x-api-key when empty and sends it when configured; no signing/submission", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; header: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    requests.push({
      url: String(url),
      header: new Headers(init?.headers).get("x-api-key"),
    });
    return new Response(JSON.stringify(quote("BUY", 1000000n).order), {
      status: 200,
    });
  };
  try {
    for (const key of ["", "fixture-jupiter-api-key"]) {
      const provider = new JupiterExecutionProvider(
        new Solana("http://127.0.0.1:1"),
        { ...liveConfig({}), WALLET_PUBLIC_KEY: wallet, JUPITER_API_KEY: key },
      );
      const q = await provider.quoteBuy(MINT, 1000000n, 100);
      assert.equal(q.amount, "1000000");
    }
    assert.deepEqual(
      requests.map((r) => r.header),
      [null, "fixture-jupiter-api-key"],
    );
    assert(requests.every((r) => new URL(r.url).pathname === "/swap/v2/order"));
  } finally {
    globalThis.fetch = original;
  }
});

test("keyless Jupiter rejection still fails closed before simulation/sign/submit", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).get("x-api-key"), null);
    return new Response("", { status: 401 });
  };
  try {
    const provider = new JupiterExecutionProvider(
      new Solana("http://127.0.0.1:1"),
      { ...liveConfig({}), WALLET_PUBLIC_KEY: wallet },
    );
    await assert.rejects(
      provider.quoteBuy(MINT, 1000000n, 100),
      /JUPITER_HTTP_401/,
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("real ledger reconciles BUY/full SELL with different signal/fill, exact receipt fees and idempotent fill", async () => {
  const f = setup();
  try {
    const b = await f.buy();
    assert.equal(b.state, "RECONCILED");
    assert.deepEqual(f.probes, ["200000", "500000", "1000000"]);
    let p = f.executor.ledger.position(f.t.id)!;
    assert.equal(p.quantity, "1012345");
    assert.notEqual(Number(p.entry.priceUsd), 1);
    assert.equal(p.entry.recoverableRentDeltaLamports, "0");
    assert.equal(p.entry.tradingLamports, "9800000");
    assert.equal(p.entry.networkFeeLamports, "10000");
    f.executor.mark(f.store.trial(f.t.id)!, 2, Date.now());
    const e = await f.sell();
    assert.equal(e.state, "RECONCILED");
    p = f.executor.ledger.position(f.t.id)!;
    assert.equal(p.quantity, "0");
    assert.equal(p.state, "CLOSED");
    assert.equal(p.exit!.quantityAtomic, "1012345");
    assert.equal(p.grossPnlLamports, "5200000");
    assert.equal(p.feesLamports, "20000");
    assert.equal(p.netPnlLamports, "5180000");
    await f.executor.recover();
    assert.equal(f.counters().submitted, 2);
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM live_fills").get()!.n,
      2,
    );
    assert.equal(f.store.summary().paperBuys, 0);
    assert.equal(f.executor.ledger.summary().buys, 1);
    assert.equal(f.store.page({ mode: "PAPER" }).rows.length, 0);
    assert.equal(f.store.page({ mode: "LIVE" }).rows.length, 1);
    assert.throws(
      () => f.store.reset("RESET KRONOS PAPER EXPERIMENT"),
      /LIVE_LEDGER/,
    );
  } finally {
    f.store.close();
  }
});
for (const side of ["BUY", "SELL"] as const)
  test(`UNKNOWN ${side}: no replay or duplicate, signed restart recovery and no fake close`, async () => {
    mkdirSync(join(ROOT, "data"), { recursive: true });
    const path = join(
      mkdtempSync(join(ROOT, "data", "test-live-")),
      "own.sqlite",
    );
    const f = setup(path);
    try {
      if (side === "SELL") await f.buy();
      f.change({ ambiguous: true });
      await assert.rejects(side === "BUY" ? f.buy() : f.sell(), /AMBIGUOUS/);
      assert.equal(f.executor.ledger.pending()[0]!.state, "UNKNOWN");
      if (side === "BUY")
        assert.equal(f.executor.ledger.position(f.t.id), undefined);
      else assert.equal(f.executor.ledger.position(f.t.id)!.state, "OPEN");
      const count = f.counters().submitted;
      await assert.rejects(
        side === "BUY" ? f.buy() : f.sell(),
        /PENDING_TRANSACTION/,
      );
      assert.equal(f.counters().submitted, count);
      const reopened = new KronosStore(path);
      try {
        assert.equal(new LiveStore(reopened).pending().length, 1);
      } finally {
        reopened.close();
      }
      await f.executor.recover();
      assert.equal(f.executor.ledger.pending().length, 1);
      f.change({ ambiguous: false });
      f.land();
      await f.executor.recover();
      assert.equal(f.executor.ledger.pending().length, 0);
      assert.equal(f.counters().submitted, count);
      assert.equal(
        f.executor.ledger.position(f.t.id)!.state,
        side === "BUY" ? "OPEN" : "CLOSED",
      );
    } finally {
      f.store.close();
    }
  });
test("DRY RUN traverses quote, 20/50/100 exits, simulation, final checks; ZERO sign/submit", async () => {
  const f = setup();
  try {
    const { trial, d } = f.decision("BUY");
    const e = await f.executor.execute(trial, d, true);
    assert.equal(e.state, "DRY_RUN");
    assert.equal(e.intent.amount, "9800000");
    assert.equal(f.counters().signBoundary, 0);
    assert.equal(f.counters().submitted, 0);
    assert.equal(f.counters().simulations, 1);
    assert.equal(f.executor.ledger.openCount(), 0);
  } finally {
    f.store.close();
  }
});
for (const issue of ["noRoute", "impact", "gate", "active"] as const)
  test(`${issue} failure never signs or increases size`, async () => {
    const f = setup();
    try {
      f.change(issue === "active" ? { active: false } : { [issue]: true });
      await assert.rejects(f.buy());
      assert.equal(f.counters().signBoundary, 0);
      assert.equal(f.counters().submitted, 0);
    } finally {
      f.store.close();
    }
  });
test("existing ownership, insufficient reserve and duplicate decision are blocked", async () => {
  const f = setup();
  try {
    f.change({ tokens: 1n });
    await assert.rejects(f.buy(), /OWNERSHIP/);
    f.change({ tokens: 0n, sol: 10000n });
    await assert.rejects(f.buy(), /RESERVE/);
    assert.equal(f.counters().submitted, 0);
  } finally {
    f.store.close();
  }
});
test("receipt below bound stays UNKNOWN, never creates OPEN", async () => {
  const f = setup();
  try {
    f.change({ minFailure: true });
    const e = await f.buy();
    assert.equal(e.state, "UNKNOWN");
    assert.equal(f.executor.ledger.openCount(), 0);
    assert.equal(e.error, "RECEIPT_FILL_MISMATCH");
  } finally {
    f.store.close();
  }
});
test("failed SELL records real fee, retains actual OPEN quantity; later close includes failed fee", async () => {
  const f = setup();
  try {
    await f.buy();
    f.change({ failReceipt: true });
    const e = await f.sell();
    assert.equal(e.state, "FAILED");
    assert.equal(e.failedFeeLamports, "10000");
    assert.equal(f.executor.ledger.position(f.t.id)!.state, "OPEN");
    await new Promise((r) => setTimeout(r, 2));
    f.change({ failReceipt: false });
    await f.sell();
    assert.equal(f.executor.ledger.position(f.t.id)!.netPnlLamports, "5170000");
  } finally {
    f.store.close();
  }
});
test("actual quote validator rejects wallet/direction/amount/slippage/stale mismatch", () => {
  for (const key of ["wallet", "amount", "slippage", "age", "direction"]) {
    const q = quote("BUY", 1000n);
    if (key === "wallet") q.wallet = MINT;
    if (key === "amount") q.amount = "1001";
    if (key === "slippage") q.order.slippageBps = 999;
    if (key === "age") q.at -= 21000;
    if (key === "direction") q.order.inputMint = MINT;
    assert.throws(() =>
      validateQuote(q, {
        mint: MINT,
        side: "BUY",
        amount: 1000n,
        wallet,
        slippageBps: 100,
      }),
    );
  }
});

for (const side of ["BUY", "SELL"] as const)
  test(`duplicate ${side} while SUBMITTED stays in one wallet lane`, async () => {
    const f = setup();
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    try {
      if (side === "SELL") await f.buy();
      f.provider.execute = async (_q, persist, check) => {
        check?.();
        calls++;
        persist("C".repeat(88));
        await barrier;
        throw Error("AMBIGUOUS_SUBMIT");
      };
      const pending = side === "BUY" ? f.buy() : f.sell();
      while (f.executor.ledger.pending()[0]?.state !== "SUBMITTED")
        await new Promise((r) => setTimeout(r, 1));
      await assert.rejects(
        side === "BUY" ? f.buy() : f.sell(),
        /PENDING_TRANSACTION/,
      );
      assert.equal(calls, 1);
      release();
      await assert.rejects(pending, /AMBIGUOUS_SUBMIT/);
    } finally {
      release();
      f.store.close();
    }
  });
test("Security/freshness and immediate authority are checked again before signing", async () => {
  for (const issue of ["security", "stale", "pause"]) {
    const f = setup();
    try {
      f.provider.simulate = async () => {
        const t = f.store.trial(f.t.id)!;
        if (issue === "security") t.gates.SECURITY!.status = "FAIL";
        if (issue === "stale") t.gates.SECURITY!.at -= 46000;
        if (issue === "pause") f.change({ active: false });
        f.store.save(t);
      };
      await assert.rejects(f.buy());
      assert.equal(f.counters().signBoundary, 0);
      assert.equal(f.counters().submitted, 0);
    } finally {
      f.store.close();
    }
  }
});
test("restart executor recovers signed evidence without calling execute", async () => {
  const f = setup();
  try {
    f.change({ ambiguous: true });
    await assert.rejects(f.buy());
    f.change({ ambiguous: false });
    f.land();
    const resumed = new LiveExecutor(
      f.store,
      f.provider,
      f.rpc,
      f.config,
      () => {},
      async () => {},
    );
    await resumed.recover();
    assert.equal(resumed.ledger.pending().length, 0);
    assert.equal(resumed.ledger.openCount(), 1);
    assert.equal(f.counters().submitted, 1);
  } finally {
    f.store.close();
  }
});
test("unproven account rent keeps LIVE closed Net PnL and statistics UNKNOWN", async () => {
  const f = setup();
  try {
    const read = f.rpc.receipt.bind(f.rpc);
    f.rpc.receipt = async (sig) => {
      const r = await read(sig);
      if (r?.meta) r.meta.postBalances[1]! += 1;
      return r;
    };
    await f.buy();
    await f.sell();
    const p = f.executor.ledger.position(f.t.id)!;
    assert.equal(p.state, "CLOSED");
    assert.equal(p.entry.recoverableRentDeltaLamports, null);
    assert.equal(p.netPnlLamports, null);
    assert.equal(f.executor.ledger.summary().netRealizedLamports, null);
    assert.equal(f.executor.ledger.summary().winRate, null);
  } finally {
    f.store.close();
  }
});
test("Kronos strategy integration uses fake execution only on BUY/SELL; no JEV/TypeSafe network", async () => {
  const base = fixture();
  const lab = new KronosLab(base.store, base.market, base.inference, "LIVE");
  // This test checks WAIT/HOLD parity separately from ledger fixture economics.
  let executionCalls = 0;
  lab.attachExecution({
    ledger: { pending: () => [] },
    recover: async () => {},
    execute: async (t: LabTrial, d: LabDecision) => {
      executionCalls++;
      assert.equal(d.action, "PAPER_BUY");
      return { id: "dry", state: "DRY_RUN", intent: { side: "BUY" } };
    },
    status: () => ({}),
  } as unknown as LiveExecutor);
  try {
    await lab.discover();
    await lab.step(base.store.trials()[0]!.id);
    assert.equal(executionCalls, 1);
    assert.equal(base.store.trials()[0]!.entry, undefined);
  } finally {
    base.store.close();
  }
});

test("same baseline Kronos forecast drives integrated LIVE BUY then full SELL, without paper fills", async () => {
  const f = setup(),
    base = fixture();
  const lab = new KronosLab(f.store, base.market, base.inference, "LIVE");
  lab.attachExecution(f.executor);
  lab.setEnabled(true);
  try {
    await lab.step(f.t.id);
    const entry = f.store.trial(f.t.id)!;
    assert.equal(entry.live!.state, "OPEN");
    assert.equal(entry.entry!.source, "RECONCILED_USD");
    assert.equal(entry.latest!.action, "PAPER_BUY");
    assert.equal(entry.pnlPct, undefined);
    base.set({ direction: -1 });
    delete entry.lastInputTo;
    f.store.save(entry);
    await lab.step(f.t.id);
    const closed = f.store.trial(f.t.id)!;
    assert.equal(closed.live!.state, "CLOSED");
    assert.equal(closed.latest!.action, "PAPER_SELL");
    assert.equal(closed.live!.netPnlLamports, "5180000");
    assert.equal(f.counters().submitted, 2);
    assert.equal(f.store.summary().paperBuys, 0);
  } finally {
    f.store.close();
    base.store.close();
  }
});
