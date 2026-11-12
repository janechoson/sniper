import { env } from "../src/config.js";
import { CandidateRejected } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import type { SolanaExecutionProvider } from "../src/execution-provider.js";
import type { KronosDecisionStrategy } from "../src/kronos-strategy.js";
import { Solana } from "../src/solana.js";
import { Store } from "../src/store.js";
import {
  candidate,
  info,
  MINT,
  position,
  provider,
  quote,
  securityRaw,
  settings,
  WALLET,
  fixtureCodex,
} from "./fixtures.js";
import { fakeKronos, fixtureQuotes } from "./kronos-fixtures.js";
export const now = Math.floor(Date.now() / 60000) * 60000;
export function candles(minutes = 15) {
  const values = Array.from({ length: minutes }, () => ({
    open: 0.94,
    close: 0.94,
    high: 1,
    low: 0.93,
  }));
  values.splice(
    -4,
    4,
    { open: 0.97, close: 0.9, high: 0.98, low: 0.88 },
    { open: 0.9, close: 0.93, high: 0.95, low: 0.89 },
    { open: 0.93, close: 0.96, high: 0.98, low: 0.91 },
    { open: 0.96, close: 0.99, high: 1, low: 0.93 },
  );
  return {
    list: values.map((x, i) => ({
      ...x,
      time: now - (minutes - i) * 60000,
      amount: "12345",
      volume: "1000",
    })),
    _gmgnSnapshot: { fetchedAt: Date.now() },
  };
}
export function recentCandidate() {
  return { ...candidate(), createdAt: now - 15 * 60000 };
}
export function setup(
  options: {
    badSecurity?: boolean;
    missingHistory?: boolean;
    noFlow?: boolean;
    structureFail?: boolean;
    store?: Store;
  } = {},
) {
  const store = options.store ?? new Store(":memory:"),
    rpc = new Solana();
  rpc.inspectMint = async () =>
    ({
      decision: "ALLOW",
      decimals: 6,
      tokenProgram: "SPL_TOKEN",
      extensions: [],
      extensionRisk: "NONE",
    }) as never;
  const p = provider(async (args) => {
    if (args[1] === "kline")
      return options.missingHistory ? { list: [] } : candles(60);
    if (args[0] === "token" && args[1] === "info" && args.includes(MINT)) {
      const raw = info();
      return {
        ...raw,
        creation_timestamp: (now - 3600000) / 1000,
        price: options.noFlow
          ? { price: "1", volume_24h: "100000" }
          : raw.price,
      };
    }
    if (options.badSecurity && args[1] === "security")
      return { ...securityRaw, renounced_mint: false };
  });
  const kronos = fakeKronos();
  let calls = 0;
  const entry = kronos.evaluateEntry.bind(kronos);
  kronos.evaluateEntry = (i) => {
    calls++;
    return entry(i);
  };
  store.set("strategyV2", settings);
  const engine = new Engine(store, {
    gmgn: p.gmgn,
    rpc,
    kronos,
    codex: fixtureCodex(),
    demoQuotes: fixtureQuotes(),
  });
  store.discover({ ...recentCandidate(), createdAt: now - 3600000 });
  return { store, engine, p, calls: () => calls };
}

export function mockExecutionCase(
  fail?:
    | "SECURITY"
    | "COMPATIBILITY"
    | "OWNERSHIP"
    | "CAPITAL"
    | "EXIT"
    | "SIMULATE"
    | "PRE_SIGN"
    | "UNKNOWN",
  options: {
    strategy?: "STANDARD" | "KRONOS";
    kronos?: KronosDecisionStrategy;
    historyMinutes?: number;
    externalTokens?: bigint;
    store?: Store;
  } = {},
) {
  const saved = {
    mode: env.TRADING_MODE,
    ack: env.LIVE_TRADING_ACK,
    wallet: env.WALLET_PUBLIC_KEY,
    fetch: globalThis.fetch,
  };
  env.TRADING_MODE = "live";
  env.LIVE_TRADING_ACK = true;
  env.WALLET_PUBLIC_KEY = WALLET;
  globalThis.fetch = async () => {
    throw Error("NETWORK_FORBIDDEN_IN_MOCK_EXECUTION_TEST");
  };
  const store = options.store ?? new Store(":memory:"),
    rpc = new Solana();
  let sol = fail === "CAPITAL" ? 0n : 1000000000n,
    tokens = options.externalTokens ?? 0n,
    principal = 0n,
    signed = 0,
    simulated = 0,
    securityCalls = 0;
  const probes: bigint[] = [],
    order: string[] = [];
  const g = provider(async (args) => {
    if (args[1] === "kline") return candles(options.historyMinutes ?? 60);
    if (args[1] === "security") {
      securityCalls++;
      return {
        ...securityRaw,
        renounced_freeze_account: !(fail === "SECURITY" && securityCalls > 1),
      };
    }
  });
  rpc.balance = async () => sol;
  rpc.tokenBalance = async () => tokens;
  rpc.inspectMint = async () => {
    if (fail === "COMPATIBILITY")
      throw new CandidateRejected("UNSUPPORTED_TOKEN_EXTENSION");
    return {
      decision: "ALLOW",
      decimals: 6,
      tokenProgram: "SPL_TOKEN",
      extensions: [],
      extensionRisk: "NONE",
    } as never;
  };
  rpc.connection.getParsedAccountInfo = async () =>
    ({
      value: { data: { parsed: { type: "mint", info: { decimals: 6 } } } },
    }) as never;
  rpc.receipt = async () =>
    fail === "UNKNOWN"
      ? null
      : ({
          slot: 1,
          meta: { err: null, fee: 5000 },
          transaction: { signatures: ["mock-one-shot-signature"] },
        } as never);
  rpc.deltas = () => ({
    sol: -principal - 5000n,
    tokens: 1000000n,
    beforeSol: sol + principal + 5000n,
    afterSol: sol,
    beforeTokens: tokens - 1000000n,
    afterTokens: tokens,
  });
  const execution: SolanaExecutionProvider = {
    health: { state: "READY", at: Date.now() },
    getWalletBalance: async () => sol,
    quoteBuy: async (_m, n) => {
      order.push("BUY_QUOTE");
      principal = n;
      return quote("BUY", n);
    },
    quoteSell: async (_m, n, _bps, routeOnly) => {
      order.push("EXIT_PROBE");
      probes.push(n);
      if (fail === "EXIT") throw new CandidateRejected("NO_SELL_ROUTE");
      return quote("SELL", n, WALLET, routeOnly);
    },
    simulate: async () => {
      order.push("SIMULATE");
      simulated++;
      if (fail === "SIMULATE")
        throw new CandidateRejected("TOKEN_SIMULATION_FAILED");
    },
    execute: async (_q, persist, check) => {
      if (fail === "PRE_SIGN") store.dismissCandidate(MINT, "live");
      check?.();
      order.push("PRE_SIGN");
      signed++;
      persist("mock-one-shot-signature");
      if (fail !== "UNKNOWN") {
        sol -= principal + 5000n;
        tokens += 1000000n;
      }
      return "mock-one-shot-signature";
    },
    confirm: async () => (fail === "UNKNOWN" ? "UNKNOWN" : "CONFIRMED"),
  };
  store.set("strategyV2", {
    ...settings,
    entryStrategy: options.strategy ?? "STANDARD",
  });
  const e = new Engine(store, {
    gmgn: g.gmgn,
    rpc,
    execution,
    kronos: options.kronos ?? fakeKronos(),
    codex: fixtureCodex(),
  });
  if (fail === "OWNERSHIP")
    store.savePosition({
      ...position(),
      id: "owned-fixture",
      mode: "live",
      strategy: "KRONOS",
      quantity: "1",
      originalQuantity: "1",
    });
  store.discover({
    ...recentCandidate(),
    createdAt: now - (options.historyMinutes ?? 60) * 60000,
  });
  return {
    e,
    g,
    store,
    execution,
    probes,
    order,
    stats: () => ({ signed, simulated }),
    async close() {
      await e.stop();
      store.close();
      env.TRADING_MODE = saved.mode;
      env.LIVE_TRADING_ACK = saved.ack;
      env.WALLET_PUBLIC_KEY = saved.wallet;
      globalThis.fetch = saved.fetch;
    },
  };
}
