"use client";
import type { ReactNode } from "react";
import type {
  CandidateRecord,
  DashboardSnapshot,
  DomainEvent,
  ManagedPosition,
  ObservationTrade,
  WalletBalance,
} from "@sniper/core";
import { Badge, Health, Pnl } from "./ui";
import { number, shortChain } from "./format";
import { eventLabel } from "./vi";
import { CandidateTable } from "./tables";
import { PerformanceChart } from "./performance-chart";

export type PositionSelection =
  | { kind: "observation"; value: ObservationTrade }
  | { kind: "managed"; value: ManagedPosition };
export const shortAddress = (address?: string) =>
  address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Chưa cấu hình ví";
export function MetricCard({
  label,
  value,
  children,
  className = "",
}: {
  label: string;
  value: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article className={`panel terminal-metric ${className}`}>
      <span className="metric-label">{label}</span>
      <div className="metric-value">{value}</div>
      <div className="metric-meta">{children}</div>
    </article>
  );
}
const eventCategory = (type: string) => {
  if (/error|unavailable|retry/.test(type)) return "WARN";
  if (/kill|rejected/.test(type)) return "RISK";
  if (/sell|exit|profit|loss/.test(type)) return "SELL";
  if (/buy/.test(type)) return "BUY";
  if (/rug|security/.test(type)) return "RUG";
  if (/quote|mark/.test(type)) return "QUOTE";
  if (/analysis|analyzed|stage/.test(type)) return "ANALYSIS";
  if (/detected|discovery|scanner/.test(type)) return "SCAN";
  return "SYS";
};
export function ActivityLog({ events }: { events: DomainEvent[] }) {
  const recent = events.slice(0, 50);
  return (
    <section className="panel terminal-log">
      <div className="section-heading">
        <h2>Nhật ký hoạt động</h2>
        <span className="count">{recent.length} gần nhất</span>
      </div>
      <div
        className="terminal-log-scroll"
        tabIndex={0}
        aria-label="Nhật ký sự kiện thực tế"
      >
        {recent.map((event) => (
          <div className="terminal-event" key={event.id}>
            <time>
              {new Date(event.timestamp).toLocaleTimeString("vi-VN", {
                timeZone: "Asia/Bangkok",
                hour12: false,
              })}
            </time>
            <span
              className={`event-tag event-${eventCategory(event.type).toLowerCase()}`}
            >
              [{eventCategory(event.type)}]
            </span>
            <div>
              <strong>{eventLabel(event.type)}</strong>
              <small>
                {event.chainId ? `${shortChain(event.chainId)} · ` : ""}
                {event.tokenAddress
                  ? shortAddress(event.tokenAddress)
                  : "Hệ thống cục bộ"}
              </small>
            </div>
          </div>
        ))}
        {!events.length && (
          <div className="compact-empty">
            Chưa có sự kiện. Nhật ký sẽ cập nhật từ luồng dữ liệu của bot.
          </div>
        )}
      </div>
    </section>
  );
}
export function SystemHealth({ snapshot }: { snapshot: DashboardSnapshot }) {
  const latestEvidence = snapshot.candidates.find((candidate) =>
    candidate.rugCheck?.externalProviders.some(
      (provider) =>
        provider.status !== "DISABLED" && provider.status !== "UNSUPPORTED",
    ),
  )?.rugCheck;
  const providers =
    latestEvidence?.externalProviders.filter(
      (provider) =>
        provider.status !== "DISABLED" && provider.status !== "UNSUPPORTED",
    ) ?? [];
  return (
    <details className="panel terminal-system">
      <summary className="section-heading">
        <h2>Chuỗi & hệ thống</h2>
        <span className="local-tag">CỤC BỘ</span>
      </summary>
      <div className="system-chains">
        {snapshot.chains.map((chain) => {
          const scanner = snapshot.observation?.scanners.find(
            (s) => s.chainId === chain.id,
          );
          const ws = chain.websocket;
          const fallback = snapshot.running && ws && ws.status !== "READY";
          return (
            <div key={chain.id} className="system-chain">
              <div>
                <span className={`chain-icon ${chain.id}`}>
                  {shortChain(chain.id)}
                </span>
                <strong>{chain.name}</strong>
                <Badge
                  tone={
                    !chain.enabled
                      ? "muted"
                      : scanner?.status === "ERROR"
                        ? "amber"
                        : fallback && chain.health.status === "healthy"
                          ? "amber"
                          : chain.health.status === "healthy"
                            ? "green"
                            : chain.health.status === "unhealthy"
                              ? "red"
                              : "muted"
                  }
                >
                  {!chain.enabled
                    ? "TẮT"
                    : scanner?.status === "ERROR"
                      ? "SUY GIẢM"
                      : fallback && chain.health.status === "healthy"
                        ? "HTTP DỰ PHÒNG"
                        : chain.health.status === "healthy"
                          ? "RPC ĐẠT"
                          : chain.health.status === "unhealthy"
                            ? "LỖI RPC"
                            : "CHƯA CẤU HÌNH"}
                </Badge>
              </div>
              <p title={chain.health.detail}>{chain.health.detail}</p>
              {ws && (
                <small
                  className={fallback ? "stream-degraded" : ""}
                  title={ws.reasons.join(" · ")}
                >
                  {ws.status === "READY"
                    ? "WebSocket đã đăng ký"
                    : ws.reasons.includes("WS_UNCONFIGURED")
                      ? "Chưa cấu hình WebSocket · dùng HTTP"
                      : "WebSocket chưa sẵn sàng · đang thử lại"}
                  {fallback && chain.id === "solana"
                    ? " · HTTP chỉ lấy mẫu, có thể bỏ sót pool"
                    : ""}
                </small>
              )}
              <small>
                {scanner
                  ? {
                      SCANNING: "Đang quét",
                      CONNECTING: "Đang kết nối scanner",
                      ERROR: "Scanner gặp lỗi",
                      STOPPED: "Scanner đã dừng",
                    }[scanner.status]
                  : snapshot.running
                    ? "Bộ quét đang bật"
                    : "Bộ quét đã dừng"}{" "}
                · Kiểm tra{" "}
                {new Date(chain.health.checkedAt).toLocaleTimeString("vi-VN", {
                  timeZone: "Asia/Bangkok",
                  hour12: false,
                })}
              </small>
            </div>
          );
        })}
      </div>
      <div className="system-dependencies">
        <Health label="Jev / AI" health={snapshot.health.ai} />
        <Health label="SQLite" health={snapshot.health.database} />
        <Health label="Scanner" health={snapshot.health.scanner} />
      </div>
      {!!providers.length && (
        <details className="provider-status">
          <summary>Nguồn bảo mật đã dùng · {providers.length}</summary>
          <p>
            Trạng thái lần thu thập gần nhất, không phải kiểm tra uptime toàn
            cục.
          </p>
          {providers.map((provider) => (
            <div key={provider.provider}>
              <span>{provider.provider}</span>
              <Badge tone={provider.status === "OK" ? "cyan" : "amber"}>
                {provider.status === "OK" ? "CÓ PHẢN HỒI" : "KHÔNG KHẢ DỤNG"}
              </Badge>
            </div>
          ))}
          <small>
            {latestEvidence &&
              new Date(latestEvidence.dataQuality.collectedAt).toLocaleString(
                "vi-VN",
                { timeZone: "Asia/Bangkok" },
              )}
          </small>
        </details>
      )}
    </details>
  );
}
export function TerminalOverview({
  snapshot,
  balance,
  busy,
  onReadBalance,
  onSelect,
  onNavigate,
  onToggleScanner,
}: {
  snapshot: DashboardSnapshot;
  balance?: WalletBalance;
  busy: boolean;
  onReadBalance: () => void;
  onSelect: (candidate: CandidateRecord) => void;
  onNavigate: (tab: string) => void;
  onToggleScanner: () => void;
}) {
  const observation = !!snapshot.observation;
  const analytics = observation ? undefined : snapshot.analytics;
  const virtual =
    snapshot.observation?.trades.filter((p) => p.state === "OPEN") ?? [];
  const managed =
    snapshot.managedPositions?.filter(
      (p) => !["CLOSED", "FAILED"].includes(p.state),
    ) ?? [];
  const open = observation ? virtual.length : managed.length;
  const closedCount = observation
    ? snapshot.observation!.trades.length - open
    : (analytics?.scope.closedTrades ?? 0);
  const lastPoint = analytics?.realizedEquity.at(-1);
  const pnl =
    closedCount && analytics?.scope.unknownNetResults === 0
      ? lastPoint?.pnlUsd
      : null;
  const winRate =
    closedCount && analytics?.scope.unknownNetResults === 0
      ? analytics?.winRate
      : null;
  const wallet =
    snapshot.activeChain === "solana"
      ? snapshot.tradingWallet?.solana
      : snapshot.tradingWallet?.evm;
  const nativeSymbol =
    { solana: "SOL", bnb: "BNB", robinhood: "ETH" }[snapshot.activeChain] ?? "";
  const currentBalance =
    balance?.chainId === snapshot.activeChain ? balance : undefined;
  const nativeAmount = currentBalance
    ? Number(currentBalance.nativeAmount) / 10 ** currentBalance.nativeDecimals
    : undefined;
  return (
    <div className="terminal-overview">
      <div className="terminal-metrics">
        <MetricCard
          label="Số dư ví · tài sản gốc"
          value={
            nativeAmount === undefined
              ? "—"
              : `${number(nativeAmount, 5)} ${nativeSymbol}`
          }
        >
          <div className="metric-split">
            <span>
              {wallet?.address
                ? "Chưa định giá tổng USD"
                : "Chưa cấu hình ví · không giả lập số dư"}
            </span>
            <button
              className="text-button"
              disabled={busy || !wallet?.address}
              onClick={onReadBalance}
            >
              Đọc RPC ↗
            </button>
          </div>
          <div className="sizing-caption">
            {observation ? (
              <>
                <b>{snapshot.observation!.budgetUsd} USD</b> / tín hiệu mô phỏng
              </>
            ) : (
              "Sizing theo cấu hình backend"
            )}
          </div>
        </MetricCard>
        <MetricCard
          label={`Tổng P&L đã chốt · ${snapshot.mode}`}
          value={pnl === null || pnl === undefined ? "—" : <Pnl value={pnl} />}
        >
          {observation
            ? "Chưa đủ dữ liệu phí để xác minh P&L ròng"
            : closedCount
              ? `${closedCount} vị thế đóng · chỉ kết quả đã định giá`
              : "Chưa có vị thế đã đóng"}
          <span className="metric-footnote">
            {observation
              ? "Không phải lợi nhuận tiền thật"
              : "Theo sổ kế toán hiện tại"}
          </span>
        </MetricCard>
        <MetricCard
          label="Tỷ lệ thắng"
          value={
            winRate === null || winRate === undefined
              ? "—"
              : `${number(winRate, 1)}%`
          }
          className="win-rate-card"
        >
          <svg className="win-ring" viewBox="0 0 48 48" aria-hidden="true">
            <circle
              cx="24"
              cy="24"
              r="20"
              fill="none"
              stroke="var(--border)"
              strokeWidth="3"
            />
            {winRate !== null && winRate !== undefined && (
              <circle
                cx="24"
                cy="24"
                r="20"
                fill="none"
                stroke="var(--mint)"
                strokeWidth="3"
                strokeDasharray={`${(winRate / 100) * 125.66} 125.66`}
                transform="rotate(-90 24 24)"
              />
            )}
          </svg>
          {observation
            ? `${closedCount} lệnh mô phỏng đóng · P&L ròng chưa rõ`
            : `${closedCount} vị thế đã đóng`}
          <span className="metric-footnote">Không tính từ dự đoán của AI</span>
        </MetricCard>
        <MetricCard
          label="Trạng thái bot"
          value={
            <span
              className={snapshot.running ? "positive bot-state" : "bot-state"}
            >
              <span className={`dot ${snapshot.running ? "green" : "muted"}`} />
              {snapshot.running ? "ĐANG QUÉT" : "ĐÃ DỪNG"}
            </span>
          }
        >
          <div className="bot-counters">
            <span>
              Phát hiện <b>{number(snapshot.metrics.detected)}</b>
            </span>
            <span>
              Phân tích <b>{number(snapshot.metrics.analyzed)}</b>
            </span>
            <span>
              Từ chối <b>{number(snapshot.metrics.rejected)}</b>
            </span>
            <span>
              Gọi AI <b>{number(snapshot.metrics.aiCalls)}</b>
            </span>
          </div>
        </MetricCard>
      </div>
      <div className="terminal-workspace-grid">
        <div className="terminal-primary-stack">
          <section className="panel terminal-performance">
            <PerformanceChart
              observation={observation}
              points={analytics?.realizedEquity ?? []}
            />
            <div className="performance-summary">
              <span>
                <i className="dot green" /> Dữ liệu blockchain thật
              </span>
              <span>
                {observation ? "Mua/bán chỉ mô phỏng" : snapshot.mode}
              </span>
              <span>{open} vị thế đang mở</span>
            </div>
          </section>
          <section className="panel table-panel scanner-panel">
            <div className="section-heading">
              <div>
                <h2>
                  Token scanner{" "}
                  <span className="count">
                    {snapshot.candidates.length} gần nhất
                  </span>
                </h2>
                <p>
                  {snapshot.running
                    ? "Luồng token từ blockchain · chọn dòng để xem Rug / Jev / Risk"
                    : "Scanner đã dừng · giữ các quyết định đã ghi nhận"}
                </p>
                <p className="scanner-distribution">
                  Trong {snapshot.candidates.length} token gần nhất:{" "}
                  {snapshot.chains
                    .map(
                      (chain) =>
                        `${shortChain(chain.id)} ${snapshot.candidates.filter((candidate) => candidate.event.chainId === chain.id).length}`,
                    )
                    .join(" · ")}
                </p>
              </div>
              <div className="scanner-actions">
                <button
                  className={
                    snapshot.running
                      ? "subtle scanner-button"
                      : "primary scanner-button"
                  }
                  disabled={busy}
                  onClick={onToggleScanner}
                >
                  {snapshot.running ? "Ⅱ Tạm dừng quét" : "▷ Bắt đầu quét"}
                </button>
                <button
                  className="text-button"
                  onClick={() => onNavigate("research")}
                >
                  Lịch sử ↗
                </button>
              </div>
            </div>
            <CandidateTable records={snapshot.candidates} onSelect={onSelect} />
          </section>
        </div>
        <aside className="terminal-monitor-stack">
          <ActivityLog events={snapshot.events} />
          <SystemHealth snapshot={snapshot} />
        </aside>
      </div>
    </div>
  );
}
