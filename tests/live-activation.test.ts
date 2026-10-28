import { it, expect } from "vitest";
import {
  loadRuntimeEnv,
  loadEnv,
  chainsFromEnv,
  realConfigSchema,
} from "@sniper/config";
import { RealTradingEngine } from "@sniper/engine";
import { MemoryRepository } from "@sniper/storage";
import { LocalWalletManager, EnvironmentSecretProvider } from "@sniper/wallet";
import type { ExecutionRecord } from "@sniper/core";
import { trip } from "./rug-fixtures";
function fixture() {
  const repository = new MemoryRepository();
  const env = loadRuntimeEnv({
    DATA_MODE: "real",
    TRADING_MODE: "live",
    LIVE_TRADING_ACK: "true",
    OBSERVATION_AUTO_START: "true",
  });
  const engine = new RealTradingEngine({
    repository,
    env,
    chains: chainsFromEnv(loadEnv({})),
    config: realConfigSchema.parse({
      version: 1,
      execution: { liveChains: ["solana"] },
    }),
    wallets: new LocalWalletManager([], new EnvironmentSecretProvider([])),
    configurationLoaded: true,
  });
  return { engine, repository };
}
it("LIVE không mặc định cấp quyền cho mọi chain", () => {
  expect(realConfigSchema.parse({ version: 1 }).execution.liveChains).toEqual(
    [],
  );
  const { engine } = fixture();
  const internal = engine as unknown as {
    running: boolean;
    settings: { activeChain: string };
    authority: { approve: (i: unknown) => unknown };
  };
  internal.running = true;
  const request = {
    decisionId: "fixture",
    risk: { passed: true, reasons: [] },
    walletId: "fixture",
    side: "BUY",
    mode: "LIVE",
    roundTrip: trip(),
    maxSlippageBps: 100,
    maxPriceImpactPct: 2,
    maxRoundTripLossPct: 5,
    idempotencyKey: "fixture",
  };
  expect(() => internal.authority.approve(request)).not.toThrow();
  internal.settings.activeChain = "bnb";
  const t = trip();
  t.buy.chainId = "bnb";
  t.sell!.chainId = "bnb";
  expect(() =>
    internal.authority.approve({ ...request, roundTrip: t }),
  ).toThrow("EXECUTION_GATE_CLOSED");
});
it("trạng thái giao dịch mơ hồ khóa entry, lưu lý do, vẫn cho intent SELL bảo vệ", async () => {
  const { engine, repository } = fixture();
  const internal = engine as unknown as {
    checkExecutionSafety: (r: ExecutionRecord) => Promise<void>;
    authority: { approve: (i: unknown) => unknown };
  };
  await internal.checkExecutionSafety({
    mode: "LIVE",
    state: "UNKNOWN",
  } as ExecutionRecord);
  const snapshot = await engine.snapshot();
  expect(snapshot.killSwitch.active).toBe(true);
  expect(snapshot.killSwitch.reasons).toContain("AMBIGUOUS_EXECUTION");
  const control = (await repository.read()).find(
    (r) => r.kind === "real.control",
  );
  expect(control?.payload).toMatchObject({
    entryDisabled: true,
    allTradingDisabled: false,
    entrySafetyReason: "AMBIGUOUS_EXECUTION",
  });
  expect(() =>
    internal.authority.approve({
      decisionId: "fixture",
      risk: { passed: true, reasons: [] },
      walletId: "fixture",
      side: "SELL",
      mode: "LIVE",
      roundTrip: trip(),
      maxSlippageBps: 100,
      maxPriceImpactPct: 2,
      maxRoundTripLossPct: 5,
      idempotencyKey: "exit-fixture",
    }),
  ).not.toThrow();
  await engine.shutdown();
});
