import { randomUUID } from "node:crypto";
export * from "./real";
import { z } from "zod";
import {
  EventBus,
  type AIProvider,
  type CandidateRecord,
  type ChainAdapter,
  type ChainConfig,
  type DashboardSnapshot,
  type DomainEvent,
  type OutcomeRecord,
  type Position,
  type TokenDiscoveryEvent,
} from "@sniper/core";
import {
  defaultSettings,
  settingsSchema,
  experimentalChainOverrides,
} from "@sniper/config";
import { MockAIProvider, safeClassify } from "@sniper/ai";
import { MockChainAdapter } from "@sniper/chains";
import {
  DiscoveryCoordinator,
  mockDiscoveryEvent,
} from "@sniper/chains/discovery";
import {
  createFeatureEngine,
  MockFeatureSource,
  type FeatureEngine,
} from "@sniper/features";
import { MockDexAdapter } from "@sniper/dex";
import { PaperExecutor, type Executor } from "@sniper/execution";
import { RouteEngine } from "@sniper/routing";
import { PositionManager } from "@sniper/positions";
import { assessEntry, hardFilter, KillSwitch } from "@sniper/risk";

import type { Repository, JournalEntry } from "@sniper/storage";
import { createLogger } from "@sniper/shared";
import { BoundedQueue, SerialQueue } from "./queue";
import { MockMarketBook } from "./markets";
import { candidateSchema, outcomeSchema, positionSchema } from "./schemas";
import { analyzeCandidate } from "./analyzer";
import { observeOutcome } from "./outcomes";
import { monitorPosition } from "./position-monitor";

const domainEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.number(),
  chainId: z.string().optional(),
  tokenAddress: z.string().optional(),
  positionId: z.string().optional(),
  data: z.unknown(),
});
const commitSchema = z
  .object({
    candidate: candidateSchema.optional(),
    positions: z.array(positionSchema).optional(),
    settings: z
      .preprocess((value) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const settings = { ...(value as Record<string, unknown>) };
          delete settings.activeWalletByChain;
          return settings;
        }
        return value;
      }, settingsSchema)
      .optional(),
    kill: z.array(z.string()).optional(),
    outcomes: z.array(outcomeSchema).optional(),
    day: z.string().optional(),
    dayStartPnl: z.number().finite().optional(),
    failures: z.number().int().nonnegative().optional(),
    tradeAt: z.number().optional(),
    events: z.array(domainEventSchema).optional(),
    event: z
      .object({
        id: z.string(),
        type: z.string(),
        timestamp: z.number(),
        chainId: z.string().optional(),
        tokenAddress: z.string().optional(),
        positionId: z.string().optional(),
        data: z.unknown(),
      })
      .transform((event) => ({ ...event, data: event.data }))
      .optional(),
  })
  .strict();
type Commit = z.infer<typeof commitSchema>;
export interface EngineOptions {
  repository: Repository;
  chains: ChainConfig[];
  adapters?: Map<string, ChainAdapter>;
  features?: FeatureEngine;
  ai?: AIProvider;
  executor?: Executor;
  routes?: RouteEngine;
  now?: () => number;
  logLevel?: string;
}
export class PaperEngine {
  readonly bus = new EventBus(() =>
    this.logger.warn(
      { code: "EVENT_DELIVERY_ERROR" },
      "Bên nhận sự kiện gặp lỗi",
    ),
  );
  readonly killSwitch = new KillSwitch();
  readonly positions = new PositionManager();
  readonly markets = new MockMarketBook();
  private settings = defaultSettings();
  private readonly commits = new SerialQueue();
  private readonly ingestion = new BoundedQueue();
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly candidates: CandidateRecord[] = [];
  private readonly events: DomainEvent[] = [];
  private readonly outcomes = new Map<string, OutcomeRecord>();
  private readonly trades: number[] = [];
  private readonly adapters: Map<string, ChainAdapter>;
  private readonly discovery: DiscoveryCoordinator;
  private readonly features: FeatureEngine;
  private readonly ai: AIProvider;
  private readonly executor: Executor;
  private readonly routes: RouteEngine;
  private readonly now: () => number;
  private readonly logger: ReturnType<typeof createLogger>;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private running = false;
  private closing = false;
  private generation = 0;
  private index = 0;
  private lastDiscovery = 0;
  private aiCalls = 0;
  private failures = 0;
  private day = "";
  private dayStartPnl = 0;
  private dbHealthy = true;
  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? Date.now;
    this.logger = createLogger(options.logLevel ?? "info");
    this.adapters =
      options.adapters ??
      new Map(
        options.chains
          .filter((c) => c.enabled)
          .map((c) => [c.id, new MockChainAdapter(c)]),
      );
    this.discovery = new DiscoveryCoordinator(this.adapters);
    this.features =
      options.features ?? createFeatureEngine(new MockFeatureSource());
    this.ai = options.ai ?? new MockAIProvider();
    this.executor = options.executor ?? new PaperExecutor();
    this.routes =
      options.routes ??
      new RouteEngine(
        options.chains.map(
          (c) =>
            new MockDexAdapter(
              c.id,
              (address) => this.markets.quoteMarket(c.id, address, this.now()),
              this.now,
            ),
        ),
        this.now,
      );
  }
  private event(
    type: string,
    data: unknown,
    context: Partial<
      Pick<DomainEvent, "chainId" | "tokenAddress" | "positionId">
    > = {},
  ): DomainEvent {
    return { id: randomUUID(), type, timestamp: this.now(), data, ...context };
  }
  private emit(event: DomainEvent) {
    this.events.unshift(event);
    this.events.splice(200);
    this.bus.publish(event);
  }
  private apply(commit: Commit) {
    if (commit.settings) this.settings = commit.settings;
    if (commit.positions)
      for (const position of commit.positions) this.positions.put(position);
    if (commit.candidate) {
      this.candidates.unshift(commit.candidate);
      this.seen.add(
        `${commit.candidate.event.chainId}/${commit.candidate.event.poolAddress}`,
      );
      if (commit.candidate.state) this.markets.register(commit.candidate.state);
      if (commit.candidate.aiAttempted ?? !!commit.candidate.ai) this.aiCalls++;
    }
    if (commit.outcomes)
      for (const outcome of commit.outcomes)
        this.outcomes.set(outcome.candidateId, outcome);
    if (commit.kill) this.killSwitch.restore(commit.kill);
    if (commit.tradeAt !== undefined) this.trades.push(commit.tradeAt);
    if (commit.failures !== undefined) this.failures = commit.failures;
    if (commit.day !== undefined) this.day = commit.day;
    if (commit.dayStartPnl !== undefined) this.dayStartPnl = commit.dayStartPnl;
  }
  private async persist(input: Commit) {
    const commit = commitSchema.parse(input);
    const entry: JournalEntry = {
      id: randomUUID(),
      kind: "commit",
      chainId: commit.candidate?.event.chainId ?? commit.event?.chainId,
      tokenAddress:
        commit.candidate?.event.tokenAddress ?? commit.event?.tokenAddress,
      payload: commit,
      createdAt: this.now(),
    };
    try {
      await this.options.repository.append(entry);
      this.apply(commit);
      this.dbHealthy = true;
      if (commit.event) this.emit(commit.event);
      for (const event of commit.events ?? []) this.emit(event);
    } catch (error) {
      this.dbHealthy = false;
      this.killSwitch.trip("DATABASE_INTEGRITY");
      this.emit(
        this.event("kill_switch", {
          reasons: this.killSwitch.snapshot().reasons,
        }),
      );
      this.logger.error(
        { code: "DATABASE_ERROR" },
        "Ghi nhật ký thất bại; đã chặn lệnh mới",
      );
      throw error;
    }
  }
  async initialize() {
    const entries = await this.options.repository.read();
    for (const entry of entries) {
      if (entry.kind !== "commit")
        throw new Error("Bản ghi nhật ký không được hỗ trợ");
      const commit = commitSchema.parse(entry.payload);
      this.apply(commit);
      if (commit.event) {
        this.events.unshift(commit.event);
        this.events.splice(200);
      }
      for (const event of commit.events ?? []) {
        this.events.unshift(event);
        this.events.splice(200);
      }
    }
    this.index =
      this.candidates.reduce(
        (max, c) =>
          Math.max(max, Number(c.event.tokenAddress.split(":").at(-1)) || 0),
        0,
      ) + 1;
    if (
      !this.options.chains.some(
        (c) => c.id === this.settings.activeChain && c.enabled,
      )
    ) {
      const chain = this.options.chains.find((c) => c.enabled);
      if (!chain) throw new Error("Chưa bật chuỗi nào");
      this.settings = settingsSchema.parse({
        ...this.settings,
        activeChain: chain.id,
      });
    }
    await this.discovery.switchTo(this.settings.activeChain);
    await this.commits.run(() => this.rollDay());
    this.dbHealthy = await this.options.repository.health();
    if (!this.dbHealthy)
      throw new Error("Cơ sở dữ liệu không hoạt động ổn định");
  }
  private totalPnl() {
    return this.positions
      .all()
      .reduce((sum, p) => sum + p.realizedPnlUsd + p.unrealizedPnlUsd, 0);
  }
  private dailyPnl() {
    return this.totalPnl() - this.dayStartPnl;
  }
  private dailyTrades() {
    return this.trades.filter(
      (time) => new Date(time).toISOString().slice(0, 10) === this.day,
    ).length;
  }
  private async rollDay() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day)
      await this.persist({ day, dayStartPnl: this.totalPnl() });
  }
  private policy(chainId: string) {
    return settingsSchema.parse({
      ...this.settings,
      ...experimentalChainOverrides[chainId],
      minLiquidityUsd: Math.max(
        this.settings.minLiquidityUsd,
        experimentalChainOverrides[chainId]?.minLiquidityUsd ?? 0,
      ),
    });
  }
  getSettings() {
    return structuredClone(this.settings);
  }
  async updateSettings(input: unknown) {
    return this.commits.run(async () => {
      const patch = z.record(z.string(), z.unknown()).parse(input);
      const settings = settingsSchema.parse({ ...this.settings, ...patch });
      if (
        !this.options.chains.some(
          (c) => c.id === settings.activeChain && c.enabled,
        )
      )
        throw new Error("CHAIN_DISABLED");
      this.generation++;
      if (settings.activeChain !== this.settings.activeChain) {
        await this.discovery.switchTo(settings.activeChain);
      }
      await this.persist({
        settings,
        event: this.event("settings_updated", {
          activeChain: settings.activeChain,
          strategy: settings.strategy,
        }),
      });
      return this.getSettings();
    });
  }
  async setRunning(running: boolean) {
    return this.commits.run(async () => {
      this.running = running;
      this.generation++;
      if (running) await this.discovery.switchTo(this.settings.activeChain);
      else this.discovery.pause();
      this.emit(this.event(running ? "scanner_started" : "scanner_paused", {}));
    });
  }
  async setKillSwitch(active: boolean) {
    return this.commits.run(async () => {
      if (active) this.killSwitch.trip("MANUAL");
      else {
        const probe = this.candidates.find(
          (c) => c.hardFilter?.passed && c.state,
        )?.state;
        const aiHealthy =
          !this.killSwitch.snapshot().reasons.includes("AI_UNAVAILABLE") ||
          (probe !== undefined &&
            (await safeClassify(this.ai, probe)) !== undefined);
        const healthy =
          aiHealthy &&
          this.dbHealthy &&
          (await this.options.repository.health()) &&
          this.dailyPnl() > -this.settings.maxDailyLossUsd &&
          (await this.adapters.get(this.settings.activeChain)?.healthCheck())
            ?.status === "healthy";
        if (!healthy)
          throw new Error("Các kiểm tra an toàn bắt buộc chưa khôi phục");
        if (this.failures > 0) {
          if (!probe)
            throw new Error(
              "Cần token đủ điều kiện để kiểm tra khả năng khôi phục báo giá",
            );
          await this.routes.roundTrip(
            {
              chainId: probe.identity.chainId,
              tokenAddress: probe.identity.address,
              side: "BUY",
              amount: this.settings.tradeSizeUsd,
              slippageBps: 50,
            },
            this.settings.maxPriceImpactPct,
          );
          this.failures = 0;
        }
        this.killSwitch.reset(true);
      }
      await this.persist({
        kill: this.killSwitch.snapshot().reasons,
        failures: this.failures,
        event: this.event("kill_switch", this.killSwitch.snapshot()),
      });
    });
  }
  async ingest(event: TokenDiscoveryEvent): Promise<void> {
    const key = `${event.chainId}/${event.poolAddress}`;
    if (this.seen.has(key) || this.inFlight.has(key) || this.closing) return;
    if (
      event.source !== "MOCK" ||
      !event.tokenAddress.startsWith("mock:") ||
      !event.poolAddress.startsWith("mock:")
    )
      throw new Error(
        "Phiên bản V1 chỉ hỗ trợ sự kiện được đánh dấu giả lập rõ ràng",
      );
    this.inFlight.add(key);
    const generation = this.generation;
    this.emit(
      this.event("token_detected", event, {
        chainId: event.chainId,
        tokenAddress: event.tokenAddress,
      }),
    );
    try {
      await this.ingestion.submit(async () => {
        this.emit(
          this.event(
            "analysis_running",
            {},
            { chainId: event.chainId, tokenAddress: event.tokenAddress },
          ),
        );
        const record = await analyzeCandidate(
          event,
          this.features,
          this.ai,
          this.policy(event.chainId),
          this.now(),
        );
        if (record.state) this.markets.register(record.state);
        await this.commits.run(() => this.finishCandidate(record, generation));
      });
    } finally {
      this.inFlight.delete(key);
    }
  }
  private portfolio() {
    return {
      positions: this.positions.all(),
      dailyTrades: this.dailyTrades(),
      dailyPnlUsd: this.dailyPnl(),
      consecutiveFailures: this.failures,
      killSwitchActive: this.killSwitch.snapshot().active,
    };
  }
  private async finishCandidate(record: CandidateRecord, generation: number) {
    await this.rollDay();
    const state = record.state;
    let position: Position | undefined;
    if (record.reasons.includes("AI_UNAVAILABLE"))
      this.killSwitch.trip("AI_UNAVAILABLE");
    if (state && record.strategy?.action === "BUY") {
      const settings = this.policy(record.event.chainId);
      record.hardFilter = hardFilter(state, settings);
      if (!record.hardFilter.passed) {
        record.action = "REJECT";
        record.reasons = record.hardFilter.reasons;
      } else if (this.now() - state.observedAt > 15000) {
        record.reasons = ["STALE_FEATURES"];
      } else if (
        generation !== this.generation ||
        !this.running ||
        !this.discovery.accepting(record.event.chainId)
      ) {
        record.reasons = ["DISCOVERY_CHANGED"];
      } else {
        record.risk = assessEntry(
          state,
          record.score!.total,
          settings,
          this.portfolio(),
        );
        record.reasons = record.risk.reasons;
        if (record.risk.passed) {
          try {
            const roundTrip = await this.routes.roundTrip(
              {
                chainId: state.identity.chainId,
                tokenAddress: state.identity.address,
                side: "BUY",
                amount: settings.tradeSizeUsd,
                slippageBps: 50,
              },
              settings.maxPriceImpactPct,
            );
            record.quote = roundTrip.buy;
            record.simulation = {
              buy: roundTrip.buySimulation,
              sell: roundTrip.sellSimulation,
              sellQuote: roundTrip.sell,
            };
            record.risk = assessEntry(
              state,
              record.score!.total,
              settings,
              this.portfolio(),
              roundTrip.buy,
            );
            record.reasons = record.risk.reasons;
            if (record.risk.passed) {
              position = await this.executor.open({
                state,
                quote: roundTrip.buy,
                receivedQuantity: roundTrip.buySimulation.receivedAmount!,
                now: this.now(),
              });
              record.action = "BUY";
              record.reasons = ["PAPER_FILL"];
              this.failures = 0;
            }
          } catch {
            record.action = "SKIP";
            record.reasons = ["ROUTE_OR_SIMULATION_FAILURE"];
            this.failures++;
            if (this.failures >= settings.maxFailedTransactions)
              this.killSwitch.trip("FAILED_TRANSACTIONS");
          }
        }
      }
    }
    const outcome: OutcomeRecord = {
      candidateId: record.id,
      chainId: record.event.chainId,
      tokenAddress: record.event.tokenAddress,
      createdAt: record.createdAt,
      initialPriceUsd: state?.market.priceUsd,
      initialLiquidityUsd: state?.market.liquidityUsd,
      prices: {},
      completedHorizons: [],
      maxGainPct: state?.market.priceUsd !== undefined ? 0 : undefined,
      maxDrawdownPct: state?.market.priceUsd !== undefined ? 0 : undefined,
    };
    const event = this.event(
      record.action === "BUY"
        ? "paper_buy"
        : record.action === "REJECT"
          ? "rejected"
          : "candidate",
      {
        candidateId: record.id,
        action: record.action,
        reasons: record.reasons,
      },
      {
        chainId: record.event.chainId,
        tokenAddress: record.event.tokenAddress,
        positionId: position?.id,
      },
    );
    await this.persist({
      candidate: record,
      positions: position ? [position] : undefined,
      tradeAt: position ? this.now() : undefined,
      outcomes: [outcome],
      failures: this.failures,
      kill: this.killSwitch.snapshot().reasons,
      event,
    });
    this.logger.info(
      {
        chainId: record.event.chainId,
        tokenAddress: record.event.tokenAddress,
        poolAddress: record.event.poolAddress,
        dexId: record.event.dexId,
        strategyId: record.strategy?.strategyId,
        runId: record.id,
        positionId: position?.id,
        action: record.action,
      },
      "Đã lưu quyết định phân tích token",
    );
  }
  async monitor() {
    return this.commits.run(async () => {
      await this.rollDay();
      const now = this.now();
      const updates: Position[] = [];
      const positionEvents: DomainEvent[] = [];
      for (const position of this.positions.open()) {
        const state = this.markets.state(
          position.chainId,
          position.tokenAddress,
          now,
        );
        if (state?.market.priceUsd === undefined) continue;
        const update = await monitorPosition(
          position,
          state,
          this.policy(position.chainId),
          now,
          this.routes,
          this.executor,
        );
        if (update.failed) {
          this.failures++;
          this.killSwitch.trip("EXIT_EXECUTION_FAILURE");
        }
        if (update.exit)
          positionEvents.push(
            this.event(
              update.exit.type,
              { reason: update.exit.reason, quote: update.exit.quote },
              {
                chainId: position.chainId,
                tokenAddress: position.tokenAddress,
                positionId: position.id,
              },
            ),
          );
        const next = update.position;
        updates.push(next);
      }
      const outcomes: OutcomeRecord[] = [];
      for (const outcome of this.outcomes.values()) {
        const state = this.markets.state(
          outcome.chainId,
          outcome.tokenAddress,
          now,
        );
        if (!state) continue;
        const next = observeOutcome(outcome, state, now);
        if (!next) continue;
        outcomes.push(next);
      }
      if (this.dailyPnl() <= -this.settings.maxDailyLossUsd)
        this.killSwitch.trip("DAILY_LOSS");
      const healthy = await this.options.repository.health();
      if (!healthy) {
        this.dbHealthy = false;
        this.killSwitch.trip("DATABASE_UNHEALTHY");
      }
      const rpc = await this.adapters
        .get(this.settings.activeChain)
        ?.healthCheck();
      if (rpc?.status !== "healthy") this.killSwitch.trip("RPC_UNHEALTHY");
      await this.persist({
        positions: updates,
        events: positionEvents,
        outcomes,
        failures: this.failures,
        kill: this.killSwitch.snapshot().reasons,
        event: this.event("position_update", { updated: updates.length }),
      });
      if (
        this.dailyPnl() <= -this.settings.maxDailyLossUsd &&
        !this.killSwitch.snapshot().reasons.includes("DAILY_LOSS")
      ) {
        this.killSwitch.trip("DAILY_LOSS");
        await this.persist({
          kill: this.killSwitch.snapshot().reasons,
          event: this.event("kill_switch", this.killSwitch.snapshot()),
        });
      }
    });
  }
  async snapshot(): Promise<DashboardSnapshot> {
    const all = this.positions.all();
    const open = all.filter((p) => p.closedAt === undefined);
    const closed = all.filter((p) => p.closedAt !== undefined);
    const healthy = (detail: string) => ({
      status: "healthy" as const,
      detail,
      checkedAt: this.now(),
    });
    return {
      mode: "PAPER",
      source: "MOCK",
      liveEnabled: false,
      running: this.running,
      activeChain: this.settings.activeChain,
      strategy: this.settings.strategy,
      chains: await Promise.all(
        this.options.chains.map(async (chain) => ({
          id: chain.id,
          name: chain.name,
          enabled: chain.enabled,
          health: (await this.adapters.get(chain.id)?.healthCheck()) ?? {
            status: "unconfigured" as const,
            detail: "Chuỗi đã tắt",
            checkedAt: this.now(),
          },
        })),
      ),
      health: {
        scanner: healthy(
          this.running
            ? "Đang quét dữ liệu giả lập"
            : "Đã tạm dừng quét; vẫn đang theo dõi vị thế",
        ),
        ai: this.killSwitch.snapshot().reasons.includes("AI_UNAVAILABLE")
          ? {
              status: "unhealthy",
              detail: "AI không khả dụng; đã chặn lệnh mới",
              checkedAt: this.now(),
            }
          : healthy(`${this.ai.id} · phân loại giả lập`),
        database: this.dbHealthy
          ? healthy(
              `${this.options.repository.constructor.name} · nhật ký lưu bền vững`,
            )
          : {
              status: "unhealthy",
              detail: "Nhật ký không khả dụng",
              checkedAt: this.now(),
            },
      },
      killSwitch: this.killSwitch.snapshot(),
      metrics: {
        detected: this.candidates.length + this.inFlight.size,
        analyzed: this.candidates.filter((c) => c.state).length,
        rejected: this.candidates.filter((c) => c.action === "REJECT").length,
        aiCalls: this.aiCalls,
        trades: this.trades.length,
        dailyPnlUsd: this.dailyPnl(),
        winRate: closed.length
          ? (closed.filter((p) => p.realizedPnlUsd > 0).length /
              closed.length) *
            100
          : 0,
        exposureUsd: open.reduce(
          (s, p) =>
            s +
            Math.max(
              p.remainingCostUsd,
              Number(p.quantity) * p.currentPriceUsd,
            ),
          0,
        ),
        openPositions: open.length,
      },
      candidates: structuredClone(this.candidates.slice(0, 200)),
      positions: all.slice(-300).reverse(),
      events: structuredClone(this.events),
      outcomes: structuredClone([...this.outcomes.values()].slice(-200)),
    };
  }
  history() {
    return structuredClone(this.candidates);
  }
  startTimers() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking || this.closing) return;
      this.ticking = true;
      void this.tick()
        .catch(() => {
          this.killSwitch.trip("WORKER_ERROR");
          this.logger.error(
            { code: "WORKER_ERROR" },
            "Chu kỳ xử lý của bot thất bại; đã chặn lệnh mới",
          );
        })
        .finally(() => {
          this.ticking = false;
        });
    }, 2000);
  }
  private async tick() {
    await this.monitor();
    if (this.running && this.now() - this.lastDiscovery >= 6000) {
      this.lastDiscovery = this.now();
      for (const chainId of this.discovery.active()) {
        const event = mockDiscoveryEvent(chainId, this.index++, this.now());
        void this.ingest(event).catch(() =>
          this.logger.warn(
            { chainId },
            "Không tiếp nhận được token để phân tích",
          ),
        );
      }
    }
  }
  async shutdown() {
    this.closing = true;
    this.running = false;
    this.generation++;
    clearInterval(this.timer);
    await this.ingestion.drain();
    await this.commits.drain();
    for (const adapter of this.adapters.values()) await adapter.disconnect();
    await this.options.repository.close();
  }
}
