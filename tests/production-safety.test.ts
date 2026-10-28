import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  parseUnitsSafe,
  formatUnitsSafe,
  ratioToNumber,
  redactSecrets,
} from "@sniper/shared";
import {
  loadRuntimeEnv,
  operationalMode,
  defaultSettings,
  realConfigSchema,
  loadEnv,
  chainsFromEnv,
} from "@sniper/config";
import { MemoryRepository, NamespacedRepository } from "@sniper/storage";
import { TradeIntentAuthority } from "@sniper/risk";
import { DurableExecutionStore, RealPaperExecutor } from "@sniper/execution";
import { AtomicPositionManager } from "@sniper/positions";
import { InternalCreatorHistoryProvider } from "@sniper/features";
import {
  LocalSolanaSigner,
  LocalWalletManager,
  EnvironmentSecretProvider,
} from "@sniper/wallet";
import { RealTradingEngine } from "@sniper/engine";
import { atomicQuoteSchema, type RoundTripResult } from "@sniper/core";
const quote = () =>
  atomicQuoteSchema.parse({
    id: "q",
    providerId: "fixture-real-provider",
    chainId: "bnb",
    tokenIn: "a",
    tokenOut: "b",
    amountIn: "90071992547409930000000",
    expectedAmountOut: "9007199254740993000000",
    minimumAmountOut: "9007199254740993000000",
    decimalsIn: 18,
    decimalsOut: 18,
    priceImpactPct: 1,
    quotedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    source: "RPC",
    quality: "REAL",
  });
function approval() {
  const buy = quote();
  const trip: RoundTripResult = {
    buy,
    sell: {
      ...buy,
      id: "s",
      tokenIn: "b",
      tokenOut: "a",
      amountIn: buy.minimumAmountOut,
      expectedAmountOut: buy.amountIn,
      minimumAmountOut: buy.amountIn,
    },
    sellability: "UNKNOWN",
    evidence: "QUOTE_ONLY",
    roundTripLossPct: 1,
    reasons: [],
  };
  return {
    decisionId: "decision",
    risk: { passed: true, reasons: [] },
    walletId: "paper",
    side: "BUY" as const,
    mode: "PAPER" as const,
    roundTrip: trip,
    maxSlippageBps: 100,
    maxPriceImpactPct: 2,
    maxRoundTripLossPct: 5,
    idempotencyKey: "unique-entry",
    allowQuoteOnlyPaper: true,
  };
}
describe("Số lượng và cấu hình thực", () => {
  it("giữ chính xác số nguyên lớn hơn MAX_SAFE_INTEGER", () => {
    const amount = "900719925474099312345678";
    expect(parseUnitsSafe(formatUnitsSafe(BigInt(amount), 18), 18)).toBe(
      BigInt(amount),
    );
    expect(() => parseUnitsSafe("1.0000001", 6)).toThrow();
    expect(ratioToNumber(1n, 10n ** 30n)).toBeUndefined();
    expect(ratioToNumber(10n ** 20n, 1n)).toBeUndefined();
    expect(ratioToNumber(0n, 1n)).toBe(0);
  });
  it("chặn phối hợp mode/key mâu thuẫn", () => {
    expect(() =>
      loadRuntimeEnv({ DATA_MODE: "real", AI_PROVIDER: "mock" }),
    ).toThrow();
    expect(() =>
      loadRuntimeEnv({ DATA_MODE: "mock", TRADING_MODE: "live_dry_run" }),
    ).toThrow();
    expect(() =>
      loadRuntimeEnv({ DATA_MODE: "real", TRADING_MODE: "live" }),
    ).toThrow();
    expect(() =>
      loadRuntimeEnv({ DATA_MODE: "real", DATA_SOURCE: "MOCK" }),
    ).toThrow();
    expect(() => loadRuntimeEnv({ DATA_SOURCE: "RPC" })).toThrow();
    expect(
      operationalMode(
        loadRuntimeEnv({ DATA_MODE: "real", TRADING_MODE: "live_dry_run" }),
      ),
    ).toBe("LIVE_DRY_RUN");
  });
  it("ẩn trường bí mật ở độ sâu bất kỳ", () => {
    const sanitized = JSON.stringify(
      redactSecrets({
        deep: {
          array: [
            {
              TYPESAFE_API_KEY: "hidden1",
              wallet: { private_key: "hidden2" },
              rpcHttpUrl: "hidden3",
            },
          ],
        },
        error: new Error("hidden4"),
      }),
    );
    expect(sanitized).not.toMatch(/hidden[1-4]/);
  });
  it("không trộn journal thật và giả", async () => {
    const base = new MemoryRepository();
    const real = new NamespacedRepository(base, "real-paper");
    await base.append({
      id: "mock-entry",
      kind: "commit",
      payload: {},
      createdAt: 1,
    });
    await real.append({
      id: "real-entry",
      kind: "real.candidate",
      payload: {},
      createdAt: 2,
    });
    expect((await real.read()).map((e) => e.id)).toEqual(["real-entry"]);
    expect((await base.read()).length).toBe(2);
  });
});
describe("Intent, idempotency và khôi phục vị thế", () => {
  it("BUY của AI không đủ cấp intent LIVE và quote-only mặc định bị chặn", () => {
    const authority = new TradeIntentAuthority(() => true);
    expect(() => authority.approve({ ...approval(), mode: "LIVE" })).toThrow(
      "SELLABILITY_NOT_PROVEN",
    );
    expect(() =>
      authority.approve({ ...approval(), allowQuoteOnlyPaper: false }),
    ).toThrow("SELLABILITY_NOT_PROVEN");
    expect(() =>
      authority.approve({
        ...approval(),
        risk: { passed: false, reasons: ["KILL_SWITCH"] },
      }),
    ).toThrow("RISK_REJECTED");
  });
  it("chặn sửa payload và thu hồi điều kiện thực thi sau cấp intent", () => {
    let allowed = true;
    const authority = new TradeIntentAuthority(() => allowed);
    const intent = authority.approve(approval());
    expect(authority.accepts({ ...intent, amountIn: "1" })).toBe(false);
    allowed = false;
    expect(authority.accepts(intent)).toBe(false);
  });
  it("chỉ khớp một lần khi gọi đồng thời, khôi phục raw amount và không nhân đôi vị thế", async () => {
    const repository = new MemoryRepository();
    const store = new DurableExecutionStore(repository);
    const authority = new TradeIntentAuthority(() => true);
    const intent = authority.approve(approval());
    const executor = new RealPaperExecutor(store, (i) => authority.accepts(i));
    const results = await Promise.all([
      executor.execute(intent),
      executor.execute(intent),
    ]);
    expect(results[0]!.id).toBe(results[1]!.id);
    const restored = new DurableExecutionStore(repository);
    await restored.restore();
    expect(restored.get(intent.idempotencyKey)?.actualAmountOut).toBe(
      intent.route.quote.minimumAmountOut,
    );
    const positions = new AtomicPositionManager(repository);
    await positions.restore();
    await positions.applyFill(results[0]!, intent, defaultSettings());
    await positions.applyFill(results[0]!, intent, defaultSettings());
    expect(positions.all()).toHaveLength(1);
    expect(positions.all()[0]!.remainingQuantity).toBe(
      intent.route.quote.minimumAmountOut,
    );
    const restarted = new AtomicPositionManager(repository);
    await restarted.restore();
    await restarted.applyFill(results[0]!, intent, defaultSettings());
    expect(restarted.all()).toHaveLength(1);
    expect(
      (await new RealPaperExecutor(restored, () => false).execute(intent)).id,
    ).toBe(results[0]!.id);
  });
  it("không tạo vị thế từ dry-run hoặc giao dịch chưa xác nhận", async () => {
    const repository = new MemoryRepository();
    const authority = new TradeIntentAuthority(() => true);
    const intent = authority.approve(approval());
    const positions = new AtomicPositionManager(repository);
    await expect(
      positions.applyFill(
        {
          id: "exec",
          intentId: intent.id,
          idempotencyKey: "u",
          walletId: "paper",
          chainId: "bnb",
          mode: "PAPER",
          state: "PENDING",
          updatedAt: Date.now(),
          reasons: [],
        },
        intent,
        defaultSettings(),
      ),
    ).rejects.toThrow("UNCONFIRMED_POSITION_FILL");
    expect(positions.all()).toHaveLength(0);
  });
});
describe("Ví và lịch sử creator", () => {
  it("đọc đúng Solana raw key có byte đầu bằng ký tự [", () => {
    const seed = new Uint8Array(32);
    seed[0] = 91;
    const pair = Keypair.fromSeed(seed);
    expect(new LocalSolanaSigner(pair.secretKey).address()).toBe(
      pair.publicKey.toBase58(),
    );
  });
  it("không đưa secretRef hoặc khóa vào metadata ví", async () => {
    const manager = new LocalWalletManager(
      [
        {
          id: "evm",
          label: "Ví fixture",
          family: "evm",
          chains: ["bnb"],
          enabled: true,
          signerType: "local-env",
          secretRef: "env:FIXTURE_PRIVATE_KEY",
        },
      ],
      new EnvironmentSecretProvider(["FIXTURE_PRIVATE_KEY"], {
        FIXTURE_PRIVATE_KEY: "0x" + "11".repeat(32),
      }),
    );
    const wallet = await manager.publicWallet("evm");
    expect(wallet.address).toMatch(/^0x/);
    expect(JSON.stringify(wallet)).not.toMatch(
      /secretRef|FIXTURE_PRIVATE_KEY|111111111111/,
    );
    await expect(manager.signer("evm", "solana")).rejects.toThrow(
      "WALLET_UNAVAILABLE",
    );
  });
  it("lịch sử nội bộ không suy ra knownBadFunding=false hoặc nhầm địa chỉ Solana", async () => {
    const repository = new MemoryRepository();
    const creator = new InternalCreatorHistoryProvider(repository);
    await creator.record({
      chainId: "solana",
      tokenAddress: "AbCd",
      creatorAddress: "creator",
      transactionId: "tx",
      observedAt: 1,
      evidence: "PROGRAM_POOL_CREATOR",
      outcome: "OBSERVED",
    });
    expect(
      (await creator.getCreatorAnalysis("solana", "AbCd")).knownBadFunding,
    ).toBeUndefined();
    expect(await creator.getCreatorAnalysis("solana", "abcd")).toEqual({});
    const restored = new InternalCreatorHistoryProvider(repository);
    await restored.restore();
    expect(
      (await restored.getCreatorAnalysis("solana", "AbCd")).previousTokens,
    ).toBe(0);
  });
  it("REAL thiếu cấu hình vẫn báo đúng RPC và không tự tạo token/AI/vị thế", async () => {
    const repository = new MemoryRepository();
    const env = loadRuntimeEnv({ DATA_MODE: "real" });
    const engine = new RealTradingEngine({
      repository,
      chains: chainsFromEnv(loadEnv({})),
      env,
      config: realConfigSchema.parse({ version: 1 }),
      wallets: new LocalWalletManager([], new EnvironmentSecretProvider([])),
      configurationLoaded: false,
    });
    await engine.initialize();
    const snapshot = await engine.snapshot();
    expect(snapshot.source).toBe("RPC");
    expect(snapshot.liveEnabled).toBe(false);
    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.readiness?.ready).toBe(false);
    expect(snapshot.health.ai.status).toBe("unhealthy");
    await expect(engine.setRunning(true)).rejects.toThrow(
      "REAL_SCANNER_NOT_READY",
    );
    await engine.shutdown();
  });
});
