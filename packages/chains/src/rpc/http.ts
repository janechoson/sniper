import { z } from "zod";
import type { ProviderHealth } from "@sniper/core";
export class RpcFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RpcFailure";
  }
}
interface Work {
  run: () => Promise<void>;
  reject: (error: unknown) => void;
}
export class RequestScheduler {
  private readonly queue: Work[] = [];
  private active = 0;
  private nextAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly requestsPerSecond = 5,
    private readonly concurrency = 4,
    private readonly capacity = 128,
  ) {}
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new RpcFailure("RPC_CLOSED"));
    if (this.queue.length >= this.capacity)
      return Promise.reject(new RpcFailure("RPC_QUEUE_FULL"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: async () => resolve(await operation()), reject });
      this.pump();
    });
  }
  private pump() {
    clearTimeout(this.timer);
    if (
      this.closed ||
      this.active >= this.concurrency ||
      this.queue.length === 0
    )
      return;
    const wait = this.nextAt - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => this.pump(), wait);
      return;
    }
    const job = this.queue.shift()!;
    this.active++;
    this.nextAt = Date.now() + Math.ceil(1000 / this.requestsPerSecond);
    void job
      .run()
      .catch(job.reject)
      .finally(() => {
        this.active--;
        this.pump();
      });
    if (this.queue.length)
      this.timer = setTimeout(
        () => this.pump(),
        Math.ceil(1000 / this.requestsPerSecond),
      );
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const job of this.queue.splice(0))
      job.reject(new RpcFailure("RPC_CLOSED"));
  }
  get depth() {
    return this.queue.length + this.active;
  }
}
export async function readJsonLimited(
  response: Response,
  limit = 8_000_000,
): Promise<unknown> {
  if (!response.body) throw new RpcFailure("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new RpcFailure("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    const all = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(all));
    } catch {
      throw new RpcFailure("INVALID_JSON_RESPONSE");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export class ResilientHttp {
  private failures = 0;
  private lastReason: string[] = [];
  private readonly abort = new AbortController();
  constructor(
    readonly id: string,
    private readonly scheduler = new RequestScheduler(),
    private readonly timeoutMs = 7000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async json(
    url: string,
    init: RequestInit = {},
    attempts = 3,
  ): Promise<unknown> {
    return this.scheduler.run(async () => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        let retryAfter = 0;
        try {
          const response = await this.fetcher(url, {
            ...init,
            signal: AbortSignal.any([
              this.abort.signal,
              AbortSignal.timeout(this.timeoutMs),
            ]),
            redirect: "error",
          });
          if (!response.ok) {
            const retryable = response.status === 429 || response.status >= 500;
            const value = response.headers.get("retry-after");
            if (value) {
              const seconds = Number(value);
              retryAfter = Number.isFinite(seconds)
                ? seconds * 1000
                : Math.max(0, Date.parse(value) - Date.now());
            }
            await response.body?.cancel();
            if (!retryable) throw new RpcFailure(`HTTP_${response.status}`);
            if (attempt === attempts - 1)
              throw new RpcFailure(
                response.status === 429 ? "RPC_RATE_LIMITED" : "PROVIDER_DOWN",
              );
          } else {
            const result = await readJsonLimited(response);
            this.failures = 0;
            this.lastReason = [];
            return result;
          }
        } catch (error) {
          if (this.abort.signal.aborted) throw new RpcFailure("RPC_CLOSED");
          if (
            error instanceof RpcFailure &&
            /^HTTP_4(?!29)/.test(error.reason)
          ) {
            this.failures++;
            this.lastReason = [error.reason];
            throw error;
          }
          if (attempt === attempts - 1) {
            this.failures++;
            this.lastReason = [
              error instanceof RpcFailure
                ? error.reason
                : "RPC_TIMEOUT_OR_NETWORK",
            ];
            throw new RpcFailure(this.lastReason[0]!);
          }
        }
        const delay = Math.min(
          30000,
          Math.max(retryAfter, 400 * 2 ** attempt) +
            Math.floor(Math.random() * 200),
        );
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          const stop = () => {
            clearTimeout(timer);
            reject(new RpcFailure("RPC_CLOSED"));
          };
          this.abort.signal.addEventListener("abort", stop, { once: true });
          setTimeout(
            () => this.abort.signal.removeEventListener("abort", stop),
            delay,
          );
        });
      }
      throw new RpcFailure("PROVIDER_DOWN");
    });
  }
  health(): ProviderHealth {
    return {
      id: this.id,
      status:
        this.failures >= 3 ||
        this.lastReason.some(
          (reason) => reason === "HTTP_401" || reason === "HTTP_403",
        )
          ? "DOWN"
          : this.failures > 0
            ? "DEGRADED"
            : "READY",
      checkedAt: Date.now(),
      reasons: [...this.lastReason],
    };
  }
  close() {
    this.abort.abort();
    this.scheduler.close();
  }
}
const envelope = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().int(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string().optional() })
    .optional(),
});
export class JsonRpcClient {
  private readonly readOnly: boolean;
  private nextId = 1;
  private readonly startedAt = Date.now();
  private requests = 0;
  private failures = 0;
  private latency = 0;
  private readonly scheduler: RequestScheduler;
  readonly http: ResilientHttp;
  constructor(
    readonly id: string,
    private readonly url: string,
    options: {
      timeoutMs?: number;
      rps?: number;
      concurrency?: number;
      fetcher?: typeof fetch;
      readOnly?: boolean;
    } = {},
  ) {
    this.readOnly = options.readOnly ?? false;
    if (!/^https?:$/.test(new URL(url).protocol))
      throw new RpcFailure("RPC_URL_PROTOCOL");
    this.scheduler = new RequestScheduler(
      options.rps ?? 5,
      options.concurrency ?? 4,
    );
    this.http = new ResilientHttp(
      id,
      this.scheduler,
      options.timeoutMs ?? 7000,
      options.fetcher,
    );
  }
  async request<T>(
    method: string,
    params: unknown[],
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (
      this.readOnly &&
      !/^(eth_(chainId|get[A-Z].*|call|estimateGas|gasPrice|blockNumber|simulateV1|maxPriorityFeePerGas|feeHistory)|net_version|web3_clientVersion|get[A-Z].*|simulateTransaction)$/.test(
        method,
      )
    )
      throw new RpcFailure("DRY_RUN_RPC_METHOD_FORBIDDEN");
    const started = Date.now();
    this.requests++;
    try {
      const id = this.nextId++;
      const response = envelope.parse(
        await this.http.json(
          this.url,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          },
          [
            "eth_sendRawTransaction",
            "eth_sendTransaction",
            "sendTransaction",
          ].includes(method)
            ? 1
            : 3,
        ),
      );
      if (response.id !== id) throw new RpcFailure("RPC_RESPONSE_ID_MISMATCH");
      if (response.error)
        throw new RpcFailure(`RPC_CODE_${response.error.code}`);
      return schema.parse(response.result);
    } catch (error) {
      this.failures++;
      throw error;
    } finally {
      this.latency += Date.now() - started;
    }
  }
  stats() {
    return {
      requests: this.requests,
      failures: this.failures,
      requestsPerSecond:
        this.requests / Math.max(1, (Date.now() - this.startedAt) / 1000),
      averageLatencyMs: this.requests ? this.latency / this.requests : 0,
      queueDepth: this.scheduler.depth,
    };
  }
  close() {
    this.http.close();
  }
}
