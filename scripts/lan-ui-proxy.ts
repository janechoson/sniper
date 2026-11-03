import { createServer, request, type Server } from "node:http";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function privateAddress(address: string) {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
  );
}

// The trading server stays on loopback. This process only forwards UI traffic.
// Host and Origin are checked before translating them to the backend origin;
// the backend still checks the original browser's CSRF token and JSON body.
export function createLanUiProxy(address: string, upstreamPort = 3000): Server {
  if (!privateAddress(address)) throw Error("LAN_PRIVATE_IPV4_REQUIRED");
  if (
    !Number.isInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65535
  )
    throw Error("INVALID_UPSTREAM_PORT");
  const server = createServer((incoming, outgoing) => {
    const bound = server.address();
    if (!bound || typeof bound === "string") {
      outgoing.writeHead(503).end();
      return;
    }
    const host = `${address}:${bound.port}`;
    const origin = `http://${host}`;
    const fail = (status: number, error: string) => {
      outgoing.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      outgoing.end(JSON.stringify({ error }));
    };
    if (incoming.headers.host !== host) return fail(403, "HOST_DENIED");
    if (!["GET", "HEAD", "POST"].includes(incoming.method ?? ""))
      return fail(405, "METHOD_DENIED");
    if (
      (incoming.headers.origin !== undefined &&
        incoming.headers.origin !== origin) ||
      (incoming.method === "POST" && incoming.headers.origin !== origin)
    )
      return fail(403, "LAN_ORIGIN_REQUIRED");
    if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//"))
      return fail(400, "INVALID_REQUEST_TARGET");

    const headers = {
      ...incoming.headers,
      host: `127.0.0.1:${upstreamPort}`,
      connection: "close",
    };
    if (headers.origin !== undefined)
      headers.origin = `http://127.0.0.1:${upstreamPort}`;
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.on("error", () => outgoing.destroy());
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) fail(502, "LOCAL_UI_UNAVAILABLE");
      else outgoing.destroy();
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  return server;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const address = process.argv[2] ?? "";
  const available = Object.values(networkInterfaces())
    .flat()
    .some((nic) => nic?.address === address && !nic.internal);
  if (!available || !privateAddress(address)) {
    console.error("Usage: tsx scripts/lan-ui-proxy.ts <local-private-IPv4>");
    process.exitCode = 1;
  } else {
    const server = createLanUiProxy(address);
    server.once("error", (error: NodeJS.ErrnoException) => {
      console.error(`LAN UI failed: ${error.code ?? "LISTEN_FAILED"}`);
      process.exitCode = 1;
    });
    server.listen(3000, address, () => {
      console.log(`LAN UI: http://${address}:3000 -> http://127.0.0.1:3000`);
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        server.close();
        server.closeAllConnections();
      });
  }
}
