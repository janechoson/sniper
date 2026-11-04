import "./token-avatar.js";
import {
  accountingSol,
  accountingFeeDetails,
  accountingEntryPrice,
} from "./dashboard-core.js";
export async function mount(ctx) {
  /* Backend-driven overview. No simulated progress, countdown or trade path. */
  window.BOTOverview = (() => {
    const $ = (id) => document.getElementById(id);
    const node = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      if (
        cls?.includes("strategy-badge") &&
        ["STANDARD", "KRONOS"].includes(text)
      )
        n.dataset.strategy = text;
      return n;
    };
    const val = (x) => (x?.state === "KNOWN" ? x.value : null);
    const number = (x) =>
      x === null || x === undefined || !Number.isFinite(Number(x))
        ? "N/A"
        : Number(x).toLocaleString("en-US", { maximumFractionDigits: 8 });
    const usd = (x) =>
      x === null || x === undefined ? "N/A" : "$" + number(x);
    const sol = (x) =>
      x === null || x === undefined ? "N/A" : number(Number(x) / 1e9);
    const short = (s) => (s ? s.slice(0, 5) + "…" + s.slice(-4) : "N/A");
    const duration = (ms) =>
      ms === null || ms === undefined
        ? "N/A"
        : Math.floor(ms / 3600000) + "h " + (Math.floor(ms / 60000) % 60) + "m";
    const labels = {
      CHEAP_FILTER: "Cheap Filter",
      SECURITY: "Risk / Rug / Security",
      COMPATIBILITY: "Token Compatibility",
      HISTORY: "Market History · 60m",
      CAPITAL_FLOW: "Capital Flow",
      COMMON_RISK: "Common Risk",
      KRONOS: "Kronos Analysis",
      STRUCTURE: "Structure Evidence V3",
      JEV: "JEV BUY Analysis",
      RISK: "Risk Engine",
      FINAL_ANALYSIS: "Fresh Final Analysis",
      OWNERSHIP_CAPITAL: "Capital / Ownership",
      BUY_QUOTE: "Jupiter BUY Quote",
      EXIT_FEASIBILITY: "Exit Feasibility",
      VALIDATE: "Validation",
      SIMULATE: "Simulation",
      PRE_SIGN: "Pre-sign Validation",
      BUY: "BUY",
      POSITION: "Position",
    };
    let lastAttempt, latest, status, sellAction, carouselKey;
    const selling = new Map();
    function avatar(token, central = false) {
      if (window.BOTTokenAvatar)
        return window.BOTTokenAvatar.create(
          token,
          central ? "token-avatar central-avatar" : "token-avatar",
        );
      const n = node(
        "div",
        (token?.symbol || token?.mint || "?").slice(0, 2).toUpperCase(),
        central ? "token-avatar central-avatar" : "token-avatar",
      );
      n.title = token?.mint || "Chưa có token";
      return n;
    }
    const displayNumber = (value) => {
      if (
        value === null ||
        value === undefined ||
        typeof value === "boolean" ||
        typeof value === "object" ||
        (typeof value === "string" && value.trim() === "")
      )
        return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    function formatSmallUsd(value) {
      const n = displayNumber(value);
      if (n === null) return "N/A";
      const amount = Math.abs(n),
        sign = n < 0 ? "-" : "";
      if (amount === 0 || amount >= 0.01)
        return (
          sign +
          "$" +
          amount.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        );
      if (amount < 1e-8)
        return sign + "$" + amount.toExponential(1).replace(/\.0e/, "e");
      const decimals = Math.max(2, 1 - Math.floor(Math.log10(amount)));
      return sign + "$" + amount.toFixed(decimals).replace(/0+$/, "");
    }
    function formatCompactUsd(value) {
      const n = displayNumber(value);
      if (n === null) return "N/A";
      const amount = Math.abs(n),
        sign = n < 0 ? "-" : "";
      if (amount > 0 && amount < 0.01) return formatSmallUsd(n);
      const units = [
        [1e9, "B"],
        [1e6, "M"],
        [1e3, "K"],
      ];
      let index = units.findIndex(([scale]) => amount >= scale);
      if (index < 0)
        return (
          sign +
          "$" +
          amount.toLocaleString("en-US", { maximumFractionDigits: 2 })
        );
      if (index > 0 && Math.round((amount / units[index][0]) * 10) / 10 >= 1000)
        index--;
      return (
        sign +
        "$" +
        (amount / units[index][0]).toLocaleString("en-US", {
          maximumFractionDigits: 1,
        }) +
        units[index][1]
      );
    }
    function currentSolUsd() {
      const price = displayNumber(status?.solPriceUsd),
        at = displayNumber(status?.solPriceUpdatedAt);
      return price !== null &&
        price > 0 &&
        at !== null &&
        at <= Date.now() &&
        Date.now() - at < 60000
        ? price
        : null;
    }
    function lamportsUsd(value, price) {
      const n = displayNumber(value);
      return n === null || price === null
        ? "N/A"
        : formatSmallUsd((n / 1e9) * price);
    }
    function metric(label, value) {
      const n = node("div", undefined, "terminal-metric");
      n.dataset.label = label;
      n.append(node("span", label), node("strong", value));
      return n;
    }
    function stageIndicator(stage, state, label = labels[stage]) {
      const row = node("div", undefined, "terminal-stage");
      row.dataset.stage = stage;
      row.dataset.status = state;
      row.setAttribute("aria-label", label + ": " + state);
      row.append(
        node(
          "i",
          {
            PASS: "✓",
            SUCCESS: "✓",
            OWNER: "✓",
            EXECUTING: "◌",
            BLOCKED: "–",
            FAIL: "✕",
            CHECKING: "◌",
            SKIPPED: "–",
            PENDING: "○",
            LOW: "✓",
            MODERATE: "!",
            STRONG: "✕",
            INSUFFICIENT_DATA: "?",
          }[state] || "?",
        ),
        node("span", label),
        node("b", state),
        node("em"),
      );
      return row;
    }
    function renderStrategyCards(a) {
      const summaries = a?.summaries || {};
      const owner = summaries.ownershipClaim?.strategy;
      const commonStages = [
        "CHEAP_FILTER",
        "SECURITY",
        "COMPATIBILITY",
        "HISTORY",
        "CAPITAL_FLOW",
        "COMMON_RISK",
      ];
      for (const strategy of ["STANDARD", "KRONOS"]) {
        const card = document.querySelector(
          '.strategy-card[data-strategy="' + strategy + '"]',
        );
        const root = $(
          strategy === "STANDARD" ? "terminalStages" : "kronosStages",
        );
        const evaluation = summaries.strategies?.[strategy] || {};
        const legacy = !summaries.strategies && summaries.strategy === strategy;
        const branchStages = legacy ? a?.stages || {} : evaluation.stages || {};
        card.dataset.attemptId = a?.attemptId || "";
        const rows = commonStages.map((stage) =>
          stageIndicator(stage, a?.stages?.[stage] || "PENDING"),
        );
        rows.push(
          node("div", strategy + " – Phân tích chi tiết", "strategy-fork"),
        );
        if (strategy === "STANDARD") {
          const markup = summaries.manipulationStructure;
          const indicator = stageIndicator(
            "CONTROLLED_MARKUP",
            markup?.status || "PENDING",
            "Controlled Markup",
          );
          indicator.title =
            "Classification OHLCV: LOW / MODERATE / STRONG / INSUFFICIENT_DATA. Risk enforces STRONG; this label is not a separate BUY approval.";
          rows.push(
            indicator,
            ...["STRUCTURE", "JEV"].map((stage) =>
              stageIndicator(stage, branchStages[stage] || "PENDING"),
            ),
          );
        } else {
          // WAIT is a valid completed inference; the entry pipeline may reject BUY afterwards.
          const inferred = summaries.kronos;
          const complete =
            ["BUY", "WAIT"].includes(inferred?.action) &&
            ["BUY", "WAIT"].includes(
              evaluation.decision || (legacy ? inferred?.action : ""),
            );
          rows.push(
            stageIndicator(
              "KRONOS",
              complete ? "PASS" : branchStages.KRONOS || "PENDING",
            ),
          );
        }
        rows.push(stageIndicator("RISK", branchStages.RISK || "PENDING"));
        const execution = evaluation.execution;
        let buy = "PENDING";
        if (execution === "BLOCKED_OWNER_ALREADY_CLAIMED") buy = "BLOCKED";
        else if (owner === strategy || legacy) {
          if (execution === "CONFIRMED" || a?.result === "BOUGHT")
            buy = "SUCCESS";
          else if (
            execution === "EXECUTION_FAILED" ||
            (a?.result === "REJECTED" &&
              [
                "FINAL_ANALYSIS",
                "OWNERSHIP_CAPITAL",
                "BUY_QUOTE",
                "EXIT_FEASIBILITY",
                "VALIDATE",
                "SIMULATE",
                "PRE_SIGN",
                "BUY",
                "POSITION",
              ].includes(a?.failedStage))
          )
            buy = "FAIL";
          else if (execution === "RECONCILING" || a?.result === "RECONCILING")
            buy = "CHECKING";
          else if (
            [
              "FINAL_ANALYSIS",
              "OWNERSHIP_CAPITAL",
              "BUY_QUOTE",
              "EXIT_FEASIBILITY",
              "VALIDATE",
              "SIMULATE",
              "PRE_SIGN",
              "BUY",
            ].some((stage) => ["PASS", "CHECKING"].includes(a?.stages?.[stage]))
          )
            buy = "EXECUTING";
          else if (owner === strategy) buy = "OWNER";
        } else if (
          execution === "NOT_EXECUTED" &&
          ["BUY", "REJECT", "ERROR"].includes(evaluation.decision)
        )
          buy = "BLOCKED";
        const buyRow = stageIndicator("BUY", buy);
        buyRow.classList.add("compact-buy");
        rows.push(buyRow);
        root.replaceChildren(...rows);
      }
    }
    function renderBatch(batch) {
      const root = $("trendingBatchProgress");
      if (!root) return;
      root.dataset.state = batch?.state || "UNKNOWN";
      root.title =
        "Carousel chỉ xem nhanh một phần queue. Bộ đếm bao gồm cả token chưa vào queue làm việc.";
      if (!batch) {
        root.textContent = "Chưa có dữ liệu batch";
        return;
      }
      const counts = [batch.processing, batch.waiting];
      if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) {
        root.textContent = "Chưa có tiến độ batch hợp lệ";
        return;
      }
      if (batch.legacy) {
        root.textContent = `Backlog cũ · Đang xử lý: ${batch.processing} · Chờ trong batch: ${batch.waiting} · Tổng chờ backlog: ${batch.backlogRemaining ?? batch.waiting}`;
        return;
      }
      if (
        !Number.isSafeInteger(batch.total) ||
        !Number.isSafeInteger(batch.completed) ||
        batch.total < 0 ||
        batch.completed < 0 ||
        batch.total !== batch.completed + batch.processing + batch.waiting
      ) {
        root.textContent =
          batch.state === "EMPTY"
            ? "Đang chờ batch Trending đầu tiên"
            : "Chưa có tiến độ batch hợp lệ";
        return;
      }
      const state =
        batch.sourceState === "FETCHING"
          ? " · Đang lấy batch mới"
          : batch.sourceState === "DEGRADED"
            ? " · Nguồn dữ liệu đang lỗi"
            : batch.state === "RECOVERY"
              ? " · Chờ đối soát/phục hồi"
              : batch.analysisPending && batch.completed === batch.total
                ? " · Đang hoàn tất phân tích"
                : batch.state === "COMPLETE"
                  ? " · Hoàn tất"
                  : "";
      root.textContent = `Batch: ${batch.total} · Đã xử lý: ${batch.completed} · Đang kiểm tra: ${batch.processing} · Còn chờ: ${batch.waiting}${state}`;
    }
    function renderCandidate(o) {
      renderBatch(o.batch);
      const a = o.attempt,
        t = a?.summaries?.token || o.token || {},
        m = a?.summaries?.market || {},
        h = a?.summaries?.history;
      const carousel = $("tokenCarousel");
      const queue = o.queue || [];
      const neighbors = queue.filter((x) => x.mint !== a?.mint);
      const item = (token, central = false) => {
        const n = node(
          "div",
          undefined,
          central ? "carousel-token central-token" : "carousel-token",
        );
        n.append(
          avatar(token, central),
          node("span", token?.symbol || short(token?.mint)),
        );
        if (central) n.dataset.attemptId = a?.attemptId || "";
        return n;
      };
      if (a?.attemptId !== lastAttempt) {
        carousel.classList.remove("attempt-transition");
        lastAttempt = a?.attemptId;
      }
      const key =
        (a?.attemptId || "") +
        "|" +
        JSON.stringify([
          window.BOTTokenAvatar?.logo(t),
          neighbors.map((x) => [
            x.mint,
            x.symbol,
            window.BOTTokenAvatar?.logo(x),
          ]),
        ]);
      if (key !== carouselKey) {
        carousel.replaceChildren(
          ...neighbors.slice(0, 3).map((x) => item(x)),
          node("b", "❯ ❯ ❯", "carousel-arrows"),
          item(a ? { ...t, mint: a.mint, symbol: a.symbol } : null, true),
          node("b", "❯ ❯ ❯", "carousel-arrows"),
          ...neighbors.slice(3, 6).map((x) => item(x)),
        );
        carouselKey = key;
      }
      carousel.classList.toggle("attempt-transition", a?.result !== "RUNNING");
      carousel.dataset.result = a?.result || "IDLE";
      $("terminalScanCaption").textContent = a
        ? a.result === "RUNNING"
          ? "Đang kiểm tra " + (a.symbol || short(a.mint)) + "…"
          : a.result + " · Chờ token tiếp theo từ backend"
        : "Đang chờ GMGN Trending…";
      const content = $("terminalToken");
      content.replaceChildren();
      const identity = node("div", undefined, "terminal-identity"),
        details = node("div");
      details.append(node("h3", a?.symbol || "Chưa có token"));
      const mint = node("button", short(a?.mint), "mint-copy");
      mint.title = a?.mint || "";
      mint.disabled = !a;
      mint.onclick = () =>
        window.navigator.clipboard?.writeText(a.mint).catch(() => {});
      details.append(mint);
      if (a?.mint) {
        const link = node("a", "↗", "token-external-link");
        link.href = "https://gmgn.ai/sol/token/" + encodeURIComponent(a.mint);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.setAttribute("aria-label", "Mở token trên GMGN");
        details.append(link);
      }
      const badges = node("div", undefined, "terminal-badges");
      badges.append(
        node("span", t.source || "GMGN Trending"),
        node("span", "SOL"),
        node(
          "span",
          "Age: " +
            duration(
              h?.tokenAge ?? (t.createdAt ? Date.now() - t.createdAt : null),
            ),
        ),
      );
      details.append(badges);
      identity.append(
        avatar({ ...o.token, ...t, mint: a?.mint, symbol: a?.symbol }, true),
        details,
      );
      content.append(identity);
      const metrics = node("div", undefined, "terminal-metrics");
      const extra = a?.summaries?.metrics || {};
      const priceMetric = metric("Price", usd(val(m.price))),
        previousPrice = val(m.windows?.["1m"]?.startPrice);
      if (previousPrice > 0 && val(m.price) !== null) {
        const change = (val(m.price) / previousPrice - 1) * 100;
        priceMetric.append(
          node(
            "small",
            (change >= 0 ? "+" : "") + change.toFixed(1) + "% · 1m",
            change >= 0 ? "positive" : "negative",
          ),
        );
      }
      metrics.append(
        priceMetric,
        metric("Market Cap", formatCompactUsd(val(m.marketCap))),
        metric("Liquidity", formatCompactUsd(val(m.liquidity))),
        metric("Volume 24h", formatCompactUsd(val(m.volume))),
        metric("Holders", number(extra.holders)),
        metric(
          "Txns",
          number(
            val(m.buys) !== null && val(m.sells) !== null
              ? val(m.buys) + val(m.sells)
              : extra.transactions,
          ),
        ),
        metric(
          "Created",
          t.createdAt ? new Date(t.createdAt).toLocaleString("vi-VN") : "N/A",
        ),
      );
      content.append(metrics);
      if (h?.candles?.length) {
        const chart = node("div", undefined, "terminal-sparkline"),
          values = h.candles.map((c) => c.close),
          min = Math.min(...values),
          max = Math.max(...values);
        chart.dataset.trend =
          values.at(-1) > values[0]
            ? "positive"
            : values.at(-1) < values[0]
              ? "negative"
              : "neutral";
        const svg = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        svg.setAttribute("viewBox", "0 0 300 65");
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", "Lịch sử giá GMGN 1m");
        const path = document.createElementNS(svg.namespaceURI, "polyline");
        path.setAttribute(
          "points",
          values
            .map(
              (v, i) =>
                (i * 300) / Math.max(1, values.length - 1) +
                "," +
                (60 - ((v - min) / Math.max(Number.EPSILON, max - min)) * 50),
            )
            .join(" "),
        );
        svg.append(path);
        chart.append(svg);
        metrics.append(chart);
      }
      renderStrategyCards(a);
      $("terminalLogTitle").textContent =
        "Action Log" + (a?.symbol ? " (" + a.symbol + ")" : "");
      const filter = $("terminalLogFilter").value;
      $("terminalLogs").replaceChildren(
        ...(a?.logs || [])
          .filter((l) => filter === "ALL" || l.status === filter)
          .map((l) => {
            const n = node("div", undefined, "terminal-log-line");
            n.dataset.status = l.status;
            n.append(
              node(
                "time",
                "[" + new Date(l.at).toLocaleTimeString("vi-VN") + "]",
              ),
              node(
                "i",
                l.status === "FAIL" ? "✕" : l.status === "PASS" ? "✓" : "●",
              ),
              node("span", l.message),
            );
            return n;
          }),
      );
    }
    function renderPositions(o) {
      const positions = o.positions || [];
      for (const id of selling.keys())
        if (!positions.some((p) => p.id === id)) selling.delete(id);
      $("terminalPositionCount").textContent =
        "Positions (" +
        positions.length +
        (o.positionTotal > positions.length ? "/" + o.positionTotal : "") +
        ")";
      const body = $("terminalPositionRows");
      body.replaceChildren(
        ...positions.map((p, i) => {
          if (
            selling.has(p.id) &&
            (p.exitState !== "READY" || p.quantity !== selling.get(p.id))
          )
            selling.delete(p.id);
          const tr = node("tr");
          tr.dataset.positionId = p.id;
          const records = o.market || [],
            m =
              records.find((x) => x.mint === p.mint)?.data ||
              records.find((x) => x.mint === p.mint)?.payload;
          const fx = currentSolUsd();
          const a = p.accounting,
            pnl =
              a?.grossPnlLamports == null ? null : Number(a.grossPnlLamports),
            percent = a?.grossPnlPct ?? null;
          const token = node("td"),
            id = node("div", undefined, "terminal-table-token"),
            identity = node("div");
          identity.append(
            node("strong", p.symbol || short(p.mint)),
            node("small", p.strategy || "STANDARD", "strategy-badge"),
            node("small", short(p.mint)),
          );
          id.append(avatar(p), identity);
          token.append(id);
          const values = [
            String(i + 1),
            token,
            accountingEntryPrice(p),
            lamportsUsd(a?.principalLamports, fx),
            usd(m?.priceUsd ?? val(m?.price)),
            lamportsUsd(a?.grossPnlLamports, fx),
            percent === null ? "N/A" : percent.toFixed(1) + "%",
            (a?.feeCompleteness === "PARTIAL_OR_UNKNOWN" &&
            fx !== null &&
            a?.feesPaidLamports != null
              ? "≥ "
              : "") + lamportsUsd(a?.feesPaidLamports, fx),
            accountingSol(a?.netPnlLamports),
            p.mfePercent === undefined ? "N/A" : number(p.mfePercent) + "%",
            p.maePercent === undefined ? "N/A" : number(p.maePercent) + "%",
            p.valuationStale
              ? "STALE · " + (p.displayState ?? p.state ?? "—")
              : (p.displayState ?? p.state ?? "—"),
            duration(Date.now() - p.entryAt),
          ];
          values.forEach((v, index) => {
            const td = typeof v === "string" ? node("td", v) : v;
            if (index === 5 || index === 6)
              td.classList.add(
                pnl === null ? "unknown" : pnl >= 0 ? "positive" : "negative",
              );
            if (index === 9) td.classList.add("positive");
            if (index === 10) td.classList.add("negative");
            if ([3, 5, 7].includes(index)) {
              td.dataset.currency = "USD";
              td.title =
                fx === null
                  ? "Chưa có giá SOL/USD hiện tại hợp lệ"
                  : "USD theo SOL/USD hiện tại: $" + number(fx);
            }
            if (index === 7) td.title += "\n" + accountingFeeDetails(a);
            tr.append(td);
          });
          const actions = node("td", undefined, "terminal-sell-actions");
          for (const [amount, label] of [
            [50, "Bán một phần"],
            [100, "Bán hết"],
          ]) {
            const b = node(
              "button",
              selling.has(p.id) ? "Đang gửi…" : label,
              amount === 100 ? "sell-full" : "sell-partial",
            );
            b.dataset.sellPercent = String(amount);
            b.disabled =
              p.state !== "OPEN" ||
              p.exitState !== "READY" ||
              selling.has(p.id) ||
              !sellAction;
            b.onclick = async () => {
              if (
                !window.confirm(
                  "Gửi lệnh bán " +
                    amount +
                    "% " +
                    (p.symbol || short(p.mint)) +
                    " · " +
                    p.mode +
                    "?",
                )
              )
                return;
              selling.set(p.id, p.quantity);
              renderPositions(latest);
              try {
                await sellAction(p.id, amount);
              } catch (error) {
                window.alert(error.message);
                selling.delete(p.id);
                renderPositions(latest);
              }
            };
            actions.append(b);
          }
          if (p.exitState !== "READY") selling.delete(p.id);
          tr.append(actions);
          return tr;
        }),
      );
      if (!positions.length) {
        const tr = node("tr"),
          td = node("td", "Chưa có Position đang mở");
        td.colSpan = 15;
        tr.append(td);
        body.append(tr);
      }
    }
    function update(o, s) {
      window.BOTTokenAvatar?.remember([
        o?.token,
        o?.attempt?.summaries?.token,
        ...(o?.queue || []),
        ...(o?.positions || []),
      ]);
      if (!o) return;
      latest = o;
      status = s || status;
      $("overviewMode").textContent =
        status?.mode === "live"
          ? "LIVE"
          : status?.mode === "paper"
            ? "PAPER"
            : "ĐANG KẾT NỐI";
      $("terminalBalance").textContent = "SOL: " + sol(status?.balanceLamports);
      $("terminalUsd").textContent =
        status?.solPriceUsd &&
        status?.balanceLamports !== null &&
        Date.now() - status.solPriceUpdatedAt < 60000
          ? "(~" +
            usd(
              (Number(status.balanceLamports) / 1e9) *
                Number(status.solPriceUsd),
            ) +
            ")"
          : "USD: N/A";
      $("terminalRunning").textContent = o.scanner?.running
        ? "Bot Running"
        : "Bot Stopped";
      $("terminalDot").classList.toggle("running", !!o.scanner?.running);
      renderCandidate(o);
      renderPositions(o);
    }
    $("terminalLogFilter").onchange = () => latest && renderCandidate(latest);
    return {
      update,
      formatters: { formatCompactUsd, formatSmallUsd },
      setSellAction: (f) => {
        sellAction = f;
      },
    };
  })();

  let latest;
  const refresh = async () => {
    latest = await ctx.get("/api/overview");
    ctx.legacyPositionCount?.(latest.positionTotal ?? latest.positions.length);
    window.BOTOverview.update(latest, ctx.shell());
  };
  ctx.setRefresh(refresh);
  ctx.onShell(() => {
    if (latest) window.BOTOverview.update(latest, ctx.shell());
  });
  window.BOTOverview.setSellAction(async (positionId, sellPercent) => {
    await ctx.post("/api/exit", { positionId, sellPercent });
    if (ctx.active()) await ctx.refresh();
  });
  ctx.onDispose(() => {
    window.BOTOverview = undefined;
  });
  await ctx.poll(refresh, 1000);
}
