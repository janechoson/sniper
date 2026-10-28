import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { RealTradingEngine, type PaperEngine } from "@sniper/engine";
import type { createLogger } from "@sniper/shared";
const controls = z
  .object({
    action: z.enum([
      "start",
      "pause",
      "kill",
      "reset",
      "disable-all",
      "enable-all",
    ]),
    confirm: z.literal(true).optional(),
  })
  .strict();
async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const part of request) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    size += buffer.length;
    if (size > 32768) throw new Error("Nội dung yêu cầu quá lớn");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function createApiHandler(
  engine: PaperEngine | RealTradingEngine,
  port: number,
  logger: ReturnType<typeof createLogger>,
) {
  let streams = 0;
  return (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      if (
        ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
          request.headers.host ?? "",
        ) ||
        (request.headers.origin !== undefined &&
          request.headers.origin !== `http://${request.headers.host}`)
      ) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/events" && request.method === "GET") {
        if (streams >= 32) {
          response.writeHead(503).end();
          return;
        }
        streams++;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.flushHeaders();
        response.write("retry: 2000\n\n");
        const off = engine.bus.subscribe((event) => {
          if (
            !response.write(
              `id: ${event.id}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`,
            )
          )
            response.end();
        });
        const heartbeat = setInterval(
          () => response.write(": heartbeat\n\n"),
          15000,
        );
        let cleaned = false;
        response.on("close", () => {
          if (cleaned) return;
          cleaned = true;
          streams--;
          clearInterval(heartbeat);
          off();
        });
        return;
      }
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        if (url.pathname === "/health") {
          const snapshot = await engine.snapshot();
          response.end(
            JSON.stringify({
              mode: snapshot.mode,
              source: snapshot.source,
              liveEnabled: snapshot.liveEnabled,
              status:
                snapshot.source === "MOCK"
                  ? "MOCK"
                  : snapshot.readiness?.ready
                    ? "READY"
                    : "DEGRADED",
              database: snapshot.health.database,
              readiness: snapshot.readiness,
              tradingWallet: snapshot.tradingWallet,
              killSwitch: snapshot.killSwitch,
            }),
          );
          return;
        }
        if (url.pathname === "/snapshot") {
          response.end(JSON.stringify(await engine.snapshot()));
          return;
        }
        if (url.pathname === "/readiness") {
          const snapshot = await engine.snapshot();
          response.end(
            JSON.stringify(
              snapshot.readiness ?? {
                mode: "PAPER",
                ready: false,
                items: [
                  {
                    component: "LIVE",
                    required: true,
                    status: "FAIL",
                    reasons: ["MOCK_DATA"],
                  },
                ],
                checkedAt: Date.now(),
              },
            ),
          );
          return;
        }
        if (url.pathname === "/wallet") {
          const snapshot = await engine.snapshot();
          response.end(JSON.stringify(snapshot.tradingWallet ?? null));
          return;
        }
        if (
          url.pathname === "/wallet-balance" &&
          engine instanceof RealTradingEngine
        ) {
          const chainId = z
            .enum(["solana", "bnb", "robinhood"])
            .parse(url.searchParams.get("chainId"));
          response.end(JSON.stringify(await engine.balances(chainId)));
          return;
        }
        if (url.pathname === "/settings") {
          response.end(JSON.stringify(engine.getSettings()));
          return;
        }
        if (url.pathname === "/history") {
          const offset = z.coerce
            .number()
            .int()
            .min(0)
            .max(1000000)
            .parse(url.searchParams.get("offset") ?? 0);
          const limit = z.coerce
            .number()
            .int()
            .min(1)
            .max(1000)
            .parse(url.searchParams.get("limit") ?? 100);
          if (engine instanceof RealTradingEngine) {
            response.end(
              JSON.stringify(await engine.historyPage(offset, limit)),
            );
            return;
          }
          const records = engine.history();
          response.end(
            JSON.stringify({
              total: records.length,
              records: records.slice(offset, offset + limit),
            }),
          );
          return;
        }
      }
      if (
        request.method === "POST" &&
        url.pathname === "/position-close" &&
        engine instanceof RealTradingEngine
      ) {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          response.writeHead(415).end();
          return;
        }
        const input = z
          .object({
            positionId: z.string().min(1).max(200),
            confirm: z.literal(true),
          })
          .strict()
          .parse(await body(request));
        response.end(
          JSON.stringify(await engine.closePosition(input.positionId)),
        );
        return;
      }
      if (
        (request.method === "PATCH" && url.pathname === "/settings") ||
        (request.method === "POST" && url.pathname === "/control")
      ) {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          response
            .writeHead(415)
            .end(JSON.stringify({ error: "Yêu cầu dữ liệu JSON" }));
          return;
        }
        const input = await body(request);
        if (url.pathname === "/settings") {
          response.end(JSON.stringify(await engine.updateSettings(input)));
          return;
        }
        const { action, confirm } = controls.parse(input);
        if (action === "disable-all" || action === "enable-all") {
          if (!(engine instanceof RealTradingEngine) || confirm !== true)
            throw new Error("EXPLICIT_CONFIRMATION_REQUIRED");
          await engine.setAllTradingDisabled(action === "disable-all");
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        if (action === "start" || action === "pause")
          await engine.setRunning(action === "start");
        else await engine.setKillSwitch(action === "kill");
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: "Không tìm thấy" }));
    })().catch((error) => {
      logger.warn(
        {
          code: error instanceof z.ZodError ? "VALIDATION_ERROR" : "API_ERROR",
        },
        "Yêu cầu API thất bại",
      );
      if (response.headersSent) {
        response.end();
        return;
      }
      response
        .writeHead(error instanceof z.ZodError ? 400 : 503, {
          "content-type": "application/json",
        })
        .end(
          JSON.stringify({
            error:
              error instanceof z.ZodError
                ? "Cấu hình gửi lên không hợp lệ"
                : "Thao tác thất bại; kiểm tra trạng thái bot và các giới hạn đã cấu hình",
            issues:
              error instanceof z.ZodError
                ? error.issues.map((i) => ({
                    path: i.path,
                    message: i.message,
                  }))
                : undefined,
          }),
        );
    });
  };
}
