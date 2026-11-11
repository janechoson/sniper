import {
  readFile,
  writeFile,
  rename,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { Position } from "./domain.js";

export const ACCOUNT_HOUR_MS = 3600000;
const DAY = 24 * ACCOUNT_HOUR_MS;
const KEEP = 31 * 24 + 1;
export interface AccountPoint {
  at: number;
  scheduledAt: number | null;
  walletLamports: string | null;
  positionLamports: string | null;
  totalLamports: string | null;
  positionCount: number;
  reason?: string;
}
interface HistoryData {
  version: "ACCOUNT_SOL_HISTORY_V1";
  scope: string;
  mode: string;
  baseline: AccountPoint | null;
  points: AccountPoint[];
}
export const atomicSol = (value: unknown): bigint | null =>
  typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;

/** Mark-to-market SOL of managed holdings, never principal/cost or dismissed rows. */
export function accountPositionValue(positions: Position[], now = Date.now()) {
  const held = positions.filter(
    (p) => !p.dismissal && !["CLOSED", "FAILED"].includes(p.state),
  );
  let value = 0n;
  for (const p of held) {
    const quantity = atomicSol(p.quantity),
      amount = atomicSol(p.lastValueLamports);
    if (
      p.state !== "OPEN" ||
      quantity === null ||
      quantity <= 0n ||
      amount === null ||
      !p.lastQuoteAt ||
      p.lastQuoteAt > now ||
      now - p.lastQuoteAt > 60000 ||
      p.valuationStatus === "ESTIMATED_AFTER_FILL" ||
      p.valuationStatus === "STALE" ||
      (p.valuationQuantity !== undefined && p.valuationQuantity !== p.quantity)
    )
      return {
        positionLamports: null,
        positionCount: held.length,
        reason: "POSITION_VALUE_UNAVAILABLE",
      };
    value += amount;
  }
  return { positionLamports: value.toString(), positionCount: held.length };
}

export class AccountBalanceHistory {
  private data: HistoryData;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private stopped = true;
  private error: string | null = null;
  private locked = false;
  constructor(
    private path: string,
    scope: string,
    mode: string,
    private observe: () => Promise<Omit<AccountPoint, "scheduledAt">>,
    private now: () => number = Date.now,
  ) {
    this.data = {
      version: "ACCOUNT_SOL_HISTORY_V1",
      scope,
      mode,
      baseline: null,
      points: [],
    };
  }
  async load() {
    try {
      const value = JSON.parse(
        await readFile(this.path, "utf8"),
      ) as HistoryData;
      if (
        value.version !== this.data.version ||
        value.scope !== this.data.scope ||
        value.mode !== this.data.mode ||
        !Array.isArray(value.points) ||
        value.points.length > KEEP ||
        value.points.some((p) => !this.valid(p)) ||
        (value.baseline && !this.valid(value.baseline))
      )
        throw Error("ACCOUNT_HISTORY_INVALID_OR_DIFFERENT_WALLET");
      this.data = value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private valid(p: AccountPoint) {
    if (
      !Number.isSafeInteger(p.at) ||
      p.at <= 0 ||
      !Number.isSafeInteger(p.positionCount) ||
      p.positionCount < 0 ||
      (p.scheduledAt !== null &&
        (!Number.isSafeInteger(p.scheduledAt) ||
          p.scheduledAt % ACCOUNT_HOUR_MS !== 0))
    )
      return false;
    if (p.totalLamports === null)
      return p.walletLamports === null && p.positionLamports === null;
    const w = atomicSol(p.walletLamports),
      v = atomicSol(p.positionLamports),
      t = atomicSol(p.totalLamports);
    return w !== null && v !== null && t !== null && w + v === t;
  }
  async capture(scheduledAt: number | null = null) {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      if (
        scheduledAt !== null &&
        this.data.points.some((p) => p.scheduledAt === scheduledAt)
      )
        return;
      let point: AccountPoint;
      try {
        const observation = await this.observe();
        point = { ...observation, scheduledAt };
        if (
          scheduledAt !== null &&
          (point.at < scheduledAt || point.at - scheduledAt > 60000)
        )
          throw Error("MISSED_HOUR_WINDOW");
        if (!this.valid(point)) throw Error("ACCOUNT_OBSERVATION_INVALID");
      } catch {
        point = {
          at: this.now(),
          scheduledAt,
          walletLamports: null,
          positionLamports: null,
          totalLamports: null,
          positionCount: 0,
          reason: "OBSERVATION_UNAVAILABLE",
        };
      }
      const next: HistoryData = {
        ...this.data,
        baseline:
          this.data.baseline ?? (point.totalLamports !== null ? point : null),
        points: [...this.data.points, point]
          .sort((a, b) => a.at - b.at)
          .slice(-KEEP),
      };
      try {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = this.path + ".tmp";
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, this.path);
        this.data = next;
        this.error = null;
      } catch {
        this.error = "ACCOUNT_HISTORY_WRITE_FAILED";
      }
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  async start() {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = this.path + ".lock";
    try {
      const pid = Number(await readFile(lockPath, "utf8"));
      if (!Number.isInteger(pid) || pid < 1)
        throw Error("ACCOUNT_HISTORY_INVALID_LOCK");
      try {
        process.kill(pid, 0);
        throw Error("ACCOUNT_HISTORY_ALREADY_RUNNING");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      await unlink(lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(String(process.pid));
    await lock.close();
    this.locked = true;
    try {
      await this.load();
    } catch (e) {
      await this.stop();
      throw e;
    }
    this.stopped = false;
    if (!this.data.baseline) await this.capture();
    this.schedule();
  }
  private schedule() {
    if (this.stopped) return;
    const slot =
      (Math.floor(this.now() / ACCOUNT_HOUR_MS) + 1) * ACCOUNT_HOUR_MS;
    this.timer = setTimeout(
      () => void this.capture(slot).finally(() => this.schedule()),
      Math.max(0, slot - this.now()),
    );
  }
  view() {
    // Bangkok UTC+7: anchor grid at an even local hour; 12 intervals of 2 hours.
    const offset = 7 * ACCOUNT_HOUR_MS;
    const currentEnd =
      Math.ceil((this.now() + offset) / (2 * ACCOUNT_HOUR_MS)) *
        (2 * ACCOUNT_HOUR_MS) -
      offset;
    const firstStart = this.data.baseline
      ? Math.floor((this.data.baseline.at + offset) / (2 * ACCOUNT_HOUR_MS)) *
          (2 * ACCOUNT_HOUR_MS) -
        offset
      : currentEnd - DAY;
    const endAt = Math.max(firstStart + DAY, currentEnd);
    const startAt = endAt - DAY;
    return {
      version: this.data.version,
      mode: this.data.mode,
      baseline: this.data.baseline,
      points: this.data.points.filter((p) => p.at >= startAt && p.at <= endAt),
      startAt,
      endAt,
      columns: 12,
      snapshotIntervalMs: ACCOUNT_HOUR_MS,
      error: this.error,
    };
  }
  unavailable(reason: string) {
    this.error = reason;
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    if (this.locked) {
      this.locked = false;
      await unlink(this.path + ".lock");
    }
  }
}
