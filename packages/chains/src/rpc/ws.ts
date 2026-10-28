import WebSocket from "ws";
import { z } from "zod";
import type { ProviderHealth, Unsubscribe } from "@sniper/core";
import { RpcFailure } from "./http";
interface Recipe {
  key: number;
  method: string;
  params: unknown[];
  notificationMethod: string;
  unsubscribeMethod: string;
  callback: (value: unknown) => Promise<void>;
  remoteId?: string | number;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
const frameSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  method: z.string().optional(),
  params: z
    .object({
      subscription: z.union([z.string(), z.number()]),
      result: z.unknown(),
    })
    .optional(),
});
export class RecoveringRpcSocket {
  private socket?: WebSocket;
  private stopped = false;
  private attempt = 0;
  private seq = 1;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastPong = 0;
  private pending = new Map<number, Pending>();
  private recipes = new Map<number, Recipe>();
  private ready?: Promise<void>;
  private lastReasons: string[] = ["WS_NOT_STARTED"];
  constructor(
    readonly id: string,
    private readonly url: string,
    private readonly timeoutMs = 7000,
    private readonly onGap: () => Promise<void> = async () => {},
  ) {
    if (!/^wss?:$/.test(new URL(url).protocol))
      throw new RpcFailure("WS_URL_PROTOCOL");
  }
  async connect(): Promise<void> {
    if (this.stopped) throw new RpcFailure("WS_CLOSED");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.ready) return this.ready;
    this.lastReasons = ["WS_NOT_CONNECTED"];
    this.ready = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        handshakeTimeout: this.timeoutMs,
        maxPayload: 8_000_000,
      });
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new RpcFailure("WS_TIMEOUT"));
      }, this.timeoutMs);
      socket.on("open", () => {
        clearTimeout(timer);
        this.ready = undefined;
        const recovering = this.attempt > 0;
        this.attempt = 0;
        this.lastReasons = [];
        this.lastPong = Date.now();
        socket.on("pong", () => {
          this.lastPong = Date.now();
        });
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastPong > 45000) socket.terminate();
          else socket.ping();
        }, 15000);
        void this.restore(recovering).then(resolve, (error) => {
          reject(error);
          socket.terminate();
        });
      });
      socket.on("message", (data) => {
        try {
          const frame = frameSchema.parse(JSON.parse(data.toString()));
          if (frame.id !== undefined) {
            const pending = this.pending.get(frame.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(frame.id);
              if (frame.error !== undefined) {
                this.lastReasons = ["WS_RPC_ERROR"];
                pending.reject(new RpcFailure("WS_RPC_ERROR"));
              } else pending.resolve(frame.result);
            }
            return;
          }
          if (frame.params) {
            for (const recipe of this.recipes.values())
              if (
                recipe.remoteId === frame.params.subscription &&
                recipe.notificationMethod === frame.method
              )
                void recipe.callback(frame.params.result).catch(() => {
                  this.lastReasons = ["SUBSCRIPTION_HANDLER_ERROR"];
                });
          }
        } catch {
          this.lastReasons = ["WS_INVALID_FRAME"];
        }
      });
      socket.on("error", () => {
        clearTimeout(timer);
        reject(new RpcFailure("WS_CONNECTION_ERROR"));
      });
      socket.on("close", () => {
        clearTimeout(timer);
        reject(new RpcFailure("WS_DISCONNECTED"));
        clearInterval(this.heartbeat);
        this.ready = undefined;
        this.lastReasons = ["WS_DISCONNECTED"];
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new RpcFailure("WS_DISCONNECTED"));
        }
        this.pending.clear();
        for (const recipe of this.recipes.values()) recipe.remoteId = undefined;
        if (!this.stopped) {
          const delay =
            Math.min(30000, 500 * 2 ** Math.min(this.attempt++, 6)) +
            Math.floor(Math.random() * 250);
          clearTimeout(this.reconnect);
          this.reconnect = setTimeout(() => {
            void this.connect().catch(() => undefined);
          }, delay);
        }
      });
    });
    return this.ready;
  }
  private call(method: string, params: unknown[]): Promise<unknown> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new RpcFailure("WS_NOT_CONNECTED"));
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.lastReasons = ["WS_RPC_TIMEOUT"];
        reject(new RpcFailure("WS_RPC_TIMEOUT"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  private async restore(recovering: boolean) {
    for (const recipe of this.recipes.values()) {
      const result = await this.call(recipe.method, recipe.params);
      recipe.remoteId = z.union([z.string(), z.number()]).parse(result);
    }
    if (recovering) await this.onGap();
  }
  async subscribe(
    method: string,
    params: unknown[],
    notificationMethod: string,
    unsubscribeMethod: string,
    callback: (value: unknown) => Promise<void>,
  ): Promise<Unsubscribe> {
    await this.connect();
    const key = this.seq++;
    const recipe: Recipe = {
      key,
      method,
      params,
      notificationMethod,
      unsubscribeMethod,
      callback,
    };
    this.recipes.set(key, recipe);
    try {
      recipe.remoteId = z
        .union([z.string(), z.number()])
        .parse(await this.call(method, params));
      this.lastReasons = [];
    } catch (error) {
      this.recipes.delete(key);
      throw error;
    }
    return async () => {
      this.recipes.delete(key);
      if (
        recipe.remoteId !== undefined &&
        this.socket?.readyState === WebSocket.OPEN
      )
        await this.call(unsubscribeMethod, [recipe.remoteId]).catch(
          () => undefined,
        );
    };
  }
  health(): ProviderHealth {
    return {
      id: this.id,
      status:
        !this.socket && !this.stopped
          ? "NOT_STARTED"
          : this.socket?.readyState === WebSocket.OPEN
            ? this.lastReasons.length ||
              ![...this.recipes.values()].some(
                (recipe) => recipe.remoteId !== undefined,
              )
              ? "DEGRADED"
              : "READY"
            : this.stopped
              ? "DOWN"
              : "DEGRADED",
      checkedAt: Date.now(),
      reasons: this.lastReasons.length
        ? [...this.lastReasons]
        : ![...this.recipes.values()].some(
              (recipe) => recipe.remoteId !== undefined,
            )
          ? ["WS_NO_SUBSCRIPTIONS"]
          : [],
    };
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RpcFailure("WS_CLOSED"));
    }
    this.pending.clear();
    this.recipes.clear();
    this.socket?.terminate();
  }
}
