import { JupiterExecutionProvider, localWallet } from "./execution-provider.js";
import { SMOKE_USDC, smokeAmount } from "./smoke-policy.js";
import { env } from "./config.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { Gmgn, normalizeMarket, SOL } from "./gmgn.js";
import { Jev } from "./jev.js";
import { Solana } from "./solana.js";
import { Blocked } from "./domain.js";
import { acquireLock } from "./server.js";
import { json, safeError, sleep } from "./util.js";
export async function verify(target: string) {
  if (target === "execution") {
    const rpc = new Solana(),
      provider = new JupiterExecutionProvider(rpc);
    const configuration = {
      smokeAck: process.env.LIVE_SMOKE_TEST_ACK === "true",
      configuredSmokeSol: process.env.LIVE_SMOKE_TEST_SOL ?? "0.005",
      signer: "UNVERIFIED",
      principal: "UNVERIFIED",
    };
    try {
      const signer = localWallet();
      signer.secretKey.fill(0);
      configuration.signer = "MATCHED";
    } catch (error) {
      configuration.signer = safeError(error);
    }
    try {
      configuration.principal = smokeAmount(
        process.env.LIVE_SMOKE_TEST_SOL,
      ).toString();
    } catch (error) {
      configuration.principal = safeError(error);
    }
    try {
      const buy = await provider.quoteBuy(SMOKE_USDC, 5_000_000n, 100);
      const reverse = await provider.quoteSell(
        SMOKE_USDC,
        BigInt(buy.order.outAmount),
        100,
        true,
      );
      await provider.simulate(buy);
      return {
        configuration,
        provider: provider.health,
        quotePrincipalLamports: buy.amount,
        quoteExpectedTokens: buy.order.outAmount,
        buyRoute: buy.order.routePlan,
        reverseRoute: reverse.order.routePlan,
        simulation: "PASSED_NOT_A_TRADE",
        blocked:
          configuration.signer !== "MATCHED"
            ? configuration.signer
            : configuration.principal !== "5000000"
              ? configuration.principal
              : undefined,
        broadcasts: 0,
      };
    } catch (error) {
      return {
        configuration,
        provider: provider.health,
        blocked: safeError(error),
        broadcasts: 0,
      };
    }
  }
  if (target === "wallet") {
    if (!env.WALLET_PUBLIC_KEY) throw new Blocked("MISSING_WALLET_PUBLIC_KEY");
    const rpc = new Solana();
    return {
      wallet: env.WALLET_PUBLIC_KEY,
      balanceLamports: (await rpc.balance(env.WALLET_PUBLIC_KEY)).toString(),
      rpcVersion: await rpc.connection.getVersion(),
      broadcasts: 0,
    };
  }
  if (target === "jev")
    return new Jev().decide({
      purpose: "Read-only configuration probe; not a trade",
      market: "UNKNOWN",
      mintControl: "UNKNOWN",
      freezeControl: "UNKNOWN",
    });
  if (target === "gmgn") {
    const g = new Gmgn(),
      candidates = await g.discover();
    if (!candidates[0])
      throw new Blocked("GMGN discovery returned no current tokens");
    const info = await g.info(candidates[0].mint);
    const engineSettings = (await import("./config.js")).defaultSettings();
    const security = await g.security(candidates[0], engineSettings),
      intelligence = await g.intelligence(
        candidates[0],
        info,
        security,
        engineSettings,
      );
    return {
      discovered: candidates.length,
      sample: candidates[0],
      market: normalizeMarket(info),
      security,
      intelligence,
      solPrice: normalizeMarket(await g.info(SOL)).price,
      broadcasts: 0,
    };
  }
  if (target === "paper") {
    if (env.TRADING_MODE !== "paper")
      throw new Blocked("verify:paper requires TRADING_MODE=paper");
    const release = acquireLock(env.DATABASE_PATH);
    const store = new Store(env.DATABASE_PATH);
    try {
      const engine = new Engine(store);
      const before = engine.analytics();
      let cycles = 0;
      for (let cycle = 0; cycle < env.OBSERVATION_CYCLES; cycle++) {
        cycles++;
        await engine.tick();
        if (engine.gmgn.health.state !== "READY" || !store.entriesEnabled())
          break;
        if (cycle < env.OBSERVATION_CYCLES - 1) await sleep(1000);
      }
      await engine.monitor();
      const after = engine.analytics();
      return {
        provider: engine.gmgn.health,
        jev: engine.jev.http.health,
        cycles,
        delta: {
          discovered: after.discovered - before.discovered,
          analyzed: after.analyzed - before.analyzed,
          jevCalls: after.jevCalls - before.jevCalls,
          jevBuy: after.jevBuy - before.jevBuy,
          bought: after.bought - before.bought,
          closed: after.closed - before.closed,
        },
        analytics: after,
        blocked:
          engine.gmgn.health.state !== "READY"
            ? (engine.gmgn.health.reason ??
              store.get<string>("haltReason") ??
              "No real GMGN discovery was observed")
            : engine.jev.http.health.state !== "READY"
              ? "No valid Jev decision observed"
              : undefined,
        broadcasts: 0,
      };
    } finally {
      store.close();
      release();
    }
  }
  throw new Blocked("Unknown verification command");
}
const target = process.argv[2];
if (target)
  verify(target)
    .then((result) => {
      const blocked = "blocked" in result && !!result.blocked;
      process.stdout.write(
        json({
          target,
          status: blocked ? "BLOCKED" : "PASSED",
          result,
          broadcasts: 0,
        }) + "\n",
      );
      if (blocked) process.exitCode = 2;
    })
    .catch((error) => {
      process.stdout.write(
        json({
          target,
          status: "BLOCKED",
          reason: safeError(error),
          broadcasts: 0,
        }) + "\n",
      );
      process.exitCode = 2;
    });
