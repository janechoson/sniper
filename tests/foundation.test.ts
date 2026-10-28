import { describe, it, expect } from "vitest";
import { tokenStateSchema, EventBus } from "@sniper/core";
import { defaultSettings, loadEnv } from "@sniper/config";
describe("Nền tảng hệ thống", () => {
  it("cô lập bên nhận sự kiện để giao diện mất kết nối không ngắt xử lý", () => {
    let errors = 0;
    let received = 0;
    const bus = new EventBus(() => errors++);
    bus.subscribe(() => {
      throw new Error("bên nhận sự kiện gặp lỗi");
    });
    bus.subscribe(() => received++);
    bus.publish({ id: "isolation", type: "test", timestamp: 1, data: {} });
    expect(errors).toBe(1);
    expect(received).toBe(1);
  });
  it("giữ nguyên trạng thái bảo mật chưa rõ", () => {
    const state = tokenStateSchema.parse({
      identity: { chainId: "solana", address: "fixture", source: "MOCK" },
      observedAt: 1,
      market: {},
      holders: {},
      creator: {},
      security: {},
    });
    expect(state.security.mintRisk).toBeUndefined();
  });
  it("chặn an toàn chế độ tiền thật", () => {
    expect(() => loadEnv({ MODE: "LIVE" })).toThrow();
    expect(defaultSettings().mode).toBe("PAPER");
  });
  it("phát sự kiện có kiểu dữ liệu", () => {
    const bus = new EventBus();
    let calls = 0;
    const off = bus.subscribe(() => calls++);
    bus.publish({ id: "1", type: "test", timestamp: 1, data: {} });
    off();
    expect(calls).toBe(1);
  });
});
