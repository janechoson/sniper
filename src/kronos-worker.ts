import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kronosForecastSchema } from "./kronos-strategy.js";
import { setPriority, constants, freemem } from "node:os";
import { KRONOS, type LabCandle, type Forecast } from "./kronos-domain.js";
export function kronosWorkerEnvironment(
  runtime: string,
  systemRoot = "C:\\Windows",
): NodeJS.ProcessEnv {
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    HOME: runtime,
    USERPROFILE: runtime,
    APPDATA: runtime,
    LOCALAPPDATA: runtime,
    TEMP: join(runtime, "tmp"),
    TMP: join(runtime, "tmp"),
    KRONOS_RUNTIME: runtime,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHASHSEED: "1701",
    HF_HUB_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    OMP_NUM_THREADS: "2",
    MKL_NUM_THREADS: "2",
  };
}
/** One offline child and one request at a time. Timeout kills/reaps model worker. */
export class KronosWorker {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: {
    resolve: (v: Forecast) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private buffer = "";
  private stderr = "";
  private timeouts = 0;
  private latencies: number[] = [];
  private telemetry?: { loadMs: number; rssBytes: number };
  constructor(
    readonly runtime: string,
    readonly python = join(runtime, "venv", "Scripts", "python.exe"),
    readonly script = fileURLToPath(
      new URL("../lab/kronos/worker.py", import.meta.url),
    ),
    readonly systemRoot = "C:\\Windows",
  ) {}
  async forecast(candles: LabCandle[], decisionAt: number): Promise<Forecast> {
    if (this.pending) throw Error("KRONOS_WORKER_BUSY");
    if (freemem() < 1024 * 1024 * 1024) {
      this.stop();
      throw Error("KRONOS_RESOURCE_PRESSURE");
    }
    if (!this.child) {
      mkdirSync(join(this.runtime, "tmp"), { recursive: true });
      this.buffer = "";
      this.stderr = "";
      const child = spawn(this.python, ["-I", "-B", "-u", this.script], {
        cwd: this.runtime,
        env: kronosWorkerEnvironment(this.runtime, this.systemRoot),
        windowsHide: true,
        stdio: "pipe",
      });
      this.child = child;
      child.once("spawn", () => {
        try {
          if (child.pid)
            setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          /* Best effort; thread bound remains enforced. */
        }
      });
      child.stdout.on("data", (chunk) => {
        if (this.child !== child) return;
        this.buffer += String(chunk);
        if (this.buffer.length > 131072) {
          this.fail("KRONOS_OUTPUT_TOO_LARGE");
          return;
        }
        const at = this.buffer.indexOf("\n");
        if (at < 0) return;
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        const p = this.pending;
        if (!p) return;
        try {
          const data = JSON.parse(line);
          if (data.error) throw Error("KRONOS_INFERENCE_FAILED");
          if (!data.result || Object.keys(data).length !== 1)
            throw Error("KRONOS_INVALID_OUTPUT");
          const result = kronosForecastSchema.parse(data.result);
          this.pending = undefined;
          clearTimeout(p.timer);
          this.latencies.push(data.result.latencyMs);
          this.telemetry = {
            loadMs: data.result.loadMs,
            rssBytes: data.result.rssBytes,
          };
          this.latencies = this.latencies.slice(-100);
          p.resolve(result);
        } catch {
          this.fail("KRONOS_INVALID_OUTPUT");
        }
      });
      child.stderr.on("data", (x) => {
        this.stderr = (this.stderr + String(x)).slice(-2000);
      });
      child.on("error", () => this.fail("KRONOS_WORKER_START_FAILED"));
      child.on("exit", () => {
        if (this.child === child) {
          this.child = undefined;
          this.fail("KRONOS_WORKER_EXITED");
        }
      });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timeouts++;
        this.fail("KRONOS_TIMEOUT");
      }, KRONOS.forecastTimeoutMs);
      this.pending = { resolve, reject, timer };
      this.child!.stdin.write(
        JSON.stringify({
          candles: candles.map(({ at, open, high, low, close }) => ({
            at,
            open,
            high,
            low,
            close,
          })),
          decisionAt,
        }) + "\n",
      );
    });
  }
  private fail(reason: string) {
    const p = this.pending;
    this.pending = undefined;
    if (p) {
      clearTimeout(p.timer);
      p.reject(Error(reason));
    }
    const c = this.child;
    this.child = undefined;
    c?.kill();
  }
  status() {
    const xs = this.latencies.toSorted((a, b) => a - b);
    return {
      active: !!this.pending,
      loaded: !!this.child,
      timeouts: this.timeouts,
      ...this.telemetry,
      cpuThreads: 2,
      priority: "BELOW_NORMAL_BEST_EFFORT",
      memorySoftLimitBytes: 768 * 1024 * 1024,
      samples: xs.length,
      p50Ms: xs.length ? xs[Math.floor((xs.length - 1) * 0.5)] : null,
      p95Ms: xs.length >= 20 ? xs[Math.floor((xs.length - 1) * 0.95)] : null,
    };
  }
  stop() {
    this.fail("KRONOS_STOPPED");
  }
}
