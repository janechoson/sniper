import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createLanUiProxy } from "../scripts/lan-ui-proxy.js";

// Use raw HTTP so adversarial Host values are actually sent on the wire.
function fetch(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string | undefined>;
  } = {},
) {
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, options, (res) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      resolve(
        new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
          status: res.statusCode,
          headers,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("LAN UI rejects public/wildcard addresses", () => {
  for (const address of ["0.0.0.0", "8.8.8.8", "127.0.0.1", "example.com"])
    assert.throws(() => createLanUiProxy(address), /LAN_PRIVATE_IPV4_REQUIRED/);
});

test("LAN UI forwards assets/status, preserves CSRF, rejects foreign Host/Origin and streams SSE", async () => {
  let reads = 0,
    mutations = 0;
  const backend = createServer((req, res) => {
    assert.equal(req.headers.host, `127.0.0.1:${backendPort}`);
    if (req.method === "POST") {
      assert.equal(req.headers.origin, `http://127.0.0.1:${backendPort}`);
      if (req.headers["x-csrf-token"] !== "fixture-csrf") {
        res.writeHead(403).end("CSRF_REQUIRED");
        return;
      }
      mutations++;
      res.end("ok");
    } else if (req.url === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"ready":true}\n\n');
    } else {
      reads++;
      res.setHeader("Content-Security-Policy", "default-src 'self'");
      res.end(req.url === "/api/status" ? '{"csrf":"fixture-csrf"}' : "asset");
    }
  });
  const backendPort = await listen(backend);
  const proxy = createLanUiProxy("192.168.1.66", backendPort);
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}`;
  const host = `192.168.1.66:${port}`;
  const origin = `http://${host}`;
  try {
    const status = await fetch(base + "/api/status", { headers: { host } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).csrf, "fixture-csrf");
    const asset = await fetch(base + "/app.js", { headers: { host } });
    assert.equal(await asset.text(), "asset");
    assert.equal(
      asset.headers.get("content-security-policy"),
      "default-src 'self'",
    );
    for (const headers of [
      { host: "evil.example", origin },
      { host, origin: "http://evil.example" },
      { host, origin: `http://127.0.0.1:${backendPort}` },
      { host },
    ]) {
      const denied = await fetch(base + "/api/fixture", {
        method: "POST",
        headers,
      });
      assert.equal(denied.status, 403);
      await denied.text();
    }
    const noToken = await fetch(base + "/api/fixture", {
      method: "POST",
      headers: { host, origin },
    });
    assert.equal(noToken.status, 403);
    assert.equal(await noToken.text(), "CSRF_REQUIRED");
    assert.equal(mutations, 0);
    const accepted = await fetch(base + "/api/fixture", {
      method: "POST",
      headers: { host, origin, "x-csrf-token": "fixture-csrf" },
    });
    assert.equal(await accepted.text(), "ok");
    assert.equal(mutations, 1);
    assert.equal(reads, 2);
    const stream = await fetch(base + "/api/events", { headers: { host } });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const reader = stream.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /ready/,
    );
    await reader.cancel();
  } finally {
    await close(proxy);
    await close(backend);
  }
});

test("LAN UI reports backend unavailable without changing backend state", async () => {
  const unused = createServer();
  const upstreamPort = await listen(unused);
  await close(unused);
  const proxy = createLanUiProxy("192.168.1.66", upstreamPort);
  const port = await listen(proxy);
  try {
    const result = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { host: `192.168.1.66:${port}` },
    });
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: "LOCAL_UI_UNAVAILABLE" });
  } finally {
    await close(proxy);
  }
});
