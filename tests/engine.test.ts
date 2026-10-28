import { describe, it, expect } from "vitest";
import { PaperEngine } from "@sniper/engine";
import { MemoryRepository } from "@sniper/storage";
import { loadEnv, chainsFromEnv } from "@sniper/config";
import {
  mockDiscoveryEvent,
  DiscoveryCoordinator,
} from "@sniper/chains/discovery";
import { MockChainAdapter } from "@sniper/chains";
import { MockAIProvider } from "@sniper/ai";
const chains = chainsFromEnv(loadEnv({}));
async function setup() {
  let time = Date.now();
  const repository = new MemoryRepository();
  const engine = new PaperEngine({
    repository,
    chains,
    now: () => time,
    logLevel: "silent",
  });
  await engine.initialize();
  await engine.setRunning(true);
  return {
    engine,
    repository,
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
}
describe("Tích hợp tiến trình bot mô phỏng", () => {
  it("chặn token đang phân tích khi đổi chuỗi quét trong lúc gọi AI", async () => {
    let begin: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const classifier = new MockAIProvider();
    const engine = new PaperEngine({
      repository: new MemoryRepository(),
      chains,
      logLevel: "silent",
      ai: {
        id: "delayed",
        classify: async (state) => {
          begin();
          await gate;
          return classifier.classify(state);
        },
      },
    });
    await engine.initialize();
    await engine.setRunning(true);
    const pending = engine.ingest(mockDiscoveryEvent("solana", 0));
    await started;
    await engine.updateSettings({ activeChain: "bnb" });
    release();
    await pending;
    const snapshot = await engine.snapshot();
    expect(snapshot.metrics.trades).toBe(0);
    expect(snapshot.candidates[0]?.reasons).toContain("DISCOVERY_CHANGED");
    await engine.shutdown();
  });
  it("khóa lệnh mới khi vượt mức lỗ ngày sau thoát lệnh, vẫn tiếp tục theo dõi", async () => {
    const { engine, advance, now } = await setup();
    await engine.updateSettings({ maxDailyLossUsd: 5, tradeSizeUsd: 50 });
    await engine.ingest(mockDiscoveryEvent("solana", 1, now()));
    advance(12000);
    await engine.monitor();
    expect(engine.killSwitch.snapshot().reasons).toContain("DAILY_LOSS");
    await engine.ingest(mockDiscoveryEvent("solana", 2, now()));
    expect((await engine.snapshot()).metrics.trades).toBe(1);
    await expect(engine.setKillSwitch(false)).rejects.toThrow(
      "kiểm tra an toàn",
    );
    await engine.shutdown();
  });
  it("loại sự kiện bể trùng lặp cả khi đồng thời và khi khôi phục nhật ký", async () => {
    const { engine, repository, now } = await setup();
    const event = mockDiscoveryEvent("solana", 0, now());
    await Promise.all([
      engine.ingest(event),
      engine.ingest({ ...event, id: "other" }),
    ]);
    expect((await engine.snapshot()).metrics.trades).toBe(1);
    await engine.shutdown();
    const restarted = new PaperEngine({
      repository,
      chains,
      logLevel: "silent",
    });
    await restarted.initialize();
    await restarted.setRunning(true);
    await restarted.ingest(event);
    expect((await restarted.snapshot()).metrics.trades).toBe(1);
    await restarted.shutdown();
  });
  it("chuyển chuỗi quét nhưng vẫn theo dõi và thoát vị thế trên chuỗi cũ", async () => {
    const { engine, advance, now } = await setup();
    await engine.ingest(mockDiscoveryEvent("solana", 0, now()));
    await engine.updateSettings({ activeChain: "bnb" });
    await engine.ingest(mockDiscoveryEvent("bnb", 2, now()));
    advance(15000);
    await engine.monitor();
    const snapshot = await engine.snapshot();
    expect(snapshot.activeChain).toBe("bnb");
    expect(snapshot.positions.map((p) => p.chainId)).toEqual(
      expect.arrayContaining(["solana", "bnb"]),
    );
    expect(
      snapshot.positions.find((p) => p.chainId === "solana")?.takenLevels,
    ).toContain(0);
    await engine.shutdown();
  });
  it("xử lý tuần tự các lệnh đồng thời theo giới hạn danh mục", async () => {
    const { engine, now } = await setup();
    await engine.updateSettings({ maxPositions: 1 });
    await Promise.all([
      engine.ingest(mockDiscoveryEvent("solana", 0, now())),
      engine.ingest(mockDiscoveryEvent("solana", 2, now())),
    ]);
    const snapshot = await engine.snapshot();
    expect(snapshot.metrics.trades).toBe(1);
    expect(
      snapshot.candidates.some((c) => c.reasons.includes("MAX_POSITIONS")),
    ).toBe(true);
    await engine.shutdown();
  });
  it("không gọi AI cho token đã bị bộ lọc cứng từ chối", async () => {
    let calls = 0;
    const engine = new PaperEngine({
      repository: new MemoryRepository(),
      chains,
      logLevel: "silent",
      ai: {
        id: "spy",
        classify: async () => {
          calls++;
          throw new Error("offline");
        },
      },
    });
    await engine.initialize();
    await engine.setRunning(true);
    await engine.ingest(mockDiscoveryEvent("solana", 3));
    expect(calls).toBe(0);
    await engine.ingest(mockDiscoveryEvent("solana", 0));
    expect(calls).toBe(1);
    expect((await engine.snapshot()).candidates[0]?.reasons).toContain(
      "AI_UNAVAILABLE",
    );
    expect((await engine.snapshot()).metrics.trades).toBe(0);
    await engine.shutdown();
  });
  it("vẫn cắt lỗ khi đã kích hoạt ngắt khẩn cấp và tạm dừng quét", async () => {
    const { engine, advance, now } = await setup();
    await engine.ingest(mockDiscoveryEvent("solana", 1, now()));
    await engine.setKillSwitch(true);
    await engine.setRunning(false);
    advance(12000);
    await engine.monitor();
    const snapshot = await engine.snapshot();
    expect(snapshot.positions[0]?.exitState).toBe("STOP_LOSS");
    expect(snapshot.positions[0]?.closedAt).toBeDefined();
    expect(snapshot.killSwitch.active).toBe(true);
    await engine.shutdown();
  });
  it("lưu token bị từ chối, bỏ qua và kết quả theo mốc thời gian", async () => {
    const { engine, advance, now, repository } = await setup();
    await engine.ingest(mockDiscoveryEvent("solana", 3, now()));
    await engine.setRunning(false);
    await engine.ingest(mockDiscoveryEvent("solana", 2, now()));
    advance(61000);
    await engine.monitor();
    expect(engine.history().map((c) => c.action)).toEqual(
      expect.arrayContaining(["REJECT", "SKIP"]),
    );
    expect(
      (await engine.snapshot()).outcomes.every((o) =>
        o.completedHorizons.includes(60),
      ),
    ).toBe(true);
    expect(
      (await repository.read()).some((entry) => entry.kind === "commit"),
    ).toBe(true);
    await engine.shutdown();
  });
  it("chặn chuỗi quét cũ trước khi khởi tạo chuỗi mới thất bại", async () => {
    const solana = new MockChainAdapter(chains[0]!);
    const bnb = new MockChainAdapter(chains[1]!);
    bnb.connect = async () => {
      throw new Error("offline");
    };
    const coordinator = new DiscoveryCoordinator(
      new Map([
        ["solana", solana],
        ["bnb", bnb],
      ]),
    );
    await coordinator.switchTo("solana");
    await expect(coordinator.switchTo("bnb")).rejects.toThrow();
    expect(coordinator.accepting("solana")).toBe(false);
  });
  it("chặn lệnh an toàn khi ghi bền vững thất bại", async () => {
    const { engine, repository, now } = await setup();
    repository.append = async () => {
      throw new Error("lỗi ổ đĩa");
    };
    await expect(
      engine.ingest(mockDiscoveryEvent("solana", 0, now())),
    ).rejects.toThrow();
    expect((await engine.snapshot()).metrics.trades).toBe(0);
    expect(engine.killSwitch.snapshot().reasons).toContain(
      "DATABASE_INTEGRITY",
    );
    await engine.shutdown();
  });
});
