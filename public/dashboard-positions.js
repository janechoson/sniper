import "./token-avatar.js";
import { setupPositionHelpers } from "./dashboard-position-tools.js";
import {
  sol,
  tokenQuantity,
  pnlText,
  accountingSol,
  accountingFeeText,
  accountingFeeDetails,
  accountingEntryPrice,
} from "./dashboard-core.js";
export async function mount(ctx) {
  setupPositionHelpers(ctx);
  window.BOTPositions = (() => {
    const cache = new Map(),
      queued = new Map();
    const node = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text !== undefined)
        n.textContent =
          /token-name|position-avatar|token-avatar/.test(cls || "") ||
          (tag === "dd" && /^[A-Z0-9_ /]+$/.test(String(text)))
            ? String(text)
            : window.BOTText.vi(text);
      if (cls) n.className = cls;
      if (cls?.includes("strategy-badge") && ["KRONOS"].includes(text))
        n.dataset.strategy = text;
      return n;
    };
    const state = (p) =>
      p.displayState ||
      p.attention?.status ||
      (p.state === "PENDING_EXIT" ? "EXIT_PENDING" : p.state);
    const priority = (p) =>
      ({
        NEEDS_ATTENTION: 0,
        UNKNOWN: 1,
        EXIT_PENDING: 2,
        MONITORING_DEGRADED: 3,
        OPEN: 4,
      })[state(p)] ?? 1;
    const tone = (n) =>
      n === null || n === 0n ? "muted" : n < 0n ? "negative" : "positive";
    const percent = (n, cost) =>
      n === null || cost <= 0n
        ? "—"
        : `${n > 0n ? "+" : ""}${(Number((n * 10000n) / cost) / 100).toFixed(2)}%`;
    const signedSol = (n, h) =>
      n === null ? "—" : `${n > 0n ? "+" : ""}${h.sol(n)} SOL`;
    const human = (text) =>
      String(text || "Unavailable")
        .toLowerCase()
        .replaceAll("_", " ")
        .replace(/^./, (c) => c.toUpperCase());
    function relative(at, countdown = false) {
      if (!Number.isFinite(at)) return "—";
      const seconds = Math.max(
        0,
        Math.floor((countdown ? at - Date.now() : Date.now() - at) / 1000),
      );
      if (countdown && !seconds) return "Retry due · awaiting next check";
      const h = Math.floor(seconds / 3600),
        m = Math.floor((seconds % 3600) / 60),
        s = seconds % 60;
      return (
        (countdown ? "Retry in " : "") +
        (h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`)
      );
    }
    function time(at, countdown = false) {
      const n = node("span", relative(at, countdown));
      if (Number.isFinite(at)) {
        n.dataset.positionTime = String(at);
        if (countdown) n.dataset.countdown = "true";
        n.title = window.BOTText.vi(new Date(at).toLocaleString("vi-VN"));
      }
      return n;
    }
    function metric(label, value, cls = "") {
      const item = node("div", undefined, "position-metric");
      item.append(
        node("span", label, "position-label"),
        node("strong", value, cls),
      );
      return item;
    }
    function usd(value) {
      if (
        value === undefined ||
        value === null ||
        value === "" ||
        !Number.isFinite(Number(value)) ||
        Number(value) <= 0
      )
        return "—";
      const n = Number(value);
      return "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
    }
    function totals(p) {
      const a = p.accounting;
      return {
        unrealized:
          a?.grossUnrealizedPnlLamports == null
            ? null
            : BigInt(a.grossUnrealizedPnlLamports),
        realized:
          a?.grossRealizedPnlLamports == null
            ? null
            : BigInt(a.grossRealizedPnlLamports),
        total: a?.grossPnlLamports == null ? null : BigInt(a.grossPnlLamports),
      };
    }
    function makeCard(p, token, status, h) {
      const display = state(p),
        attention = !!p.attention || p.requiresAttention;
      const { unrealized, realized, total } = totals(p),
        cost = BigInt(p.accounting?.principalLamports ?? "0");
      const card = node(
        "article",
        undefined,
        "position position-card" + (attention ? " has-attention" : ""),
      );
      card.dataset.positionId = p.id;
      card.dataset.valuationAt = String(p.lastQuoteAt ?? 0);
      card.dataset.valuationUncertain = String(
        p.state === "PENDING_EXIT" ||
          p.valuationStatus === "ESTIMATED_AFTER_FILL" ||
          (p.valuationQuantity !== undefined &&
            p.valuationQuantity !== p.quantity),
      );
      card.setAttribute(
        "aria-label",
        window.BOTText.vi(`${p.symbol || token?.symbol || "Token"} position`),
      );
      const symbol = p.symbol || token?.symbol || "Unknown Token",
        name = token?.name || p.name || symbol;
      const header = node("div", undefined, "position-card-header");
      const identity = node("div", undefined, "position-identity");
      const avatar =
        window.BOTTokenAvatar?.create(
          { ...token, ...p, logo: window.BOTTokenAvatar.logo(token) || p.logo },
          "position-avatar",
        ) || node("span", symbol.slice(0, 2).toUpperCase(), "position-avatar");
      avatar.setAttribute("aria-hidden", "true");
      const title = node("div");
      title.append(
        node(
          "h3",
          name + (name !== symbol ? ` (${symbol})` : ""),
          "token-name",
        ),
        node("small", p.strategy || "LEGACY", "strategy-badge"),
      );
      const mint = node(
        "button",
        `${p.mint.slice(0, 6)}…${p.mint.slice(-6)}`,
        "position-mint",
      );
      mint.title = window.BOTText.vi(p.mint + " · Click to copy");
      mint.setAttribute(
        "aria-label",
        window.BOTText.vi(`Copy mint for ${symbol}`),
      );
      mint.onclick = async () => {
        try {
          await window.navigator.clipboard.writeText(p.mint);
          mint.textContent = window.BOTText.vi("Copied ✓");
          ctx.timeout(() => {
            mint.textContent = window.BOTText.vi(
              `${p.mint.slice(0, 6)}…${p.mint.slice(-6)}`,
            );
          }, 1600);
        } catch {
          mint.textContent = window.BOTText.vi("Copy unavailable");
        }
      };
      title.append(mint);
      identity.append(avatar, title);
      const badges = node("div", undefined, "position-status-stack");
      const icon =
        display === "OPEN"
          ? "●"
          : display === "UNKNOWN"
            ? "?"
            : display === "EXIT_PENDING"
              ? "◌"
              : "⚠";
      const badge = node(
        "span",
        `${icon} ${display.replaceAll("_", " ")}`,
        "position-state state-" + display.toLowerCase(),
      );
      if (display === "EXIT_PENDING") badge.classList.add("is-selling");
      badges.append(
        badge,
        node("span", p.mode.toUpperCase(), "position-mode"),
        window.BOTRemovalMenu("position", p),
      );
      header.append(identity, badges);
      const pnl = node("div", undefined, "position-pnl " + tone(total));
      pnl.append(
        node("span", "PnL · trước phí", "position-label"),
        node("strong", percent(total, cost), "position-pnl-percent"),
        node("span", signedSol(total, h), "position-pnl-sol"),
      );
      pnl.title =
        "Lãi/lỗ của vị thế trước phí. Valuation: GMGN mark-to-market, không phải executable SELL quote.";
      const values = node("div", undefined, "position-metric-grid");
      const reconciledHolding =
        BigInt(p.quantity) > 0n && p.state !== "PENDING_ENTRY";
      values.append(
        metric(
          "Invested",
          reconciledHolding
            ? accountingSol(p.accounting?.principalLamports)
            : "—",
        ),
        metric(
          "Current value",
          p.lastValueLamports === undefined
            ? "—"
            : `${h.sol(p.lastValueLamports)} SOL`,
        ),
        metric(
          "Holding",
          reconciledHolding
            ? `${h.tokenQuantity(p.quantity, p.decimals)} ${symbol}`
            : "—",
        ),
      );
      const fees = metric(
        "Fee · đã phát sinh",
        accountingFeeText(p.accounting),
      );
      fees.title = accountingFeeDetails(p.accounting);
      const net = metric(
        "Net PnL",
        accountingSol(p.accounting?.netPnlLamports),
      );
      net.title =
        "PnL sau khi trừ phí đã phát sinh. — nếu rent/fee chưa đủ evidence.";
      values.append(fees, net);
      const market = node(
        "div",
        undefined,
        "position-metric-grid position-secondary",
      );
      const currentPrice =
        token?.market?.priceUsd ??
        (token?.market?.price?.state === "KNOWN"
          ? token.market.price.value
          : undefined);
      const current = metric("Current price", usd(currentPrice));
      current.title = window.BOTText.vi(
        "Latest available GMGN token snapshot; may differ in time from position valuation.",
      );
      const age = metric("Position age", "");
      age.lastChild.replaceChildren(time(p.entryAt));
      market.append(
        metric("Entry price", accountingEntryPrice(p)),
        current,
        age,
      );
      const performance = node("div", undefined, "position-performance");
      const excursion = (n) =>
        Number.isFinite(n) ? `${n > 0 ? "+" : ""}${n.toFixed(2)}%` : "—";
      performance.append(
        metric(
          "MFE",
          excursion(p.mfePercent),
          Number.isFinite(p.mfePercent) ? "positive" : "muted",
        ),
        metric(
          "MAE",
          excursion(p.maePercent),
          Number.isFinite(p.maePercent) ? "negative" : "muted",
        ),
        metric("Unrealized", signedSol(unrealized, h), tone(unrealized)),
        metric("Realized", signedSol(realized, h), tone(realized)),
      );
      card.append(header, pnl, values, market, performance);
      const management = node("div", undefined, "position-management");
      const monitoringLabel =
        p.monitoring?.status === "ACTIVE"
          ? "ĐANG THEO DÕI"
          : p.monitoring?.status === "DEGRADED"
            ? "GIÁN ĐOẠN"
            : "CHƯA CÓ DỮ LIỆU";
      const exitLabel =
        {
          UNKNOWN: "CHỜ ĐỐI SOÁT",
          WAITING_RECONCILIATION: "CHỜ ĐỐI SOÁT VÍ",
          BACKOFF: "CHỜ THỬ LẠI",
          PENDING: "ĐANG CHỜ",
          READY: "SẴN SÀNG",
        }[p.exitState] ||
        (p.attention?.issue.stage === "PRE_SELL" &&
        p.attention.nextCheckAt > Date.now()
          ? "CHỜ THỬ LẠI"
          : "SẴN SÀNG");
      const pendingLabel = p.pendingExits?.length
        ? p.pendingExits
            .map((x) =>
              x.kind === "STRATEGIC"
                ? "KRONOS" + " · BÁN " + x.sellBps / 100 + "%"
                : x.kind === "TAKE_PROFIT"
                  ? "TP" + (x.takeProfitIndex + 1)
                  : x.kind === "TRAILING"
                    ? "BÁM ĐUÔI"
                    : /liquidity/i.test(x.reason)
                      ? "THANH KHOẢN"
                      : /security/i.test(x.reason)
                        ? "BẢO MẬT"
                        : "BẢO VỆ",
            )
            .join(" · ")
        : "KHÔNG CÓ";
      management.append(
        metric("Theo dõi", monitoringLabel),
        metric("Thực thi thoát lệnh", exitLabel),
        metric("Lệnh thoát đang chờ", pendingLabel),
      );
      management.title = p.monitoring?.lastSuccessAt
        ? "Quan sát thành công gần nhất: " +
          new Date(p.monitoring.lastSuccessAt).toLocaleString("vi-VN")
        : "Chưa có quan sát mới sau khi nâng cấp";
      card.append(management);
      const strategic = node("div", undefined, "position-strategy");
      if (p.strategy === "KRONOS") {
        const k = p.kronosDecision;
        strategic.replaceChildren(
          node("b", "KRONOS · " + (k?.action || "CHỜ DỮ LIỆU M1")),
          node("p", "Strategy: KRONOS · Strategic exit authority: KRONOS"),
          node(
            "small",
            "Manual exit, Security critical và liquidity collapse có quyền an toàn riêng.",
          ),
        );
        if (k) strategic.append(node("p", k.reason), time(k.decisionAt));
      }
      if (p.safetyState) {
        const safety = p.safetyState;
        if (
          safety.latestAnalyst === "NO_DECISION" &&
          ["FULL_SELL", "PARTIAL_SELL"].includes(safety.strategic)
        )
          strategic.append(
            node(
              "p",
              "Đề xuất SELL trước đó vẫn chờ kiểm tra hiệu lực; lỗi analyst không thu hồi quyền này.",
            ),
          );
        strategic.append(
          node(
            "p",
            "Bảo vệ: " +
              ({
                NONE: "Chưa có tín hiệu thoát bảo vệ",
                PENDING: "Đang chờ thực thi",
                BLOCKED: "Đang bị chặn",
              }[safety.protective] || "Đang kiểm tra"),
          ),
        );
        if (
          safety.protections?.some(
            (o) => o.retry?.classification === "NO_ROUTE",
          )
        )
          strategic.append(
            node(
              "p",
              "Cần thoát nhưng chưa có route · tiếp tục kiểm tra có giới hạn",
              "negative",
            ),
          );
        if (safety.execution === "EXECUTION_BLOCKED_BY_UNKNOWN_TX") {
          const message = node(
            "p",
            "Thực thi bị khóa bởi giao dịch chưa rõ kết quả · đang đối soát",
            "negative",
          );
          message.title = safety.blocker?.signature || "";
          strategic.append(message);
        }
      }
      if (p.finalExitAction && p.finalExitAction.authority !== "HISTORICAL")
        strategic.append(
          node(
            "p",
            "Quyền ưu tiên gần nhất: " +
              (p.finalExitAction.authority === "MANUAL"
                ? "Người dùng"
                : p.finalExitAction.authority === "KRONOS"
                  ? "Kronos strategy"
                  : "Bảo vệ an toàn"),
          ),
        );
      strategic.append(
        node(
          "p",
          "⚠ Định giá cũ hoặc ước tính sau khớp lệnh; cần quan sát mới",
          "negative valuation-warning",
        ),
      );
      card.append(strategic);
      const original = BigInt(p.originalQuantity),
        remaining = BigInt(p.quantity),
        exposure =
          original > 0n ? Number((remaining * 10000n) / original) / 100 : null;
      const exposureBox = node("div", undefined, "position-management");
      exposureBox.append(
        metric(
          "Tỷ lệ đang giữ",
          exposure === null ? "CHƯA CÓ" : exposure + "% lượng mua ban đầu",
        ),
        metric("Cách tính bán một phần", "% của lượng đang giữ"),
      );
      if (p.runner?.marketMultiple >= 2)
        exposureBox.append(
          metric(
            "ĐANG CHẠY",
            `x${p.runner.marketMultiple.toFixed(2)} giá thị trường so với lúc vào`,
          ),
        );
      card.append(exposureBox);
      if (p.discovery?.sources) {
        const d = p.discovery,
          t = d.trending,
          sourceBox = node("div", undefined, "position-discovery");
        sourceBox.append(
          node(
            "b",
            d.sources
              .map((s) => (s === "TRENDING" ? "XU HƯỚNG" : "SĂN SỚM"))
              .join(" + "),
          ),
        );
        if (t)
          sourceBox.append(
            node(
              "small",
              `Hạng quan sát ${t.rank === undefined ? "chưa có" : "#" + t.rank} · ${new Date(t.lastSeenAt).toLocaleTimeString("vi-VN")} · ${t.stale ? "Dữ liệu cũ" : "Theo cửa sổ của nguồn"}`,
            ),
          );
        card.append(sourceBox);
      }
      card.append(window.BOTExitPanel(p.exitLiquidity, p.quantity));
      const flow = p.flow,
        flowBox = node("div", undefined, "position-capital-flow");
      const regimes = {
        STRONG_INFLOW: "DÒNG MUA MẠNH",
        INFLOW_ACCELERATING: "DÒNG MUA TĂNG TỐC",
        HEALTHY_EXPANSION: "MỞ RỘNG LÀNH MẠNH",
        INFLOW_DECELERATING: "DÒNG MUA GIẢM TỐC",
        NEUTRAL: "TRUNG TÍNH",
        DISTRIBUTION: "PHÂN PHỐI",
        OUTFLOW: "DÒNG BÁN CHIẾM ƯU THẾ",
        OUTFLOW_ACCELERATING: "DÒNG BÁN TĂNG TỐC",
        INSUFFICIENT_DATA: "CHƯA ĐỦ DỮ LIỆU",
      };
      flowBox.append(
        node(
          "b",
          "DÒNG TIỀN · " + (regimes[flow?.regime] || regimes.INSUFFICIENT_DATA),
        ),
      );
      if (flow) {
        flowBox.dataset.flowAt = String(flow.at);
        flowBox.append(
          node(
            "small",
            `Độ tin cậy ${Math.round(flow.confidence * 100)}% · Cửa sổ ${flow.window} · ${flow.quality.observations} quan sát`,
          ),
        );
        const f = flow.features,
          grid = node("div", undefined, "position-metric-grid");
        const change = (v) =>
          v === null || v === undefined
            ? "CHƯA CÓ"
            : `${v >= 20 ? "↑↑" : v > 5 ? "↑" : v <= -20 ? "↓↓" : v < -5 ? "↓" : "→"} ${v.toFixed(1)}%`;
        grid.append(
          metric("Volume", change(f.volumeChangePercent)),
          metric(
            "Chênh lệch mua − bán",
            f.netFlowUsd === null
              ? "CHƯA CÓ"
              : new Intl.NumberFormat("vi-VN", {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 2,
                }).format(f.netFlowUsd),
            f.netFlowUsd < 0 ? "negative" : "muted",
          ),
          metric(
            "Áp lực mua",
            f.buyPressure === null
              ? "CHƯA CÓ"
              : (f.buyPressure * 100).toFixed(0) + "%",
          ),
          metric("Thanh khoản", change(f.liquidityChangePercent)),
          metric(
            "Dòng smart-money",
            f.smartMoneyNetFlowUsd === null
              ? "CHƯA CÓ"
              : String(f.smartMoneyNetFlowUsd),
          ),
        );
        const detail = node("details", undefined, "position-details");
        detail.dataset.detailPanel = "capital-flow";
        detail.append(
          node("summary", "Diễn biến dòng tiền và dữ liệu còn thiếu"),
          grid,
        );
        for (const t of flow.transitions.slice(-8))
          detail.append(
            node(
              "p",
              new Date(t.at).toLocaleTimeString("vi-VN") +
                " · " +
                (regimes[t.to] || t.to),
            ),
          );
        const missingNames = {
          smartMoneyBuyUsd: "volume mua smart-money",
          smartMoneySellUsd: "volume bán smart-money",
          largeBuyUsd: "volume mua lớn",
          largeSellUsd: "volume bán lớn",
          holders: "số người nắm giữ",
          smartWallets: "số ví smart-money",
          buyVolumeUsd: "volume mua",
          sellVolumeUsd: "volume bán",
          volumeUsd: "volume",
          buys: "số lượt mua",
          sells: "số lượt bán",
          priceUsd: "giá",
          marketCapUsd: "vốn hóa",
          liquidityUsd: "thanh khoản",
        };
        detail.append(
          node(
            "p",
            "Chưa có: " +
              (flow.quality.missing
                .map((k) => missingNames[k] || k)
                .join(", ") || "Không có"),
          ),
          node(
            "small",
            "Chênh lệch volume DEX theo cửa sổ trượt, không phải tiền nạp ròng. Không dự đoán đỉnh hoặc giá tương lai.",
          ),
        );
        flowBox.append(detail);
      }
      card.append(flowBox);
      if (p.attention) {
        const a = p.attention,
          warning = node("div", undefined, "position-warning");
        warning.append(
          node(
            "b",
            a.issue.stage === "PRE_SELL"
              ? "⚠ SELL SAFETY"
              : "⚠ " + human(a.status).toUpperCase(),
          ),
          node("span", a.issue.code, "position-warning-code"),
          node("p", human(a.issue.reasonCode)),
        );
        const retry = node("div", undefined, "position-retry");
        retry.append(
          node(
            "span",
            a.issue.stage === "PRE_SELL"
              ? `Protective exit · ${a.protectiveExit} · vẫn theo dõi thị trường`
              : "Kiểm tra lại dữ liệu thị trường",
          ),
          time(a.nextCheckAt, true),
        );
        warning.append(retry);
        card.append(warning);
      } else if (display === "UNKNOWN" || display === "EXIT_PENDING") {
        card.append(
          node(
            "div",
            display === "UNKNOWN"
              ? "Transaction reconciliation in progress. Additional SELL requests are unavailable."
              : "SELL in progress · awaiting confirmation and reconciliation.",
            "position-pending-note",
          ),
        );
      }
      const actions = node("div", undefined, "position-actions");
      const pending = queued.get(p.id),
        sellable =
          p.state === "OPEN" &&
          display !== "UNKNOWN" &&
          display !== "EXIT_PENDING" &&
          !pending;
      for (const percentage of [50, 100]) {
        const label =
          percentage === 50
            ? "Sell 50%"
            : attention
              ? "Emergency full exit"
              : "Sell 100%";
        const b = node(
          "button",
          pending
            ? "◌ Queued"
            : display === "EXIT_PENDING"
              ? "◌ Selling"
              : label,
          percentage === 100 ? "position-sell-full" : "",
        );
        b.disabled = !sellable;
        b.dataset.sellPercent = String(percentage);
        b.title = window.BOTText.vi(
          !sellable
            ? "Wait for queued execution or transaction reconciliation"
            : "Uses the existing checked and confirmed SELL flow",
        );
        b.onclick = async () => {
          if (
            !window.confirm(
              window.BOTText.vi(`Queue ${percentage}% SELL in ${p.mode} mode?`),
            )
          )
            return;
          queued.set(p.id, Date.now());
          actions.querySelectorAll("button").forEach((button) => {
            button.disabled = true;
            button.textContent = window.BOTText.vi("◌ Queued");
          });
          try {
            await h.post("/api/exit", {
              positionId: p.id,
              sellPercent: percentage,
            });
          } catch (e) {
            queued.delete(p.id);
            cache.delete(p.id);
            actions.querySelectorAll("button").forEach((button, index) => {
              button.disabled = false;
              button.textContent = window.BOTText.vi(
                index
                  ? attention
                    ? "Emergency full exit"
                    : "Sell 100%"
                  : "Sell 50%",
              );
            });
            h.error(e);
          }
        };
        actions.append(b);
      }
      const chips = node("div", undefined, "position-strategy");
      chips.append(node("span", "NO STOP LOSS"));
      chips.title =
        "KRONOS quyết định thoát lệnh; kiểm tra an toàn và lệnh thoát thủ công vẫn được giữ nguyên.";
      chips.prepend(node("span", "KRONOS QUẢN LÝ THOÁT LỆNH"));
      card.append(actions, chips);
      const footer = node("div", undefined, "position-card-footer");
      const valuation = node("span", "Valuation: GMGN · ");
      valuation.append(
        p.lastQuoteAt ? time(p.lastQuoteAt) : node("span", "unavailable"),
      );
      valuation.title = window.BOTText.vi(
        "Estimated value excludes future SELL costs." +
          (p.lastQuoteAt
            ? " Updated " + new Date(p.lastQuoteAt).toLocaleString("vi-VN")
            : ""),
      );
      const txs = node("div", undefined, "position-tx-links");
      for (const [label, signature] of [
        ["BUY", p.signature],
        ["SELL", p.sellSignature],
      ]) {
        if (!signature) continue;
        const link = node("a", label + " TX ↗");
        link.href = `https://solscan.io/tx/${encodeURIComponent(signature)}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = window.BOTText.vi(signature);
        txs.append(link);
      }
      footer.append(valuation, txs);
      card.append(footer);
      const details = node("details", undefined, "position-details");
      details.dataset.detailPanel = "position";
      details.append(node("summary", "View details"));
      const dl = node("dl");
      for (const [label, value] of [
        ["Mint", p.mint],
        ["Opened", new Date(p.entryAt).toLocaleString("vi-VN")],
        ["Remaining cost basis", `${h.sol(p.remainingCostLamports)} SOL`],
        ["State", `${p.state} / ${display}`],
        ["Exit status", p.exitStatus || "Not supplied"],
        [
          "Valuation",
          p.lastQuoteAt
            ? new Date(p.lastQuoteAt).toLocaleString("vi-VN") +
              " · excludes future SELL costs"
            : "Unavailable",
        ],
        [
          "Last check",
          p.attention
            ? new Date(p.attention.lastChecked).toLocaleString("vi-VN")
            : "—",
        ],
        [
          "Next retry",
          p.attention
            ? new Date(p.attention.nextCheckAt).toLocaleString("vi-VN")
            : "—",
        ],
        ["Reason code", p.attention?.issue.reasonCode || "—"],
        ["Stage", p.attention?.issue.stage || "—"],
        ["BUY signature", p.signature || "—"],
        ["SELL signature", p.sellSignature || "—"],
      ])
        dl.append(
          node("dt", label),
          node(
            "dd",
            value,
            label === "Mint" || label.includes("signature")
              ? "token-name"
              : undefined,
          ),
        );
      details.append(dl);
      card.append(details);
      return card;
    }
    function render(positions, tokens, status, h) {
      const root = document.getElementById("positionRows"),
        portfolio = document.getElementById("positionPortfolio");
      const byMint = new Map(tokens.map((t) => [t.mint, t]));
      document.getElementById("positionActiveCount").textContent =
        window.BOTText.vi(`${positions.length} ACTIVE`);
      const attentionCount = positions.filter(
        (p) => p.requiresAttention || p.attention || state(p) !== "OPEN",
      ).length;
      const complete = positions.every(
        (p) => p.lastValueLamports !== undefined && BigInt(p.quantity) > 0n,
      );
      const basisKnown = positions.every(
        (p) =>
          p.accounting?.remainingPrincipalLamports != null &&
          BigInt(p.quantity) > 0n &&
          p.state !== "PENDING_ENTRY",
      );
      const invested = positions.reduce(
        (n, p) => n + BigInt(p.accounting?.remainingPrincipalLamports ?? "0"),
        0n,
      );
      const value = complete
        ? positions.reduce((n, p) => n + BigInt(p.lastValueLamports), 0n)
        : null;
      const unrealized =
        value === null || !basisKnown ? null : value - invested;
      const summary = [
        metric("Active", String(positions.length)),
        metric("Invested", basisKnown ? `${h.sol(invested)} SOL` : "—"),
        metric("Current value", value === null ? "—" : `${h.sol(value)} SOL`),
        metric("Unrealized PnL", signedSol(unrealized, h), tone(unrealized)),
        metric(
          "⚠ Attention",
          String(attentionCount),
          attentionCount ? "negative" : "muted",
        ),
      ];
      summary[1].title = window.BOTText.vi(
        "Remaining cost basis of active holdings; card Invested shows original entry cost.",
      );
      summary[3].append(
        node("span", percent(unrealized, invested), tone(unrealized)),
      );
      summary[4].tabIndex = 0;
      summary[4].role = "button";
      summary[4].title = window.BOTText.vi(
        "Scroll to the first position requiring attention",
      );
      const scroll = () =>
        root
          .querySelector(".has-attention, .state-unknown, .state-exit_pending")
          ?.closest(".position-card")
          ?.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? "instant"
              : "smooth",
            block: "center",
          });
      summary[4].onclick = scroll;
      summary[4].onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          scroll();
        }
      };
      portfolio.replaceChildren(...summary);
      const ids = new Set(positions.map((p) => p.id));
      for (const [id, old] of cache)
        if (!ids.has(id)) {
          cache.delete(id);
          queued.delete(id);
          old.card.classList.add("position-leaving");
          old.card.inert = true;
          old.card.querySelectorAll("button").forEach((button) => {
            button.disabled = true;
          });
          if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
            old.card.remove();
          else ctx.timeout(() => old.card.remove(), 160);
        }
      positions.forEach((p, index) => {
        const token = byMint.get(p.mint);
        if (
          queued.has(p.id) &&
          (p.state !== "OPEN" || p.attention?.lastChecked > queued.get(p.id))
        )
          queued.delete(p.id);
        const fingerprint = JSON.stringify([
          p,
          token?.name,
          token?.symbol,
          window.BOTTokenAvatar?.logo(token),
          token?.market,
          queued.get(p.id),
        ]);
        let old = cache.get(p.id);
        if (!old || old.fingerprint !== fingerprint) {
          const card = makeCard(p, token, status, h);
          if (p.attention && !old?.attention)
            card.classList.add("position-attention-new");
          if (old) {
            const focused = old.card.contains(document.activeElement)
              ? document.activeElement
              : null;
            const focusSelector = focused?.dataset.sellPercent
              ? `[data-sell-percent="${focused.dataset.sellPercent}"]`
              : focused?.classList.contains("position-mint")
                ? ".position-mint"
                : focused?.tagName === "SUMMARY"
                  ? "summary"
                  : null;
            for (const panel of card.querySelectorAll(
              "details[data-detail-panel]",
            ))
              panel.open =
                old.card.querySelector(
                  `details[data-detail-panel="${panel.dataset.detailPanel}"]`,
                )?.open || false;
            if (old.pnl !== String(totals(p).total))
              card
                .querySelector(".position-pnl")
                .classList.add("position-value-updated");
            old.card.replaceWith(card);
            if (focusSelector)
              card.querySelector(focusSelector)?.focus({ preventScroll: true });
          } else card.classList.add("position-entering");
          old = {
            card,
            fingerprint,
            pnl: String(totals(p).total),
            attention: !!p.attention,
          };
          cache.set(p.id, old);
        }
        if (root.children[index] !== old.card)
          root.insertBefore(old.card, root.children[index] || null);
      });
      tick();
    }
    function tick() {
      document
        .querySelectorAll(".exit-liquidity-panel[data-expires-at]")
        .forEach((box) => {
          const stale = Date.now() > Number(box.dataset.expiresAt);
          box.classList.toggle("exit-estimate-stale", stale);
          box.querySelector(".exit-estimate-age").textContent = stale
            ? "Ước tính đã cũ"
            : "";
        });
      document
        .querySelectorAll(".position-card[data-valuation-at]")
        .forEach((card) => {
          const warning = card.querySelector(".valuation-warning");
          if (warning)
            warning.hidden = !(
              card.dataset.valuationUncertain === "true" ||
              !Number(card.dataset.valuationAt) ||
              Date.now() - Number(card.dataset.valuationAt) > 60000
            );
          const flow = card.querySelector("[data-flow-at]");
          if (flow)
            flow.classList.toggle(
              "flow-stale",
              Date.now() - Number(flow.dataset.flowAt) > 90000,
            );
        });
      document.querySelectorAll("[data-position-time]").forEach((n) => {
        n.textContent = window.BOTText.vi(
          relative(
            Number(n.dataset.positionTime),
            n.dataset.countdown === "true",
          ),
        );
      });
    }
    return { render, priority, tick };
  })();

  const refresh = async () => {
    const data = await ctx.get("/api/positions?view=page");
    ctx.legacyPositionCount?.(data.positions.length);
    window.BOTPositions.render(
      data.positions,
      data.positions,
      { ...ctx.shell(), settings: data.settings },
      { sol, tokenQuantity, pnlText, post: ctx.post, error: ctx.error },
    );
    document
      .getElementById("positionEmpty")
      .classList.toggle("hidden", data.positions.length > 0);
  };
  ctx.setRefresh(refresh);
  ctx.interval(() => window.BOTPositions?.tick(), 1000);
  ctx.onDispose(() => {
    window.BOTPositions = undefined;
  });
  await ctx.poll(refresh, 5000);
}
