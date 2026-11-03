// Standalone entrypoint: launch only with scripts/kronos-env.mjs preload.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setPriority, constants } from "node:os";
import { KronosStore } from "./kronos-store.js";
import { KronosWorker } from "./kronos-worker.js";
import { KronosLab } from "./kronos-lab.js";
import { TOKEN_IMAGE_CSP } from "./token-metadata.js";
if (
  process.env.KRONOS_SAFE_PRELOAD !== "1" ||
  process.env.TRADING_MODE !== "paper" ||
  process.env.LIVE_TRADING_ACK !== "false"
)
  throw Error("KRONOS_SAFE_PRELOAD_REQUIRED");
// Only now may transitive production parsers import config.ts. Accidental launch
// without preload must fail before any credential-reading module is evaluated.
const { KronosMarket } = await import("./kronos-market.js");
try {
  setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  /* Best effort only. */
}
const runtime = resolve(
  process.env.KRONOS_RUNTIME ??
    join(process.env.LOCALAPPDATA ?? ".", "gmgn-kronos-runtime"),
);
if (runtime.toLowerCase().startsWith(resolve(".").toLowerCase()))
  throw Error("KRONOS_RUNTIME_MUST_BE_OUTSIDE_WORKSPACE");
mkdirSync(runtime, { recursive: true });
const lock = join(runtime, "lab.lock");
const fd = openSync(lock, "wx");
writeFileSync(fd, String(process.pid));
closeSync(fd);
const store = new KronosStore(join(runtime, "paper-lab.sqlite"));
const market = new KronosMarket(
  process.env.KRONOS_GMGN_API_KEY ?? "",
  process.env.KRONOS_RPC_URL,
  Number(process.env.KRONOS_BOT_PORT ?? 3000),
);
const inference = new KronosWorker(runtime),
  lab = new KronosLab(store, market, inference),
  csrf = randomBytes(32).toString("hex");
const server = createServer(async (req, res) => {
  const reply = (code: number, value: unknown) => {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
  };
  if (req.headers.host !== "127.0.0.1:8792")
    return reply(403, { error: "HOST_DENIED" });
  try {
    if (
      req.method === "GET" &&
      ["/", "/style.css", "/kronos.js", "/token-avatar.js"].includes(
        req.url ?? "",
      )
    ) {
      const file =
        req.url === "/" ? "kronos-standalone.html" : req.url!.slice(1);
      res.writeHead(200, {
        "Content-Type": file.endsWith(".html")
          ? "text/html"
          : file.endsWith(".css")
            ? "text/css"
            : "text/javascript",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src ${TOKEN_IMAGE_CSP}; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(readFileSync(resolve("public", file)));
    }
    if (req.method === "GET" && req.url === "/api/status")
      return reply(200, { csrf });
    if (
      req.method === "GET" &&
      ["/state", "/api/kronos"].includes(req.url ?? "")
    )
      return reply(200, { ...lab.status(), market: market.status(), csrf });
    const standalone = req.url === "/api/kronos/control";
    if (
      req.method !== "POST" ||
      !["/control", "/api/kronos/control"].includes(req.url ?? "") ||
      req.headers.origin !== "http://127.0.0.1:8792" ||
      (standalone
        ? req.headers["x-csrf-token"]
        : req.headers["x-kronos-csrf"]) !== csrf ||
      !req.headers["content-type"]?.startsWith("application/json")
    )
      return reply(403, { error: "LOCAL_CSRF_REQUIRED" });
    let input = "";
    for await (const c of req) {
      input += c;
      if (input.length > 2048) throw Error("BODY_TOO_LARGE");
    }
    const data = JSON.parse(input);
    if (standalone && data.csrf !== csrf)
      return reply(403, { error: "LOCAL_CSRF_REQUIRED" });
    if (data.action === "enable") lab.setEnabled(true);
    else if (data.action === "pause") lab.setEnabled(false);
    else if (data.action === "reset") lab.reset(data.confirmation);
    else if (data.action === "detail" && typeof data.id === "string")
      return reply(200, { decisions: store.decisions(data.id) });
    else throw Error("ACTION_DENIED");
    reply(200, { ok: true });
  } catch (e) {
    reply(400, { error: e instanceof Error ? e.message : "LAB_FAILED" });
  }
});
server.listen(8792, "127.0.0.1", () =>
  console.log("Kronos PAPER ONLY lab:127.0.0.1:8792; collection PAUSED"),
);
const timer = setInterval(() => {
  void lab.tick().catch(() => {});
}, 1000);
async function stop() {
  clearInterval(timer);
  await lab.stop();
  server.close();
  store.close();
  unlinkSync(lock);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
