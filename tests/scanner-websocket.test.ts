import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { ProductionChainAdapter, RecoveringRpcSocket } from "@sniper/chains";
import { loadRuntimeEnv, realConfigSchema } from "@sniper/config";
const servers: WebSocketServer[] = [];
const sockets: RecoveringRpcSocket[] = [];
const adapters: ProductionChainAdapter[] = [];
async function server(
  handler: (
    socket: WebSocket,
    request: { id: number; params: unknown[] },
  ) => void,
) {
  const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(ws);
  ws.on("connection", (socket) =>
    socket.on("message", (message) =>
      handler(socket, JSON.parse(message.toString())),
    ),
  );
  await once(ws, "listening");
  const address = ws.address();
  if (typeof address === "string" || !address)
    throw new Error("LOCAL_WS_NOT_LISTENING");
  return `ws://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.disconnect();
  for (const socket of sockets.splice(0)) await socket.close();
  for (const ws of servers.splice(0)) {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
  }
  vi.restoreAllMocks();
});
describe("WebSocket scanner, chỉ máy cục bộ", () => {
  it("không báo READY khi kết nối mở nhưng provider không xác nhận subscription", async () => {
    const url = await server(() => {});
    const socket = new RecoveringRpcSocket("fixture", url, 100);
    sockets.push(socket);
    await expect(
      socket.subscribe(
        "logsSubscribe",
        [],
        "logsNotification",
        "logsUnsubscribe",
        async () => {},
      ),
    ).rejects.toThrow("WS_RPC_TIMEOUT");
    expect(socket.health()).toMatchObject({
      status: "DEGRADED",
      reasons: ["WS_RPC_TIMEOUT"],
    });
  });
  it("không lộ lỗi provider; subscription hợp lệ sau lỗi khôi phục health", async () => {
    let attempts = 0;
    const url = await server((socket, request) =>
      socket.send(
        JSON.stringify(
          ++attempts === 1
            ? {
                jsonrpc: "2.0",
                id: request.id,
                error: { message: "SECRET_FROM_PROVIDER" },
              }
            : { jsonrpc: "2.0", id: request.id, result: 1 },
        ),
      ),
    );
    const socket = new RecoveringRpcSocket("fixture", url, 1000);
    sockets.push(socket);
    await expect(
      socket.subscribe(
        "logsSubscribe",
        [],
        "logsNotification",
        "logsUnsubscribe",
        async () => {},
      ),
    ).rejects.toThrow("WS_RPC_ERROR");
    expect(socket.health().status).toBe("DEGRADED");
    expect(JSON.stringify(socket.health())).not.toContain("SECRET");
    await socket.subscribe(
      "logsSubscribe",
      [],
      "logsNotification",
      "logsUnsubscribe",
      async () => {},
    );
    expect(socket.health()).toMatchObject({ status: "READY", reasons: [] });
  });
  it("Solana đăng ký bốn DEX, giữ HTTP khi một subscription lỗi và thử lại sau khoảng giới hạn", async () => {
    const attempts = new Map<string, number>();
    const url = await server((socket, request) => {
      const program = (request.params[0] as { mentions: string[] })
        .mentions[0]!;
      const count = (attempts.get(program) ?? 0) + 1;
      attempts.set(program, count);
      const reject = program.startsWith("CPMM") && count === 1;
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          ...(reject
            ? { error: { code: -32000, message: "temporary" } }
            : { result: [...attempts.keys()].indexOf(program) + 1 }),
        }),
      );
    });
    const config = realConfigSchema.parse(
      JSON.parse(readFileSync("config/observation.json", "utf8")),
    );
    const adapter = new ProductionChainAdapter(
      {
        id: "solana",
        name: "Solana",
        type: "solana",
        enabled: true,
        nativeSymbol: "SOL",
        rpcHttpUrl: "http://127.0.0.1/unused",
        rpcWsUrl: url,
        expectedGenesisHash: "fixture-genesis",
      },
      config,
      loadRuntimeEnv({ DATA_MODE: "real", OBSERVATION_ONLY: "true" }),
      { readCursor: async () => undefined, writeCursor: async () => {} },
    );
    adapters.push(adapter);
    const request = vi
      .spyOn(adapter.rpc!, "request")
      .mockImplementation(
        async (method, _params, schema) =>
          schema.parse(
            method === "getGenesisHash"
              ? "fixture-genesis"
              : method === "getSlot"
                ? 100
                : [],
          ) as never,
      );
    await adapter.watchNewTokens(async () => {});
    expect(adapter.socketHealth().status).toBe("DEGRADED");
    expect([...attempts.values()]).toEqual([1, 1, 1, 1]);
    expect(
      request.mock.calls.some(
        ([method]) => method === "getSignaturesForAddress",
      ),
    ).toBe(true);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31000);
    await expect
      .poll(() => adapter.socketHealth().status, { timeout: 4500 })
      .toBe("READY");
    expect([...attempts.values()]).toEqual([2, 1, 1, 1]);
  });
  it("reconnect khôi phục subscriptions và gọi polling lấp khoảng trống", async () => {
    let registrations = 0;
    const gap = vi.fn(async () => {});
    const url = await server((socket, request) => {
      registrations++;
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: registrations,
        }),
      );
    });
    const socket = new RecoveringRpcSocket("fixture-reconnect", url, 1000, gap);
    sockets.push(socket);
    await socket.subscribe(
      "logsSubscribe",
      [{ mentions: ["fixture"] }],
      "logsNotification",
      "logsUnsubscribe",
      async () => {},
    );
    for (const client of servers.at(-1)!.clients) client.close();
    await expect.poll(() => registrations, { timeout: 3000 }).toBe(2);
    await expect.poll(() => gap.mock.calls.length, { timeout: 1000 }).toBe(1);
    expect(socket.health().status).toBe("READY");
  });
});
