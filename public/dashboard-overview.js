import "./token-avatar.js";
import {
  accountingSol,
  accountingFeeDetails,
  accountingEntryPrice,
  normalizeM1Candles,
  createChartSelection,
} from "./dashboard-core.js";
export async function mount(ctx) {
  /* Backend-driven overview. No simulated progress, countdown or trade path. */
  window.BOTOverview = (() => {
    const $ = (id) => document.getElementById(id);
    const node = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      if (cls?.includes("strategy-badge") && ["KRONOS"].includes(text))
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
      CODEX_GUARD: "Codex BUY Guard",
      KRONOS: "KRONOS Analysis",
      STRUCTURE: "Structure Evidence V3",
      RISK: "Risk Engine",
      FINAL_ANALYSIS: "Fresh Final Analysis",
      OWNERSHIP_CAPITAL: "Capital / Ownership",
      BUY_QUOTE: "Jupiter BUY Quote",
      EXIT_FEASIBILITY: "Exit Feasibility",
      VALIDATE: "Validation",
      SIMULATE: "Simulation",
      PRE_SIGN: "Pre-sign Validation",
      BUY: "BUY Decision",
      POSITION: "Position",
    };
    let latest, status, sellAction;
    const recentAttempts = new Map();
    let currentBatchId = null;
    const chartSelection = createChartSelection();
    let chartWindow = 60,
      chartGeometry = null,
      crosshairX = null,
      crosshairY = null;
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
    function stageIndicator(stage, state, label = labels[stage], detail = "") {
      const row = node("div", undefined, "terminal-stage");
      row.dataset.stage = stage;
      row.dataset.status = state;
      row.setAttribute("aria-label", label + ": " + state + (detail ? " · " + detail : ""));
      row.append(
        node(
          "i",
          {
            BUY: "✓",
            WAIT: "–",
            BLOCK: "✕",
            ERROR: "!",
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
        (() => {
          const text = node("span", undefined, "terminal-stage-label");
          text.append(node("span", label));
          if (detail) text.append(node("small", detail, "terminal-stage-reason"));
          return text;
        })(),
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
      for (const strategy of ["KRONOS"]) {
        const card = document.querySelector(
          '.strategy-card[data-strategy="' + strategy + '"]',
        );
        const root = $("kronosStages");
        const evaluation = summaries.strategies?.[strategy] || {};
        const legacy = !summaries.strategies && summaries.strategy === strategy;
        const branchStages = legacy ? a?.stages || {} : evaluation.stages || {};
        card.dataset.attemptId = a?.attemptId || "";
        $("currentDecisionEvidence").disabled = !a?.mint;
        const rows = commonStages.map((stage) =>
          stageIndicator(stage, a?.stages?.[stage] || "PENDING"),
        );
        if (a?.stages && "CODEX_GUARD" in a.stages) {
          const guard = summaries.codexGuard;
          rows.push(
            stageIndicator(
              "CODEX_GUARD",
              guard?.action === "BLOCK"
                ? "BLOCK"
                : guard?.action === "ERROR"
                  ? "ERROR"
                  : a.stages.CODEX_GUARD || "PENDING",
              labels.CODEX_GUARD,
              guard?.reasonCode || (guard?.action === "ERROR" ? "KNOWLEDGE_EVALUATION_FAILED" : ""),
            ),
          );
        }
        {
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
              complete
                ? inferred.action === "WAIT"
                  ? "WAIT"
                  : "PASS"
                : evaluation.decision === "ERROR"
                  ? "ERROR"
                  : branchStages.KRONOS || "PENDING",
            ),
          );
        }
        rows.push(stageIndicator("RISK", branchStages.RISK || "PENDING"));
        const execution = evaluation.execution;
        let buy = "PENDING";
        if (execution === "BLOCKED_OWNER_ALREADY_CLAIMED") buy = "BLOCKED";
        else if (owner === strategy || legacy) {
          if (execution === "CONFIRMED" || a?.result === "BOUGHT") buy = "BUY";
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
        if (
          buy === "PENDING" &&
          (evaluation.decision === "WAIT" ||
            (legacy && summaries.kronos?.action === "WAIT"))
        )
          buy = "WAIT";
        if (buy === "PENDING" && a?.result === "REJECTED") buy = "BLOCK";
        const buyRow = stageIndicator("BUY", buy);
        buyRow.classList.add("compact-buy");
        rows.push(buyRow);
        for (const row of rows) {
          const stage = row.dataset.stage;
          const log = a?.logs?.findLast((entry) => entry.stage === stage);
          const reason =
            stage === "BUY"
              ? evaluation.executionReason ||
                evaluation.reason ||
                a?.reasonDetail
              : log?.message;
          if (reason) row.title = reason;
          if (stage === "CODEX_GUARD" && summaries.codexGuard)
            row.title = summaries.codexGuard.reason || row.title;
        }
        const key = rows.map((row) => row.outerHTML).join("");
        if (root.dataset.renderKey !== key) {
          root.replaceChildren(...rows);
          root.dataset.renderKey = key;
        }
      }
    }
    function renderBatch(batch) {
      const root = $("trendingBatchProgress"),
        progress = $("scannerProgress"),
        kpi = $("kpiScanner"),
        time = $("batchDuration");
      root.dataset.state = batch?.state || "UNKNOWN";
      time.hidden = true;
      const valid =
        batch &&
        !batch.legacy &&
        [batch.total, batch.completed, batch.processing, batch.waiting].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        ) &&
        batch.total === batch.completed + batch.processing + batch.waiting;
      if (!valid) {
        root.textContent = batch?.legacy
          ? "Đang phục hồi backlog · Chờ: " + batch.waiting
          : "Chưa có dữ liệu batch";
        kpi.textContent = "N/A";
        progress.removeAttribute("value");
        progress.hidden = true;
        return;
      }
      root.textContent =
        "Batch: " +
        batch.total +
        " · Đã xử lý: " +
        batch.completed +
        " · Đang kiểm tra: " +
        batch.processing +
        " · Còn lại: " +
        batch.waiting;
      root.title =
        batch.sourceState === "DEGRADED"
          ? "Nguồn dữ liệu đang lỗi"
          : batch.state === "RECOVERY"
            ? "Chờ đối soát/phục hồi"
            : batch.analysisPending && batch.completed === batch.total
              ? "Đang hoàn tất phân tích"
              : batch.state;
      kpi.textContent = batch.completed + " / " + batch.total;
      progress.hidden = false;
      progress.max = Math.max(1, batch.total);
      progress.value = batch.completed;
      if (
        Number.isFinite(batch.fetchedAt) &&
        batch.fetchedAt <= Date.now() &&
        batch.state !== "COMPLETE"
      ) {
        const seconds = Math.floor((Date.now() - batch.fetchedAt) / 1000);
        time.textContent =
          "Thời gian batch: " +
          Math.floor(seconds / 60) +
          "m " +
          (seconds % 60) +
          "s";
        time.hidden = false;
      }
    }
    function chartPrice(value) {
      if (!Number.isFinite(value)) return "N/A";
      return value.toLocaleString("en-US", { maximumSignificantDigits: 8 });
    }
    function drawM1Chart(record) {
      const canvas = $("m1Chart"),
        wrap = $("chartCanvasWrap"),
        overlay = $("chartOverlay"),
        tooltip = $("chartTooltip"),
        coverage = $("chartCoverage"),
        context = canvas.getContext("2d");
      if (!context) {
        overlay.hidden = false;
        overlay.textContent = "Không thể hiển thị chart trong trình duyệt này";
        return;
      }
      const candles = normalizeM1Candles(record?.history?.candles, 60).slice(
        -chartWindow,
      );
      const width = Math.max(320, wrap.clientWidth),
        height = Math.max(260, wrap.clientHeight),
        ratio = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = window.getComputedStyle(document.documentElement).getPropertyValue("--rk-surface-elevated").trim() || "#fffdf8";
      context.fillRect(0, 0, width, height);
      tooltip.hidden = true;
      if (!candles.length) {
        overlay.hidden = false;
        overlay.textContent = "Chưa có dữ liệu nến M1";
        coverage.textContent = "Chưa có dữ liệu nến M1";
        chartGeometry = null;
        return;
      }
      overlay.hidden = true;
      coverage.textContent = candles.length + "/" + chartWindow + " nến M1 · " + candles.length + " phút";
      if (candles.length < chartWindow)
        coverage.textContent += " · lịch sử khả dụng chưa đủ";
      if (record?.history?.fetchedAt) {
        const fetchedAt = Number(record.history.fetchedAt);
        const snapshotAge = Date.now() - fetchedAt;
        coverage.textContent += snapshotAge > 60000 ? " · snapshot cũ" : " · snapshot " + new Date(fetchedAt).toLocaleTimeString("vi-VN");
      }
      const left = 12,
        right = 70,
        top = 12,
        bottom = 34,
        volumeHeight = Math.max(34, height * 0.2),
        plotRight = width - right,
        plotBottom = height - bottom - volumeHeight,
        plotWidth = Math.max(20, plotRight - left),
        plotHeight = Math.max(30, plotBottom - top),
        highs = candles.map((c) => c.high),
        lows = candles.map((c) => c.low),
        min = Math.min(...lows),
        max = Math.max(...highs),
        range = Math.max(max - min, Math.abs(max) * 0.00001, Number.EPSILON),
        volumes = candles.map((c) => c.volumeUsd ?? 0),
        maxVolume = Math.max(...volumes, 0),
        stepX = plotWidth / (chartWindow + 1),
        candleWidth = Math.max(2, Math.min(9, stepX * 0.62)),
        y = (price) => top + ((max - price) / range) * plotHeight;
      const dataLeft = plotRight - stepX * candles.length;
      chartGeometry = { candles, left, dataLeft, plotRight, plotBottom, plotWidth, plotHeight, stepX, top, width, height };
      const grid = window.getComputedStyle(document.documentElement).getPropertyValue("--rk-border-soft").trim() || "#e8ddc8";
      context.font = "11px system-ui, sans-serif";
      context.textBaseline = "middle";
      for (let i = 0; i <= 4; i++) {
        const gy = top + (plotHeight * i) / 4,
          price = max - (range * i) / 4;
        context.strokeStyle = grid;
        context.beginPath();
        context.moveTo(left, gy);
        context.lineTo(plotRight, gy);
        context.stroke();
        context.fillStyle = "#655f55";
        context.textAlign = "left";
        context.fillText(chartPrice(price), plotRight + 7, gy);
      }
      const volumeBase = height - bottom;
      candles.forEach((candle, index) => {
        const x = plotRight - stepX * (candles.length - index - 0.5),
          up = candle.close >= candle.open,
          color = up ? "#16a765" : "#d83b3b",
          bodyTop = Math.min(y(candle.open), y(candle.close)),
          bodyHeight = Math.max(1, Math.abs(y(candle.open) - y(candle.close)));
        context.strokeStyle = color;
        context.fillStyle = color;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x, y(candle.high));
        context.lineTo(x, y(candle.low));
        context.stroke();
        context.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
        if (candle.volumeUsd !== null && maxVolume > 0) {
          const barHeight = (candle.volumeUsd / maxVolume) * (volumeHeight - 7);
          context.globalAlpha = 0.6;
          context.fillRect(x - candleWidth / 2, volumeBase - barHeight, candleWidth, barHeight);
          context.globalAlpha = 1;
        }
        if (index === 0 || index === candles.length - 1 || index % Math.ceil(candles.length / 6) === 0) {
          const date = new Date(candle.at);
          context.fillStyle = "#655f55";
          context.textAlign = "center";
          context.fillText(date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }), x, height - 13);
        }
      });
      const current = val(record?.market?.price) ?? candles.at(-1)?.close;
      if (Number.isFinite(current)) {
        const cy = y(current);
        context.strokeStyle = "#159c56";
        context.setLineDash([3, 3]);
        context.beginPath();
        context.moveTo(left, cy);
        context.lineTo(plotRight, cy);
        context.stroke();
        context.setLineDash([]);
        context.fillStyle = "#159c56";
        context.fillRect(plotRight + 2, cy - 9, right - 4, 18);
        context.fillStyle = "white";
        context.textAlign = "left";
        context.fillText(chartPrice(current), plotRight + 5, cy);
      }
      if (crosshairX !== null && chartGeometry) {
        const cx = Math.max(left, Math.min(plotRight, crosshairX));
        context.strokeStyle = "#7b6c58";
        context.setLineDash([2, 3]);
        context.beginPath();
        context.moveTo(cx, top);
        context.lineTo(cx, volumeBase);
        const cy = Math.max(top, Math.min(volumeBase, crosshairY ?? top));
        context.moveTo(left, cy);
        context.lineTo(plotRight, cy);
        context.stroke();
        context.setLineDash([]);
        const index = Math.max(0, Math.min(candles.length - 1, Math.floor((cx - chartGeometry.dataLeft) / stepX)));
        const selected = candles[index];
        tooltip.textContent = new Date(selected.at).toLocaleString("vi-VN") + "\nO " + chartPrice(selected.open) + "  H " + chartPrice(selected.high) + "\nL " + chartPrice(selected.low) + "  C " + chartPrice(selected.close) + "\nVol " + (selected.volumeUsd === null ? "N/A" : formatCompactUsd(selected.volumeUsd));
        tooltip.style.left = Math.min(width - 190, Math.max(4, cx + 10)) + "px";
        tooltip.style.top = "8px";
        tooltip.hidden = false;
      }
    }
    function renderChartToken(record) {
      const content = $("terminalToken");
      content.replaceChildren();
      if (!record) {
        content.append(node("h3", "Chưa có token"));
        drawM1Chart(null);
        return;
      }
      const { attempt: a, token: t, market: m } = record,
        history = normalizeM1Candles(record.history?.candles, 60),
        identity = node("div", undefined, "chart-token-identity"),
        details = node("div");
      details.append(node("h3", a.symbol || t.symbol || "Token"));
      const mint = node("button", short(a.mint), "mint-copy");
      mint.title = a.mint;
      mint.onclick = () => window.navigator.clipboard?.writeText(a.mint).catch(() => {});
      details.append(mint);
      const badges = node("div", undefined, "terminal-badges");
      badges.append(node("span", t.source || a.source || "N/A"), node("span", "Solana · SOL"));
      details.append(badges);
      identity.append(avatar({ ...t, mint: a.mint, symbol: a.symbol }, true), details);
      const metrics = node("div", undefined, "chart-token-metrics"),
        extra = record.metrics || {},
        previous = val(m.windows?.["1m"]?.startPrice),
        priceMetric = metric("Price", usd(val(m.price)));
      if (previous > 0 && val(m.price) !== null) {
        const change = (val(m.price) / previous - 1) * 100;
        priceMetric.append(node("small", (change >= 0 ? "+" : "") + change.toFixed(1) + "% · 1m", change >= 0 ? "positive" : "negative"));
      }
      metrics.append(
        priceMetric,
        metric("Market Cap", formatCompactUsd(val(m.marketCap))),
        metric("Liquidity", formatCompactUsd(val(m.liquidity))),
        metric("Holders", number(extra.holders)),
        metric("Txns", number(val(m.buys) !== null && val(m.sells) !== null ? val(m.buys) + val(m.sells) : extra.transactions)),
      );
      content.append(identity, metrics);
      $("chartCoverage").title = record.history?.freshness === "STALE" ? "Dữ liệu nến cũ từ snapshot của bot" : "Nến M1 hiện có trong snapshot của bot";
      if (record.history?.fetchedAt)
        $("chartCoverage").title += " · cập nhật " + new Date(record.history.fetchedAt).toLocaleString("vi-VN");
      if (record.history?.candles?.length && !history.length)
        $("chartCoverage").textContent = "Dữ liệu M1 không hợp lệ";
      drawM1Chart(record);
    }
    function renderBatchTokens(batchId, activeMint) {
      const root = $("scannerRecentList"),
        empty = $("scannerRecentEmpty"),
        rows = [...recentAttempts.values()]
          .filter((record) => record.batchId === batchId)
          .sort((left, right) => (left.appearanceId ?? 0) - (right.appearanceId ?? 0));
      root.replaceChildren();
      empty.hidden = rows.length > 0;
      for (const record of rows) {
        const a = record.attempt,
          token = record.token,
          m = record.market,
          button = node("button", undefined, "scanner-recent-row");
        button.type = "button";
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(record.mint === chartSelection.selectedMint));
        button.classList.toggle("is-active", record.mint === activeMint);
        button.classList.toggle("is-selected", record.mint === chartSelection.selectedMint);
        button.append(avatar({ ...token, mint: a.mint, symbol: a.symbol }));
        const identity = node("span", undefined, "scanner-recent-identity");
        identity.append(node("strong", a.symbol || token.symbol || short(a.mint)), node("small", short(a.mint)));
        button.append(identity);
        const values = node("span", undefined, "scanner-recent-values");
        values.append(node("strong", usd(val(m.price))), node("small", a.result === "RUNNING" ? a.stage || "Đang quét" : a.result === "QUEUED" ? "Trong batch · chờ quét" : a.result || "Đã quét"));
        const movement = val(m.windows?.["1m"]?.startPrice), price = val(m.price);
        if (movement > 0 && price !== null) {
          const change = (price / movement - 1) * 100;
          values.lastChild.className = change >= 0 ? "positive" : "negative";
          values.lastChild.textContent = (change >= 0 ? "+" : "") + change.toFixed(1) + "% · 1m";
        }
        button.append(values);
        button.onclick = () => {
          chartSelection.select(record.mint);
          $("scannerAutoFollow").setAttribute("aria-pressed", "false");
          $("scannerAutoFollow").textContent = "Thủ công";
          renderBatchTokens(batchId, activeMint);
          renderChartToken(record);
        };
        root.append(button);
      }
    }
    function renderCandidate(o) {
      renderBatch(o.batch);
      const a = o.attempt,
        t = a?.summaries?.token || o.token || {},
        m = a?.summaries?.market || {},
        h = a?.summaries?.history;
      const batchId = o.batch?.id || a?.batchId || o.queue?.[0]?.batchId || null;
      if (batchId && batchId !== currentBatchId) {
        recentAttempts.clear();
        currentBatchId = batchId;
      }
      $("terminalScanCaption").dataset.state = a?.result === "RUNNING" ? "running" : a ? "idle" : "waiting";
      $("terminalScanCaption").textContent = a
        ? a.result === "RUNNING" ? "Đang kiểm tra " + (a.symbol || short(a.mint)) + " · " + (a.stage || "Đang quét") : a.result + " · Chờ token tiếp theo từ backend"
        : "Đang chờ GMGN Trending…";
      renderStrategyCards(a);
      for (const queued of o.queue || []) {
        if (!queued?.mint || (batchId && queued.batchId && queued.batchId !== batchId)) continue;
        if (!recentAttempts.has(queued.mint)) {
          recentAttempts.set(queued.mint, {
            mint: queued.mint,
            batchId: queued.batchId || batchId,
            appearanceId: queued.appearanceId,
            attempt: { ...queued, result: "QUEUED" },
            token: queued.token || queued,
            market: {},
            metrics: {},
            history: null,
          });
        }
      }
      if (a?.mint) {
        const existing = recentAttempts.get(a.mint);
        recentAttempts.delete(a.mint);
        recentAttempts.set(a.mint, {
          mint: a.mint,
          batchId: a.batchId || batchId,
          appearanceId: a.appearanceId || existing?.appearanceId,
          attempt: { ...existing?.attempt, ...a },
          token: { ...existing?.token, ...t },
          market: m,
          metrics: a.summaries?.metrics || {},
          history: h || null,
        });
      }
      while (recentAttempts.size > 250)
        recentAttempts.delete(recentAttempts.keys().next().value);
      const activeMint = a?.mint || null;
      chartSelection.observe(activeMint);
      const selectedMint = chartSelection.selectedMint;
      const record = selectedMint ? recentAttempts.get(selectedMint) : null;
      renderBatchTokens(batchId, activeMint);
      const chartKey = record ? JSON.stringify([record.mint, record.market, record.history?.fetchedAt, record.history?.candles?.length, record.history?.candles?.at(-1)?.at, record.history?.candles?.at(-1)?.close, chartWindow]) : "empty:" + chartWindow;
      if ($("terminalToken").dataset.chartKey !== chartKey) {
        $("terminalToken").dataset.chartKey = chartKey;
        renderChartToken(record);
      } else if (record) {
        drawM1Chart(record);
      }
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
            node("small", p.strategy || "LEGACY", "strategy-badge"),
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
      window.BOTAccountView?.paint();
      $("kpiPositions").textContent = Number.isInteger(o.positionTotal)
        ? String(o.positionTotal)
        : "N/A";
      renderCandidate(o);
      renderPositions(o);
    }
    function redrawChart() {
      drawM1Chart(chartSelection.selectedMint ? recentAttempts.get(chartSelection.selectedMint) : null);
    }
    function toggleAutoFollow() {
      const following = chartSelection.toggle();
      if (latest) renderCandidate(latest);
      return following;
    }
    function setChartWindow(size) {
      if (![15, 30, 60].includes(size)) return;
      chartWindow = size;
      if (latest) renderCandidate(latest);
    }
    function setCrosshair(x, y) {
      crosshairX = x;
      crosshairY = y;
      redrawChart();
    }
    return {
      update,
      redrawChart,
      toggleAutoFollow,
      setChartWindow,
      setCrosshair,
      formatters: { formatCompactUsd, formatSmallUsd },
      setSellAction: (f) => {
        sellAction = f;
      },
    };
  })();

  let latest;
  document.getElementById("currentDecisionEvidence").onclick = () => {
    if (latest?.attempt?.mint)
      void ctx.detail(latest.attempt.mint).catch(ctx.error);
  };
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
    document.getElementById("m1Chart").onpointermove = null;
    document.getElementById("m1Chart").onpointerleave = null;
    window.BOTOverview = undefined;
  });
  const followButton = document.getElementById("scannerAutoFollow");
  followButton.onclick = () => {
    const enabled = window.BOTOverview.toggleAutoFollow();
    followButton.setAttribute("aria-pressed", String(enabled));
    followButton.textContent = enabled ? "Auto" : "Thủ công";
  };
  for (const button of document.querySelectorAll("[data-chart-window]")) {
    button.onclick = () => {
      window.BOTOverview.setChartWindow(Number(button.dataset.chartWindow));
      for (const option of document.querySelectorAll("[data-chart-window]"))
        option.setAttribute("aria-pressed", String(option === button));
      window.BOTOverview.redrawChart();
    };
  }
  const chart = document.getElementById("m1Chart");
  chart.onpointermove = (event) => {
    const bounds = chart.getBoundingClientRect();
    window.BOTOverview.setCrosshair(event.clientX - bounds.left, event.clientY - bounds.top);
  };
  chart.onpointerleave = () => {
    window.BOTOverview.setCrosshair(null, null);
  };
  const resizeHandler = () => window.BOTOverview?.redrawChart();
  window.addEventListener("resize", resizeHandler);
  const resizeObserver = window.ResizeObserver
    ? new window.ResizeObserver(resizeHandler)
    : null;
  resizeObserver?.observe(document.getElementById("chartCanvasWrap"));
  ctx.onDispose(() => {
    resizeObserver?.disconnect();
    window.removeEventListener("resize", resizeHandler);
  });
  await ctx.poll(refresh, 1000);
}
