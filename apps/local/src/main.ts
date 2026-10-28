import { createServer } from "node:http";
import next from "next";
import { resolve } from "node:path";
import { createBotRuntime } from "../../bot/src/runtime";
import { createApiHandler } from "../../bot/src/server";
const runtime = await createBotRuntime().catch(() => {
  process.stderr.write(
    "Không thể khởi tạo bot: kiểm tra cấu hình, migration và nhật ký.\n",
  );
  process.exit(1);
});
const { engine, env, logger } = runtime;
const app = next({
  dev: process.argv.includes("--dev"),
  dir: resolve("apps/web"),
  hostname: "127.0.0.1",
  port: env.PORT,
});
let stopping = false;
const api = createApiHandler(engine, env.PORT, logger);
const handler = app.getRequestHandler();
const server = createServer((request, response) => {
  const host = request.headers.host;
  if (
    ![`127.0.0.1:${env.PORT}`, `localhost:${env.PORT}`].includes(host ?? "")
  ) {
    response.writeHead(403).end();
    return;
  }
  if (request.url?.startsWith("/api/")) {
    request.url = request.url.slice(4);
    api(request, response);
  } else
    void handler(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
});
server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.on("upgrade", (request, socket, head) => {
  if (
    ![`127.0.0.1:${env.PORT}`, `localhost:${env.PORT}`].includes(
      request.headers.host ?? "",
    ) ||
    (request.headers.origin &&
      request.headers.origin !== `http://${request.headers.host}`)
  ) {
    socket.destroy();
    return;
  }
  void app
    .getUpgradeHandler()(request, socket, head)
    .catch(() => socket.destroy());
});
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  await runtime.shutdown();
  // Dữ liệu/engine đã đóng trước; Next có thể còn socket phát triển giữ open.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<void>((done) => {
        timeout = setTimeout(done, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
try {
  await app.prepare();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(env.PORT, "127.0.0.1", done);
  });
  engine.startTimers();
  if (env.DATA_MODE === "real" && env.OBSERVATION_AUTO_START)
    void engine
      .setRunning(true)
      .catch(() =>
        logger.warn(
          { code: "OBSERVATION_SCANNER_START_FAILED" },
          "Chưa thể bật scanner; xem trạng thái RPC trên dashboard",
        ),
      );
  logger.info(
    {
      port: env.PORT,
      dataMode: env.DATA_MODE,
      tradingMode: env.TRADING_MODE,
      storage: env.STORAGE_DRIVER,
    },
    "Dashboard local đã mở; xem trạng thái sẵn sàng trước khi quét",
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
} catch {
  logger.error(
    { code: "LOCAL_STARTUP_FAILED" },
    "Không thể khởi động local; kiểm tra cấu hình và database",
  );
  await shutdown();
  process.exitCode = 1;
}
