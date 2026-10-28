import { describe, it, expect } from "vitest";
import { mkdtemp, appendFile, rm as removeDirectory } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { JournalRepository } from "@sniper/storage";
import { PaperEngine } from "@sniper/engine";
import { chainsFromEnv, loadEnv } from "@sniper/config";
import { createFeatureEngine, MockFeatureSource } from "@sniper/features";
import { mockDiscoveryEvent } from "@sniper/chains/discovery";
import { observeOutcome } from "../packages/engine/src/outcomes";
const chains = chainsFromEnv(loadEnv({}));
async function rm(
  directory: string,
  options: { recursive: boolean; force: boolean },
) {
  const target = resolve(directory);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith("super-bot-1m-")
  )
    throw new Error("Đường dẫn dọn kiểm thử nằm ngoài thư mục tạm cho phép");
  await removeDirectory(target, options);
}
describe("Bộ dữ liệu và lưu trữ bền vững", () => {
  it("lưu thời gian lấy mẫu thực tế và giữ mốc bị bỏ lỡ ở trạng thái chưa rõ", async () => {
    const state = await createFeatureEngine(new MockFeatureSource()).collect(
      mockDiscoveryEvent("solana", 0, 0),
    );
    const initial = {
      candidateId: "1",
      chainId: "solana",
      tokenAddress: state.identity.address,
      createdAt: 0,
      initialPriceUsd: 0.01,
      prices: {},
      completedHorizons: [],
    };
    const sampled = observeOutcome(initial, state, 61000)!;
    expect(sampled.prices["60"]).toBe(0.01);
    expect(sampled.sampledAt?.["60"]).toBe(61000);
    const late = observeOutcome(initial, state, 400000)!;
    expect(late.prices["60"]).toBeUndefined();
    expect(late.missedHorizons).toEqual([60, 300]);
  });
  it("khôi phục vị thế mô phỏng và toàn bộ quyết định từ nhật ký đã đồng bộ ổ đĩa", async () => {
    const directory = await mkdtemp(join(tmpdir(), "super-bot-1m-test-"));
    try {
      const repository = new JournalRepository(directory);
      const engine = new PaperEngine({
        repository,
        chains,
        logLevel: "silent",
      });
      await engine.initialize();
      await engine.setRunning(true);
      await engine.ingest(mockDiscoveryEvent("solana", 0));
      await engine.ingest(mockDiscoveryEvent("solana", 3));
      await engine.shutdown();
      const recovered = new PaperEngine({
        repository: new JournalRepository(directory),
        chains,
        logLevel: "silent",
      });
      await recovered.initialize();
      const snapshot = await recovered.snapshot();
      expect(snapshot.metrics.trades).toBe(1);
      expect(snapshot.positions).toHaveLength(1);
      expect(snapshot.candidates).toHaveLength(2);
      expect(snapshot.running).toBe(false);
      await recovered.shutdown();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("từ chối khởi động khi nhật ký hỏng, không tự xóa trạng thái danh mục", async () => {
    const directory = await mkdtemp(join(tmpdir(), "super-bot-1m-corrupt-"));
    try {
      await appendFile(join(directory, "journal.jsonl"), "{truncated");
      const engine = new PaperEngine({
        repository: new JournalRepository(directory),
        chains,
        logLevel: "silent",
      });
      await expect(engine.initialize()).rejects.toThrow();
      await engine.shutdown();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("chỉ khôi phục ngắt thủ công sau kiểm tra trạng thái và lưu kết quả khôi phục", async () => {
    const directory = await mkdtemp(join(tmpdir(), "super-bot-1m-kill-"));
    try {
      const engine = new PaperEngine({
        repository: new JournalRepository(directory),
        chains,
        logLevel: "silent",
      });
      await engine.initialize();
      await engine.setKillSwitch(true);
      await engine.setKillSwitch(false);
      expect(engine.killSwitch.snapshot().active).toBe(false);
      await engine.shutdown();
      const recovered = new PaperEngine({
        repository: new JournalRepository(directory),
        chains,
        logLevel: "silent",
      });
      await recovered.initialize();
      expect(recovered.killSwitch.snapshot().active).toBe(false);
      await recovered.shutdown();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
