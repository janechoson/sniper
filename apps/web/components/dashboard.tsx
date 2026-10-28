"use client";
import { APP_NAME } from "./brand";
import { useCallback, useEffect, useState, useRef } from "react";
import type {
  CandidateRecord,
  DashboardSnapshot,
  WalletBalance,
} from "@sniper/core";
import type { Settings } from "@sniper/config";
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Yêu cầu thất bại");
  return result as T;
}
import { Badge, Health } from "./ui";
import { CandidateTable, PositionTable } from "./tables";
import { EquityChart } from "./equity-chart";
import { RealAnalytics } from "./real-analytics";
import { RugCheckReport, RugSecurityOverview } from "./rug-check-report";
import { SettingsForm } from "./settings-form";
import { ObservationPositions } from "./observation-panel";
import {
  TerminalOverview,
  shortAddress,
  type PositionSelection,
} from "./terminal-overview";
import { DecisionPanels } from "./decision-panels";
import { PositionDetail } from "./position-detail";
import { DiscoveryFunnel } from "./discovery-funnel";
import { EvmDiscoveryCoverage } from "./evm-discovery";
import { price, shortChain, number } from "./format";
import { actionLabel, reasonLabel } from "./vi";
export default function Dashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [settings, setSettings] = useState<Settings>();
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState("");
  const [selected, setSelected] = useState<CandidateRecord>();
  const [history, setHistory] = useState<CandidateRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState("ALL");
  const [closeId, setCloseId] = useState<string>();
  const [selectedPosition, setSelectedPosition] = useState<PositionSelection>();
  const [entryControl, setEntryControl] = useState<"kill" | "reset">();
  const [balance, setBalance] = useState<WalletBalance>();
  const [allControl, setAllControl] = useState<"disable-all" | "enable-all">();
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([]);
  const refreshing = useRef(false);
  useEffect(() => {
    if (
      !selected &&
      !selectedPosition &&
      !closeId &&
      !entryControl &&
      !allControl
    )
      return;
    const previous = document.activeElement;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        setSelected(undefined);
        setSelectedPosition(undefined);
        setCloseId(undefined);
        setEntryControl(undefined);
        setAllControl(undefined);
      }
      if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [selected, selectedPosition, closeId, entryControl, allControl, busy]);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      setSnapshot(await api<DashboardSnapshot>("snapshot"));
      setLastUpdate(
        new Date().toLocaleTimeString("vi-VN", {
          timeZone: "Asia/Bangkok",
          hour12: false,
        }),
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      refreshing.current = false;
    }
  }, []);
  useEffect(() => {
    void refresh();
    void api<Settings>("settings")
      .then(setSettings)
      .catch((e) => setError(e.message));
    const stream = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.addEventListener("update", (event) => {
      try {
        const item = JSON.parse((event as MessageEvent<string>).data);
        if (
          item.type === "observation_buy" ||
          item.type === "observation_sell"
        ) {
          const symbol =
            typeof item.data?.symbol === "string"
              ? item.data.symbol.slice(0, 60)
              : "token";
          setToasts((previous) =>
            [
              {
                id: item.id,
                text:
                  item.type === "observation_buy"
                    ? `Đã mua mô phỏng · 5 USD · ${symbol}`
                    : `Đã bán mô phỏng · ${symbol}`,
              },
              ...previous,
            ].slice(0, 3),
          );
        }
      } catch {
        /* Sự kiện không hợp lệ không tạo thông báo mua/bán. */
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 250);
    });
    const poll = setInterval(() => void refresh(), 5000);
    return () => {
      stream.close();
      clearInterval(poll);
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (tab !== "research") return;
    void api<{ records: CandidateRecord[]; total: number }>(
      `history?offset=${offset}&limit=100`,
    )
      .then((r) => {
        setHistory(r.records);
        setHistoryTotal(r.total);
      })
      .catch((e) => setError(e.message));
  }, [tab, offset, snapshot?.metrics.detected]);
  async function mutate(path: string, method: string, value: unknown) {
    setBusy(true);
    try {
      const result = await api<Settings>(path, method, value);
      if (path === "settings") setSettings(result);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const control = (action: string) => {
    void mutate("control", "POST", { action }).catch(() => {});
  };
  const metrics = snapshot?.metrics;
  const activeWallet =
    snapshot?.activeChain === "solana"
      ? snapshot.tradingWallet?.solana
      : snapshot?.tradingWallet?.evm;
  const readBalance = () => {
    if (!snapshot) return;
    setBusy(true);
    setBalance(undefined);
    void api<WalletBalance>(
      `wallet-balance?chainId=${encodeURIComponent(snapshot.activeChain)}`,
    )
      .then(setBalance)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const openPositionCount = snapshot?.observation
    ? snapshot.observation.trades.filter((t) => t.state === "OPEN").length
    : (metrics?.openPositions ?? 0);
  const records = (
    tab === "research" ? history : (snapshot?.candidates ?? [])
  ).filter(
    (c) =>
      filter === "ALL" ||
      (c.observation?.virtualAction === "BUY" ? "BUY" : c.action) === filter,
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">S</span>
          <span>
            <span className="brand-name">{APP_NAME}</span>
            <small>TERMINAL CỤC BỘ</small>
          </span>
        </a>
        <div className="workspace-label">
          ĐIỀU KHIỂN <Badge>01</Badge>
        </div>
        <nav>
          {[
            ["overview", "◈", "Tổng quan"],
            ["positions", "▤", "Vị thế"],
            ["research", "⌁", "Lịch sử quyết định"],
            ["settings", "⚙", "Cài đặt"],
          ].map(([id, icon, label]) => (
            <button
              key={id}
              className={tab === id ? "nav-item active" : "nav-item"}
              aria-current={tab === id ? "page" : undefined}
              aria-label={
                id === "positions" ? `${label} ${openPositionCount}` : label
              }
              onClick={() => {
                setTab(id!);
                setFilter("ALL");
                setSelected(undefined);
                setSelectedPosition(undefined);
                window.scrollTo({ top: 0 });
              }}
            >
              <span>{icon}</span>
              {label}
              {id === "positions" && <small>{openPositionCount}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="local-tag">LOCAL / SINGLE WALLET</span>
          <strong>
            {snapshot?.source === "RPC"
              ? "Theo dõi dữ liệu on-chain"
              : "Phòng thử nghiệm mô phỏng"}
          </strong>
          <p>Dữ liệu thật. Quyết định có kiểm soát.</p>
          <span className="version">v0.1 · thử nghiệm</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="terminal-header">
          <div className="breadcrumb">
            TERMINAL <span>/</span>{" "}
            <strong>
              {tab === "overview"
                ? "Tổng quan"
                : tab === "research"
                  ? "Lịch sử quyết định"
                  : tab === "settings"
                    ? "Cài đặt"
                    : "Vị thế"}
            </strong>
          </div>
          <div className="terminal-header-state">
            <span
              className={`mode-pill ${snapshot?.mode === "LIVE" ? "mode-live" : snapshot?.mode === "LIVE_DRY_RUN" ? "mode-dry" : "mode-paper"}`}
            >
              <span className="dot" />
              {snapshot?.mode === "PAPER"
                ? "PAPER · MÔ PHỎNG"
                : snapshot?.mode === "LIVE"
                  ? "LIVE · TIỀN THẬT"
                  : snapshot?.mode === "LIVE_DRY_RUN"
                    ? "DRY RUN · KHÔNG PHÁT"
                    : "ĐANG KẾT NỐI"}
            </span>
            <span className="header-chain">
              {snapshot ? shortChain(snapshot.activeChain) : "—"}
            </span>
            <span className="header-wallet" title={activeWallet?.address}>
              {shortAddress(activeWallet?.address)}
            </span>
          </div>
          <div className="header-right">
            <span className={`dot ${connected ? "green" : "amber"}`} />
            {connected
              ? "Đã kết nối luồng dữ liệu"
              : "Đang kết nối lại luồng dữ liệu"}
            <button
              className={
                snapshot?.killSwitch.active
                  ? "danger entry-control"
                  : "subtle entry-control"
              }
              disabled={busy || !snapshot}
              onClick={() =>
                setEntryControl(snapshot?.killSwitch.active ? "reset" : "kill")
              }
            >
              {snapshot?.killSwitch.active
                ? "ĐANG CHẶN LỆNH MỚI"
                : "Dừng lệnh mới…"}
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">{APP_NAME} / PHÂN TÍCH ĐA CHUỖI</div>
              <h1>
                {tab === "overview"
                  ? "Trạm giao dịch"
                  : tab === "research"
                    ? "Lịch sử quyết định"
                    : tab === "settings"
                      ? "Cài đặt chiến lược"
                      : "Các vị thế trong danh mục"}
              </h1>
              <p>
                {tab === "overview"
                  ? "Theo dõi token mới. Đánh giá tín hiệu. Kiểm soát rủi ro."
                  : tab === "positions"
                    ? "Vị thế trên mọi chuỗi vẫn được theo dõi khi chuyển chuỗi quét."
                    : tab === "research"
                      ? "Xem lại mọi quyết định, bao gồm cả những giao dịch đã bỏ qua."
                      : "Điều chỉnh các giới hạn theo quy tắc cho lần giao dịch tiếp theo."}
              </p>
            </div>
            <div className="heading-actions">
              <Badge tone={snapshot?.source === "RPC" ? "green" : "amber"}>
                {snapshot?.source === "RPC" ? "DỮ LIỆU THẬT" : "ĐANG KẾT NỐI"}
              </Badge>
              <span className="timestamp">Cập nhật {lastUpdate || "—"}</span>
            </div>
          </div>
          <div
            className={`notice ${snapshot?.mode === "LIVE" ? "notice-live" : ""}`}
          >
            <span>◉</span>
            <div>
              <strong>
                {snapshot?.observation
                  ? "Dữ liệu thật · chỉ quan sát, mua/bán mô phỏng 5 USD"
                  : snapshot?.source === "RPC"
                    ? `Dữ liệu thật · ${snapshot.mode === "PAPER" ? "khớp lệnh trên giấy" : snapshot.mode === "LIVE_DRY_RUN" ? "kiểm tra không phát giao dịch" : snapshot.liveEnabled ? "giao dịch tiền thật" : "tiền thật chưa sẵn sàng"}`
                    : "Đang kết nối dữ liệu thật"}
              </strong>
              <span>
                {" "}
                {snapshot?.source === "RPC" ? (
                  "Chỉ số chưa xác minh được giữ là Chưa rõ. Báo giá không chứng minh bán được; chi phí chưa rõ không được tính bằng 0."
                ) : (
                  <>
                    Chưa có phản hồi từ bot. Không hiển thị token hoặc chỉ số
                    mẫu.
                  </>
                )}
              </span>
            </div>
            <Badge tone="green">
              {snapshot?.mode === "PAPER"
                ? snapshot.source === "RPC"
                  ? "KHÔNG PHÁT GIAO DỊCH"
                  : "KHÔNG CẦN VÍ"
                : snapshot?.liveEnabled
                  ? "TIỀN THẬT"
                  : "PHÁT GIAO DỊCH ĐÃ KHÓA"}
            </Badge>
          </div>

          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {tab === "settings" && (
            <div className="health-row">
              <Health
                label={
                  snapshot?.source === "RPC"
                    ? "RPC / dữ liệu thật"
                    : "RPC / dữ liệu giả lập"
                }
                health={
                  snapshot?.chains.find((c) => c.id === snapshot.activeChain)
                    ?.health
                }
              />
              <Health label="Bộ quét" health={snapshot?.health.scanner} />
              <Health label="Dịch vụ AI" health={snapshot?.health.ai} />
              <Health
                label="Cơ sở dữ liệu"
                health={snapshot?.health.database}
              />
            </div>
          )}
          {snapshot?.killSwitch.active && (
            <div className="error">
              Đã chặn lệnh mới:{" "}
              {snapshot.killSwitch.reasons.map(reasonLabel).join(", ")}. Tiếp
              tục theo dõi các vị thế hiện có.{" "}
              {snapshot.killSwitch.reasons.includes("ALL_TRADING_DISABLED") &&
                "Các lệnh bán cũng đang bị chặn."}
            </div>
          )}
          {!snapshot && (
            <div className="panel loading-state" role="status">
              {error
                ? "Chưa nhận được trạng thái bot. Đang thử kết nối lại…"
                : "Đang đọc trạng thái thật từ bot…"}
            </div>
          )}
          {tab === "overview" && snapshot && (
            <TerminalOverview
              snapshot={snapshot}
              balance={balance}
              busy={busy}
              onReadBalance={readBalance}
              onSelect={setSelected}
              onToggleScanner={() =>
                control(snapshot.running ? "pause" : "start")
              }
              onNavigate={(next) => {
                setTab(next);
                setFilter("ALL");
                window.scrollTo({ top: 0 });
              }}
            />
          )}
          {tab === "settings" && settings ? (
            <>
              <section className="panel settings-panel">
                <SettingsForm
                  settings={settings}
                  busy={busy}
                  onSave={(s) => mutate("settings", "PATCH", s)}
                  observationMode={!!snapshot?.observation}
                />
              </section>

              {snapshot?.observation && (
                <p className="mode-explanation">
                  Ngân sách quan sát tạm thời là 5 USD mỗi tín hiệu mô phỏng.
                  Khi chạy thật, chuyển sang 10% số dư khả dụng theo quy ước đã
                  lưu.
                </p>
              )}
              <details className="panel page-details">
                <summary>Kết nối, ví và điều kiện chạy thật</summary>
                {snapshot?.readiness && (
                  <section className="panel readiness-panel">
                    <div className="section-heading">
                      <div>
                        <h2>Điều kiện vận hành</h2>
                        <p>
                          {snapshot.readiness.ready
                            ? "Đủ cấu hình cơ bản; từng token vẫn phải qua kiểm tra rủi ro."
                            : "Cần xử lý các điều kiện dưới đây."}
                        </p>
                      </div>
                      <Badge
                        tone={snapshot.readiness.ready ? "green" : "amber"}
                      >
                        {snapshot.readiness.ready
                          ? "ĐỦ ĐIỀU KIỆN"
                          : "CHƯA SẴN SÀNG"}
                      </Badge>
                    </div>
                    <div className="readiness-grid">
                      {snapshot.readiness.items.map((item) => (
                        <div key={item.component} className="readiness-item">
                          <strong>
                            {(
                              {
                                RPC: "Kết nối blockchain",
                                CONFIG: "Cấu hình dữ liệu thật",
                                DEX_DISCOVERY: "Phát hiện bể giao dịch",
                                QUOTE_USD_PRICE: "Giá USD của tài sản định giá",
                                JEV: "Phân loại Jev",
                                STORAGE: "Lưu trữ",
                                WEBSOCKET: "Kết nối thời gian thực",
                                SWAP_PROVIDER: "Nhà cung cấp hoán đổi",
                                QUOTE_ENGINE: "Bộ báo giá",
                                WALLET: "Ví giao dịch cố định",
                                RUG_CHECK: "Bằng chứng an toàn token",
                                SIGNER: "Bộ ký cục bộ",
                                RISK_ENGINE: "Kiểm soát rủi ro",
                                KILL_SWITCH: "Ngắt khẩn cấp",
                                EXECUTOR: "Bộ thực thi",
                                LIVE_AUTHORIZATION: "Xác nhận giao dịch thật",
                                LIVE_SELL_SIMULATION_AND_ACCOUNTING:
                                  "Mô phỏng bán và kế toán",
                                LIVE_TRANSACTION_POLICY:
                                  "Kiểm tra giao dịch và thoát lệnh",
                              } as Record<string, string>
                            )[item.component] ?? item.component}
                          </strong>
                          <Badge
                            tone={item.status === "READY" ? "green" : "amber"}
                          >
                            {item.status === "READY"
                              ? "ĐẠT"
                              : item.status === "NOT_STARTED"
                                ? "CHƯA KHỞI ĐỘNG"
                                : item.status === "DEGRADED"
                                  ? "ĐANG DÙNG HTTP"
                                  : item.required
                                    ? "CẦN XỬ LÝ"
                                    : "LIVE CHƯA ĐẠT"}
                          </Badge>
                          {item.reasons.length > 0 && (
                            <p>{item.reasons.map(reasonLabel).join(" · ")}</p>
                          )}
                        </div>
                      ))}
                    </div>
                    {snapshot.tradingWallet && (
                      <div className="wallet-list">
                        <h3>Ví giao dịch cố định</h3>
                        {(["evm", "solana"] as const).map((family) => {
                          const wallet = snapshot.tradingWallet![family];
                          return (
                            <div key={family}>
                              <strong>
                                {family === "evm"
                                  ? "EVM · BNB / Robinhood"
                                  : "Solana"}
                              </strong>
                              <code>
                                {wallet.address ?? "Chưa cấu hình địa chỉ"}
                              </code>
                              <span>
                                {
                                  {
                                    READY: "Sẵn sàng ký cục bộ",
                                    WATCH_ONLY: "Chỉ xem",
                                    NOT_CONFIGURED: "Chưa cấu hình",
                                    UNAVAILABLE: "Không thể sử dụng bộ ký",
                                  }[wallet.signerStatus]
                                }
                              </span>
                            </div>
                          );
                        })}
                        <button
                          className="subtle"
                          disabled={busy}
                          onClick={() => {
                            setBusy(true);
                            setBalance(undefined);
                            void api<WalletBalance>(
                              `wallet-balance?chainId=${encodeURIComponent(snapshot.activeChain)}`,
                            )
                              .then(setBalance)
                              .catch((e) => setError(e.message))
                              .finally(() => setBusy(false));
                          }}
                        >
                          Đọc số dư từ RPC
                        </button>
                        {balance &&
                          balance.chainId === snapshot.activeChain && (
                            <p>
                              Số dư tài sản gốc: {balance.nativeAmount} đơn vị
                              nhỏ nhất · {balance.nativeDecimals} chữ số thập
                              phân ·{" "}
                              {new Date(balance.observedAt).toLocaleString(
                                "vi-VN",
                              )}
                            </p>
                          )}
                      </div>
                    )}
                    <button
                      className="subtle"
                      disabled={busy}
                      onClick={() =>
                        setAllControl(
                          snapshot.killSwitch.reasons.includes(
                            "ALL_TRADING_DISABLED",
                          )
                            ? "enable-all"
                            : "disable-all",
                        )
                      }
                    >
                      Điều khiển dừng toàn bộ giao dịch…
                    </button>
                  </section>
                )}
              </details>
            </>
          ) : (
            <>
              {tab === "research" && (
                <section className="panel table-panel">
                  <div className="section-heading">
                    <div>
                      <h2>
                        Các quyết định đã lưu{" "}
                        <span className="count">{historyTotal}</span>
                      </h2>
                      <p>
                        Chọn token để xem dữ liệu phân tích và lý do quyết định.
                      </p>
                    </div>
                    <div className="filters">
                      {["ALL", "BUY", "SKIP", "REJECT"].map((v) => (
                        <button
                          key={v}
                          className={filter === v ? "active" : ""}
                          onClick={() => setFilter(v)}
                        >
                          {v === "ALL"
                            ? "Tất cả token"
                            : v === "BUY"
                              ? "Quyết định mua"
                              : actionLabel(v)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <CandidateTable records={records} onSelect={setSelected} />
                  {tab === "research" && (
                    <div className="pagination">
                      <button
                        className="subtle"
                        disabled={offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - 100))}
                      >
                        Trang trước
                      </button>
                      <span>
                        {historyTotal ? offset + 1 : 0}–
                        {Math.min(offset + 100, historyTotal)} trên{" "}
                        {historyTotal}
                      </span>
                      <button
                        className="subtle"
                        disabled={offset + 100 >= historyTotal}
                        onClick={() => setOffset(offset + 100)}
                      >
                        Trang sau
                      </button>
                      <a
                        href="/api/history?limit=1000"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Xem JSON
                      </a>
                    </div>
                  )}
                </section>
              )}
              {tab === "positions" && snapshot?.observation && (
                <ObservationPositions
                  snapshot={snapshot}
                  onSelect={(value) =>
                    setSelectedPosition({ kind: "observation", value })
                  }
                />
              )}
              {tab === "positions" && !snapshot?.observation && (
                <section className="panel table-panel">
                  <div className="section-heading">
                    <div>
                      <h2>
                        Các vị thế được quản lý{" "}
                        <span className="count">
                          {metrics?.openPositions ?? 0} đang mở
                        </span>
                      </h2>
                      <p>
                        Vị thế trên mọi chuỗi vẫn được theo dõi khi chuyển chuỗi
                        hoặc tạm dừng quét.
                      </p>
                    </div>
                    <Badge>THOÁT LỆNH THEO QUY TẮC</Badge>
                  </div>
                  {snapshot?.source === "RPC" ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Chuỗi / token</th>
                            <th>Chế độ / ví</th>
                            <th>Số lượng còn lại (đơn vị nhỏ nhất)</th>
                            <th>Lãi/lỗ đã chốt (đơn vị tài sản định giá)</th>
                            <th>Trạng thái</th>
                            <th>Thao tác</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snapshot.managedPositions?.map((position) => (
                            <tr key={position.id}>
                              <td>
                                {shortChain(position.chainId)}
                                <br />
                                <button
                                  className="text-button"
                                  onClick={() =>
                                    setSelectedPosition({
                                      kind: "managed",
                                      value: position,
                                    })
                                  }
                                >
                                  <code>
                                    {shortAddress(position.tokenAddress)}
                                  </code>{" "}
                                  ↗
                                </button>
                              </td>
                              <td>
                                {position.mode}
                                <br />
                                {position.walletId}
                              </td>
                              <td>
                                <code>{position.remainingQuantity}</code>
                                <small>
                                  {" "}
                                  · {position.decimals} chữ số thập phân
                                </small>
                              </td>
                              <td>
                                <code>{position.realizedQuotePnl}</code>
                                <small>
                                  {" "}
                                  · {position.quoteDecimals} chữ số thập phân ·
                                  chưa gồm gas
                                </small>
                              </td>
                              <td>
                                {
                                  (
                                    {
                                      OPEN: "Đang mở",
                                      PARTIAL_EXIT: "Đã bán một phần",
                                      CLOSED: "Đã đóng",
                                      PENDING_ENTRY: "Đang chờ mua",
                                      PENDING_EXIT: "Đang chờ bán",
                                      FAILED: "Thất bại",
                                    } as Record<string, string>
                                  )[position.state]
                                }
                              </td>
                              <td>
                                <button
                                  className="subtle"
                                  disabled={
                                    busy ||
                                    position.state === "CLOSED" ||
                                    (position.mode !== "PAPER" &&
                                      position.mode !== "LIVE")
                                  }
                                  onClick={() => setCloseId(position.id)}
                                >
                                  Đóng vị thế
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {snapshot.managedPositions?.length === 0 && (
                        <p className="empty-state">
                          Chưa có vị thế từ dữ liệu thật.
                        </p>
                      )}
                    </div>
                  ) : (
                    <PositionTable positions={snapshot?.positions ?? []} />
                  )}
                </section>
              )}
              {tab === "research" && (
                <div className="history-details">
                  {snapshot?.discovery && (
                    <>
                      <EvmDiscoveryCoverage value={snapshot.discovery} />
                      <DiscoveryFunnel value={snapshot.discovery} />
                    </>
                  )}
                  <details className="panel page-details">
                    <summary>Thống kê quyết định và hiệu suất</summary>
                    <section className="panel equity-panel">
                      <div className="section-heading">
                        <div>
                          <h2>Hiệu suất</h2>
                          <p>
                            {snapshot?.source === "RPC"
                              ? "Kết quả từ dữ liệu thật; chưa rõ khi thiếu định giá hoặc phí"
                              : "Tính bằng USD mô phỏng"}
                          </p>
                        </div>
                        <Badge>TẤT CẢ CHUỖI</Badge>
                      </div>
                      {snapshot?.analytics ? (
                        <RealAnalytics value={snapshot.analytics} />
                      ) : (
                        <EquityChart positions={snapshot?.positions ?? []} />
                      )}
                    </section>
                  </details>
                  {snapshot?.rugAnalytics && snapshot.securityReadiness && (
                    <details className="panel page-details">
                      <summary>Thống kê rủi ro và độ phủ dữ liệu</summary>
                      <RugSecurityOverview
                        analytics={snapshot.rugAnalytics}
                        readiness={snapshot.securityReadiness}
                      />
                    </details>
                  )}
                  <details className="panel page-details">
                    <summary>Kết quả token sau khi phân tích</summary>
                    <section className="panel table-panel">
                      <div className="section-heading">
                        <div>
                          <h2>Theo dõi kết quả về sau</h2>
                          <p>
                            Lấy mẫu trong vòng 15 giây sau mỗi mốc thời gian.
                            Mẫu bị bỏ lỡ được ghi nhận là chưa rõ.
                          </p>
                        </div>
                        <Badge>1 phút · 5 phút · 15 phút · 1 giờ</Badge>
                      </div>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              {[
                                "Token",
                                "1 phút",
                                "5 phút",
                                "15 phút",
                                "1 giờ",
                                "Mức tăng cao nhất",
                                "Mức sụt giảm lớn nhất",
                              ].map((label) => (
                                <th key={label}>{label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {snapshot?.outcomes
                              .slice(-20)
                              .reverse()
                              .map((o) => (
                                <tr key={o.candidateId}>
                                  <td>
                                    {shortChain(o.chainId)} ·{" "}
                                    {o.tokenAddress.split(":").at(-1)}
                                  </td>
                                  {[60, 300, 900, 3600].map((h) => (
                                    <td key={h}>
                                      {o.prices[String(h)] === undefined
                                        ? "CHƯA RÕ"
                                        : price(o.prices[String(h)]!)}
                                    </td>
                                  ))}
                                  <td>
                                    {o.maxGainPct === undefined
                                      ? "—"
                                      : number(o.maxGainPct, 1)}
                                    %
                                  </td>
                                  <td>
                                    {o.maxDrawdownPct === undefined
                                      ? "—"
                                      : number(o.maxDrawdownPct, 1)}
                                    %
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  </details>
                </div>
              )}
            </>
          )}
          <footer>
            <span>
              <span className="dot green" />{" "}
              {snapshot?.source === "RPC"
                ? `DỮ LIỆU THẬT · ${snapshot.mode}`
                : "BỘ MÔ PHỎNG · Không có giao dịch tiền thật"}
            </span>
            <span>{APP_NAME} / Hạ tầng nghiên cứu</span>
          </footer>
        </main>
      </div>
      {selectedPosition && snapshot && (
        <PositionDetail
          position={selectedPosition}
          snapshot={snapshot}
          onDismiss={() => setSelectedPosition(undefined)}
          onClose={(id) => {
            setSelectedPosition(undefined);
            setCloseId(id);
          }}
        />
      )}
      {entryControl && (
        <div className="modal-backdrop">
          <section
            className="panel confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="entry-title"
          >
            <h2 id="entry-title">
              {entryControl === "kill"
                ? "Dừng mở vị thế mới?"
                : "Yêu cầu khôi phục lệnh mới?"}
            </h2>
            <p>
              {entryControl === "kill"
                ? "Chặn lệnh mua mới. Bot tiếp tục theo dõi và xử lý thoát vị thế theo quy tắc hiện tại."
                : "Backend sẽ kiểm tra lại các điều kiện. Thao tác này không bật giao dịch LIVE hoặc bỏ qua RiskEngine."}
            </p>
            <div className="dialog-actions">
              <button
                className="subtle"
                disabled={busy}
                onClick={() => setEntryControl(undefined)}
              >
                Hủy
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={() => {
                  void mutate("control", "POST", { action: entryControl })
                    .then(() => setEntryControl(undefined))
                    .catch(() => {});
                }}
              >
                Xác nhận
              </button>
            </div>
          </section>
        </div>
      )}
      {closeId && (
        <div className="modal-backdrop">
          <section
            className="panel confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-title"
          >
            <h2 id="close-title">Xác nhận đóng vị thế</h2>
            <p>
              Hệ thống sẽ lấy báo giá bán mới cho toàn bộ số lượng còn lại. Lệnh
              có thể bị từ chối khi tuyến bán không khả dụng.
            </p>
            <code>{closeId}</code>
            <div className="dialog-actions">
              <button
                className="subtle"
                disabled={busy}
                onClick={() => setCloseId(undefined)}
              >
                Hủy
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void api("position-close", "POST", {
                    positionId: closeId,
                    confirm: true,
                  })
                    .then(() => {
                      setCloseId(undefined);
                      return refresh();
                    })
                    .catch((error) => setError((error as Error).message))
                    .finally(() => setBusy(false));
                }}
              >
                {snapshot?.managedPositions?.find((p) => p.id === closeId)
                  ?.mode === "LIVE"
                  ? "Xác nhận bán bằng tiền thật"
                  : "Xác nhận đóng trên giấy"}
              </button>
            </div>
          </section>
        </div>
      )}
      {allControl && (
        <div className="modal-backdrop">
          <section
            className="panel confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="all-title"
          >
            <h2 id="all-title">
              {allControl === "disable-all"
                ? "Dừng toàn bộ giao dịch?"
                : "Khôi phục giao dịch?"}
            </h2>
            <p>
              {allControl === "disable-all"
                ? "Thao tác này chặn cả mua và bán, bao gồm cắt lỗ và chốt lời. Giao dịch đã phát vẫn được đối soát. Chỉ dùng khi cần ngăn mọi giao dịch mới."
                : "Cho phép xử lý thoát vị thế trở lại. Quy tắc rủi ro và khóa chặn lệnh mua vẫn áp dụng."}
            </p>
            <div className="dialog-actions">
              <button
                className="subtle"
                disabled={busy}
                onClick={() => setAllControl(undefined)}
              >
                Hủy
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  void mutate("control", "POST", {
                    action: allControl,
                    confirm: true,
                  })
                    .then(() => setAllControl(undefined))
                    .catch(() => {});
                }}
              >
                Xác nhận
              </button>
            </div>
          </section>
        </div>
      )}
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(undefined)}>
          <section
            className="detail-modal panel"
            role="dialog"
            aria-modal="true"
            aria-label="Phân tích token"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-heading">
              <div>
                <div className="eyebrow">PHÂN TÍCH ĐÃ CHUẨN HÓA</div>
                <h2>
                  {selected.state?.identity.symbol ?? "Token chưa rõ"} ·{" "}
                  {selected.event.chainId}
                </h2>
              </div>
              <button className="subtle" onClick={() => setSelected(undefined)}>
                Đóng ✕
              </button>
            </div>
            <div className="detail-summary">
              <Badge
                tone={
                  selected.action === "BUY"
                    ? "green"
                    : selected.action === "REJECT"
                      ? "red"
                      : "muted"
                }
              >
                {actionLabel(selected.action)}
              </Badge>
              <span>{selected.reasons.map(reasonLabel).join(" · ")}</span>
            </div>
            <p>
              Trường thiếu dữ liệu được coi là chưa rõ.{" "}
              {selected.event.source === "RPC"
                ? "Nguồn blockchain; chất lượng và xuất xứ từng trường được lưu trong dữ liệu phân tích."
                : "Dữ liệu bên dưới là giả lập."}
            </p>
            <DecisionPanels candidate={selected} />
            {selected.rugCheck && (
              <RugCheckReport snapshot={selected.rugCheck} />
            )}
            <details className="raw-details">
              <summary>
                Chi tiết quyết định và trạng thái chuẩn hóa · JSON
              </summary>
              <p>
                Tên trường và mã trạng thái trong JSON được giữ nguyên để đối
                chiếu API.
              </p>
              <pre>{JSON.stringify(selected, null, 2)}</pre>
            </details>
          </section>
        </div>
      )}
      <div className="observation-toasts" role="log" aria-live="polite">
        {toasts.map((t) => (
          <div className="observation-toast" key={t.id}>
            <strong>{t.text}</strong>
            <p>Thông báo quan sát · không có giao dịch blockchain</p>
            <button
              aria-label="Đóng thông báo"
              onClick={() =>
                setToasts((items) => items.filter((item) => item.id !== t.id))
              }
            >
              Đóng
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
