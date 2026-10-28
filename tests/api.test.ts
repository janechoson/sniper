import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, it, expect } from "vitest";
import { PaperEngine } from "@sniper/engine";
import { MemoryRepository } from "@sniper/storage";
import { loadEnv, chainsFromEnv } from "@sniper/config";
import { createLogger } from "@sniper/shared";
import { createApiHandler } from "../apps/bot/src/server";
const resources: { server: Server; engine: PaperEngine }[] = [];
afterEach(async () => {
  for (const { server, engine } of resources.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await engine.shutdown();
  }
});
async function serve() {
  const engine = new PaperEngine({
    repository: new MemoryRepository(),
    chains: chainsFromEnv(loadEnv({})),
    logLevel: "silent",
  });
  await engine.initialize();
  const server = createServer((request, response) =>
    handler(request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push({ server, engine });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Chưa có cổng kết nối");
  const handler = createApiHandler(
    engine,
    address.port,
    createLogger("silent"),
  );
  return {
    engine,
    base: `http://127.0.0.1:${address.port}`,
    headers: { "content-type": "application/json" },
  };
}
describe("An toàn API của bot", () => {
  it("cho phép giao diện cùng origin và từ chối cấu hình chọn ví cũ", async () => {
    const { base, headers } = await serve();
    const accepted = await fetch(base + "/control", {
      method: "POST",
      headers: { ...headers, origin: base },
      body: JSON.stringify({ action: "pause" }),
    });
    expect(accepted.status).toBe(200);
    const removed = await fetch(base + "/settings", {
      method: "PATCH",
      headers: { ...headers, origin: base },
      body: JSON.stringify({ activeWalletByChain: { bnb: "arbitrary" } }),
    });
    expect(removed.status).toBe(400);
    expect((await fetch(base + "/wallets")).status).toBe(404);
  });
  it("máy chủ từ chối chế độ tiền thật và thông số âm không hợp lệ", async () => {
    const { base, headers, engine } = await serve();
    for (const patch of [
      { mode: "LIVE" },
      { tradeSizeUsd: -1 },
      {
        takeProfit: [
          { gainPct: 30, sellPct: 80 },
          { gainPct: 60, sellPct: 80 },
        ],
      },
      { unexpected: true },
    ]) {
      const response = await fetch(base + "/settings", {
        method: "PATCH",
        headers,
        body: JSON.stringify(patch),
      });
      expect(response.status).toBe(400);
    }
    expect(engine.getSettings().mode).toBe("PAPER");
  });
  it("từ chối nguồn trình duyệt và tên máy chủ không hợp lệ", async () => {
    const { base, headers } = await serve();
    expect(
      (
        await fetch(base + "/control", {
          method: "POST",
          headers: { ...headers, origin: "https://untrusted.example" },
          body: JSON.stringify({ action: "start" }),
        })
      ).status,
    ).toBe(403);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        base + "/snapshot",
        { headers: { host: "untrusted.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  });
  it("cung cấp trạng thái, cài đặt đã kiểm tra và lịch sử quyết định lưu bền vững", async () => {
    const { base, headers } = await serve();
    expect((await fetch(base + "/health", { headers })).status).toBe(200);
    const update = await fetch(base + "/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ activeChain: "bnb", tradeSizeUsd: 25 }),
    });
    expect((await update.json()).activeChain).toBe("bnb");
    const history = await fetch(base + "/history", { headers });
    expect(await history.json()).toEqual({ total: 0, records: [] });
  });
});
