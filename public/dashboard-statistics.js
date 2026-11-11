// Presentation only. Backend accounting scopes and trading decisions stay unchanged.
const DASH = "—";
export function statisticCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
export function statisticLamports(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value))
    return BigInt(value);
  return typeof value === "string" && /^-?\d+$/.test(value)
    ? BigInt(value)
    : null;
}
export function statisticFx(shell, now = Date.now()) {
  const raw = shell?.solPriceUsd,
    at = shell?.solPriceUpdatedAt;
  if (
    (typeof raw !== "string" && typeof raw !== "number") ||
    String(raw).trim() === ""
  )
    return null;
  const price = Number(raw);
  return Number.isFinite(price) &&
    price > 0 &&
    Number.isFinite(at) &&
    at <= now &&
    now - at < 60000
    ? price
    : null;
}
export function statisticMoney(value, fx, signed = true) {
  const amount = statisticLamports(value);
  if (amount === null) return { usd: DASH, sol: DASH, tone: "unknown" };
  const absolute = amount < 0n ? -amount : amount;
  const digits = absolute.toString().padStart(10, "0");
  const whole = digits.slice(0, -9).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = digits.slice(-9).replace(/0+$/, "");
  const sign = amount < 0n ? "-" : signed && amount > 0n ? "+" : "";
  const sol = sign + whole + (fraction ? "." + fraction : "") + " SOL";
  const dollars =
    Number.isFinite(fx) && fx > 0 ? (Number(absolute) / 1e9) * fx : null;
  const usd =
    dollars === null || !Number.isFinite(dollars)
      ? DASH
      : sign +
        "$" +
        dollars.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
  return {
    usd,
    sol,
    tone: signed
      ? amount > 0n
        ? "positive"
        : amount < 0n
          ? "negative"
          : "neutral"
      : "neutral",
  };
}
export function statisticRatio(numerator, denominator) {
  return numerator !== null &&
    denominator !== null &&
    denominator > 0 &&
    numerator <= denominator
    ? numerator / denominator
    : null;
}
export function statisticModel(data, strategy) {
  const filtered = strategy !== "ALL",
    a = (filtered ? data : data.strategyAccounting) || {};
  const count = (key) => (filtered ? null : statisticCount(data[key]));
  const wins = statisticCount(a.wins),
    losses = statisticCount(a.losses);
  const classified = wins === null || losses === null ? null : wins + losses;
  const winRate = !filtered
    ? typeof data.winRate === "number" && data.winRate >= 0 && data.winRate <= 1
      ? data.winRate
      : null
    : statisticRatio(wins, classified);
  const calls = count("kronosCalls"),
    buys = count("kronosBuy"),
    skips = count("kronosWait");
  const allowed = count("riskAllow"),
    rejected = count("riskReject");
  return {
    strategy,
    filtered,
    accounting: a,
    wins,
    losses,
    winRate,
    discovered: count("discovered"),
    bought: count("bought"),
    open: count("open"),
    closed: filtered ? statisticCount(a.closed) : count("closed"),
    classifiedClosed: statisticCount(a.closed),
    realized: filtered ? null : data.realizedLamports,
    unrealized: filtered ? null : data.unrealizedLamports,
    calls,
    buys,
    skips,
    buyRate: statisticRatio(buys, calls),
    skipRate: statisticRatio(skips, calls),
    otherDecisions:
      calls !== null && buys !== null && skips !== null && buys + skips <= calls
        ? calls - buys - skips
        : null,
    allowed,
    rejected,
    rug: count("rugRejected"),
    allowRate: statisticRatio(
      allowed,
      allowed === null || rejected === null ? null : allowed + rejected,
    ),
    basis: filtered ? null : data.pnlBasis,
  };
}
const countText = (value) =>
  value === null ? DASH : value.toLocaleString("en-US");
const rateText = (value) =>
  value === null ? DASH : (value * 100).toFixed(1) + "%";
const iconPaths = {
  chart: ["M4 20V12h3v8M10 20V7h3v13M16 20V3h3v17"],
  target: [
    "M21 12a9 9 0 1 1-9-9",
    "M17 12a5 5 0 1 1-5-5",
    "m12 12 9-9M17 3h4v4",
  ],
  cart: ["M2 3h3l3 12h10l3-9H6", "M9 20h.01M18 20h.01"],
  layers: ["m12 3 10 5-10 5L2 8Z", "m2 12 10 5 10-5M2 16l10 5 10-5"],
  check: ["M21 12a9 9 0 1 1-4-7", "m7 12 3 3L21 4"],
  coins: [
    "M18 6c0 2-3 3-7 3S4 8 4 6s3-3 7-3 7 1 7 3Z",
    "M4 6v9c0 2 3 3 7 3M4 10c0 2 3 3 7 3M13 13c0-2 2-3 4-3s4 1 4 3-2 3-4 3-4-1-4-3Zm0 0v6c0 2 2 3 4 3s4-1 4-3v-6M13 17c0 2 2 3 4 3s4-1 4-3",
  ],
  document: ["M14 2H5v20h14V7Z", "M14 2v6h5M8 12h8M8 16h8"],
  brain: [
    "M12 4c-3-4-8 0-6 4-5 1-4 8 0 8-1 5 6 6 6 2V4Z",
    "M12 4c3-4 8 0 6 4 5 1 4 8 0 8 1 5-6 6-6 2M8 8v4M16 8v4M8 16h4M12 12h4",
  ],
  shield: ["m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z", "m8 12 3 3 5-6"],
  scales: ["M12 3v18M5 21h14M3 7h18M6 7l-4 8h8L6 7Zm12 0-4 8h8l-4-8Z"],
};
export async function mount(ctx) {
  const $ = (id) => document.getElementById(id);
  const make = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  };
  const icon = (name) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.7",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    }))
      svg.setAttribute(key, value);
    for (const d of iconPaths[name] || iconPaths.chart) {
      const p = document.createElementNS(svg.namespaceURI, "path");
      p.setAttribute("d", d);
      svg.append(p);
    }
    return svg;
  };
  const filter = $("statisticsStrategy"),
    root = $("terminalStatistics"),
    errorBox = $("statisticsError"),
    feedback = $("statisticsFeedback");
  const requested = new URLSearchParams(location.search).get("strategy");
  filter.value = ["ALL", "KRONOS"].includes(requested) ? requested : "ALL";
  $("statisticsHeadingIcon").append(icon("chart"));
  let latest = null,
    generation = 0,
    failure = false,
    loading = true,
    updatedAt = null;
  const tips = {
    winRate:
      "ALL giữ nguyên Win Rate của API: wins / toàn bộ CLOSED đủ hạch toán, gồm cả hòa vốn. Thiếu PnL thì chưa xác định. Khi lọc strategy: wins / (wins + losses), chỉ các lệnh đã phân loại; không coi thiếu dữ liệu là thua.",
    realized:
      "Gross realized của mọi Position đã mua trong dataset, gồm phần đã bán của Position còn mở. Không trừ phí.",
    unrealized:
      "Gross unrealized của OPEN/PENDING_EXIT đang được quản lý. Không gồm Position đã ngừng quản lý.",
    fees: "Phí của cohort CLOSED có originalQuantity > 0. Không phải phí tổng hợp của mọi Position đang mở.",
    net: "Net PnL của cohort CLOSED do backend hạch toán. Không cộng/trừ lại từ các hàng khác vì phạm vi dữ liệu khác nhau.",
    identified:
      "Tổng các khoản phí đã xác định ở cohort CLOSED. Có thể chỉ là phần phí đã biết khi coverage chưa đầy đủ.",
    gross:
      "Gross PnL của cohort CLOSED có originalQuantity > 0. Không bao gồm phí.",
    kronos:
      "Số quyết định KRONOS trong records theo mode hiện tại, tối đa 100.000 records được backend đọc. Không phải số token duy nhất.",
    risk: "Số kết quả Risk trong records theo mode hiện tại; một token có thể có nhiều lần kiểm tra. Không phải số token duy nhất.",
  };
  function label(text, tip) {
    const node = make("span", text, "stats-label");
    if (tip) {
      const info = make("span", "ⓘ", "stats-info");
      info.tabIndex = 0;
      info.setAttribute("role", "note");
      info.setAttribute("aria-label", tip);
      info.title = tip;
      node.append(info);
    }
    return node;
  }
  function card(title, glyph, id) {
    const article = make("article", undefined, "stats-card");
    article.id = id;
    const heading = make("h3");
    heading.append(icon(glyph), make("span", title));
    article.append(heading);
    return article;
  }
  function row(parent, title, value, { tip, tone, emphasis = false } = {}) {
    const item = make(
      "div",
      undefined,
      "stats-row" + (emphasis ? " stats-row-emphasis" : ""),
    );
    const number =
      typeof value === "string" ? make("strong", value, "stats-value") : value;
    if (tone) number.dataset.tone = value === DASH ? "unknown" : tone;
    item.append(label(title, tip), number);
    parent.append(item);
    return item;
  }
  function money(value, fx, signed = true) {
    const m = statisticMoney(value, fx, signed),
      box = make("div", undefined, "stats-money");
    box.dataset.tone = m.tone;
    box.append(make("strong", m.usd), make("small", m.sol));
    return box;
  }
  function progress(rate, name, tone = "success") {
    const track = make("div", undefined, "stats-progress");
    track.dataset.tone = tone;
    if (rate === null) {
      track.dataset.empty = "true";
      track.setAttribute("aria-label", name + ": chưa có dữ liệu");
    } else {
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-label", name);
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(rate * 100));
    }
    const fill = make("span");
    fill.style.width = (rate === null ? 0 : rate * 100) + "%";
    track.append(fill);
    return track;
  }
  function skeleton() {
    root.replaceChildren();
    root.dataset.state = "loading";
    root.setAttribute("aria-busy", "true");
    for (const cls of ["stats-kpis", "stats-analytics"]) {
      const grid = make("div", undefined, cls);
      for (let i = 0; i < (cls === "stats-kpis" ? 4 : 6); i++) {
        const item = make("div", undefined, "stats-card stats-skeleton");
        item.setAttribute("aria-hidden", "true");
        item.append(make("i"), make("span"), make("span"));
        grid.append(item);
      }
      root.append(grid);
    }
    feedback.textContent = "Đang tải thống kê…";
    errorBox.hidden = true;
    root.hidden = false;
  }
  function render() {
    if (!ctx.active() || !latest || loading || failure) return;
    const m = statisticModel(latest, filter.value),
      fx = statisticFx(ctx.shell());
    root.replaceChildren();
    root.hidden = false;
    root.dataset.state = "ready";
    root.setAttribute("aria-busy", "false");
    errorBox.hidden = true;
    const kpis = make("div", undefined, "stats-kpis");
    for (const [key, title, subtitle, glyph, value] of [
      [
        "detected",
        "Phát hiện",
        "Tokens được phát hiện",
        "target",
        m.discovered,
      ],
      ["bought", "Đã mua", "Vị thế đã ghi nhận BUY", "cart", m.bought],
      ["open", "Đang giữ", "Vị thế đang mở", "layers", m.open],
      ["closed", "Đã đóng", "Vị thế đã hoàn tất", "check", m.closed],
    ]) {
      const k = make("article", undefined, "stats-card stats-kpi");
      k.dataset.metric = key;
      const top = make("div", undefined, "stats-kpi-heading"),
        badge = make("span", undefined, "stats-kpi-icon");
      badge.append(icon(glyph));
      const text = make("div");
      text.append(make("h3", title), make("p", subtitle));
      top.append(badge, text);
      k.append(top, make("strong", countText(value), "stats-kpi-value"));
      kpis.append(k);
    }
    root.append(kpis);
    const scope = make(
      "p",
      m.filtered
        ? "Đang xem " +
            filter.value +
            " · hạch toán các lệnh đã đóng. Các chỉ số khác chưa được cung cấp cho bộ lọc này."
        : "Các bộ đếm theo dữ liệu hiện có. Hạch toán phí và Net PnL chỉ tính các lệnh đã đóng.",
      "stats-scope",
    );
    root.append(scope);
    const grid = make("div", undefined, "stats-analytics");
    const performance = card(
      "Hiệu suất giao dịch",
      "chart",
      "statsPerformance",
    );
    row(
      performance,
      m.filtered ? "Win Rate · đã phân loại" : "Win Rate",
      rateText(m.winRate),
      {
        tip: tips.winRate,
        tone: m.winRate === null ? "unknown" : "positive",
        emphasis: true,
      },
    );
    performance.append(progress(m.winRate, "Win Rate"));
    row(performance, "Wins", countText(m.wins), { tone: "positive" });
    row(performance, "Losses", countText(m.losses), { tone: "negative" });
    row(performance, "Closed", countText(m.classifiedClosed), {
      tip: "Cohort CLOSED có originalQuantity > 0. Có thể khác bộ đếm Đã đóng nếu tồn tại record không có BUY fill.",
    });
    const pnl = card("Lợi nhuận & Chi phí", "coins", "statsPnl");
    row(pnl, "Realized PnL", money(m.realized, fx), { tip: tips.realized });
    row(pnl, "Unrealized PnL", money(m.unrealized, fx), {
      tip: tips.unrealized,
    });
    row(pnl, "Trading Fees", money(m.accounting.feesPaidLamports, fx, false), {
      tip: tips.fees,
    });
    row(pnl, "Net PnL", money(m.accounting.netPnlLamports, fx), {
      tip: tips.net,
      emphasis: true,
    });
    pnl.append(
      make("p", "Phí và Net PnL: chỉ các lệnh đã đóng.", "stats-card-note"),
    );
    const accounting = card("Accounting", "document", "statsAccounting");
    row(
      accounting,
      "Fees identified",
      make(
        "strong",
        statisticMoney(m.accounting.identifiedFeesLamports, null, false).sol,
      ),
      { tip: tips.identified },
    );
    const coverage = make(
      "span",
      m.accounting.feesComplete === true
        ? "✓ Complete"
        : m.accounting.feesComplete === false
          ? "! Incomplete"
          : DASH,
      "stats-coverage",
    );
    coverage.dataset.complete =
      m.accounting.feesComplete === true
        ? "true"
        : m.accounting.feesComplete === false
          ? "false"
          : "unknown";
    row(accounting, "Fee coverage", coverage, {
      tip: "Complete nghĩa là phí của cohort CLOSED đã được xác định đầy đủ; không bảo đảm PnL hoặc valuation đã biết.",
    });
    row(accounting, "Gross PnL", money(m.accounting.grossPnlLamports, fx), {
      tip: tips.gross,
    });
    row(
      accounting,
      "Net PnL (accounting)",
      money(m.accounting.netPnlLamports, fx),
      { tip: tips.net },
    );
    row(
      accounting,
      "PnL basis",
      make(
        "span",
        m.basis === "GROSS_EXCLUDES_FEES"
          ? "Gross excludes fees"
          : typeof m.basis === "string" && m.basis
            ? m.basis
            : DASH,
        "stats-basis",
      ),
    );
    const kronos = card("KRONOS Decisions", "brain", "statsKronos");
    row(kronos, "Calls", countText(m.calls), { tip: tips.kronos });
    row(kronos, "BUY", countText(m.buys), { tone: "positive" });
    row(kronos, "Skip", countText(m.skips));
    row(kronos, "BUY Rate", rateText(m.buyRate), {
      tone: "positive",
      tip: "BUY / Calls. Không có Calls thì chưa xác định.",
    });
    if (m.otherDecisions !== null && m.calls > 0) {
      const bar = make("div", undefined, "stats-distribution");
      bar.setAttribute("role", "img");
      bar.setAttribute(
        "aria-label",
        "KRONOS: BUY " +
          rateText(m.buyRate) +
          ", Skip " +
          rateText(m.skipRate) +
          (m.otherDecisions ? ", khác " + m.otherDecisions : ""),
      );
      for (const [name, rate, tone] of [
        ["BUY", m.buyRate, "success"],
        ["Skip", m.skipRate, "pending"],
        ["Khác", m.otherDecisions / m.calls, "warning"],
      ])
        if (rate > 0) {
          const segment = make(
            "span",
            rate >= 0.18 ? name + " " + rateText(rate) : "",
          );
          segment.dataset.tone = tone;
          segment.style.width = rate * 100 + "%";
          bar.append(segment);
        }
      kronos.append(bar);
    } else kronos.append(progress(null, "KRONOS distribution"));
    kronos.append(
      make(
        "p",
        "● BUY (" +
          countText(m.buys) +
          ")   ○ Skip (" +
          countText(m.skips) +
          ")" +
          (m.otherDecisions
            ? " · Khác (" + countText(m.otherDecisions) + ")"
            : ""),
        "stats-card-note",
      ),
    );
    const risk = card("Risk Engine", "shield", "statsRisk");
    row(risk, "Allowed", countText(m.allowed), {
      tip: tips.risk,
      tone: "positive",
    });
    row(risk, "Rejected", countText(m.rejected), {
      tip: tips.risk,
      tone: "negative",
    });
    row(risk, "Rug rejected", countText(m.rug), {
      tone: "warning",
      tip: "Số kết quả SKIP_RUG do backend ghi nhận.",
    });
    row(risk, "Allow Rate", rateText(m.allowRate), {
      tone:
        m.allowRate === null
          ? "unknown"
          : m.allowRate === 0
            ? "negative"
            : "positive",
      tip: "Allowed / (Allowed + Rejected). Denominator bằng 0 thì chưa xác định.",
      emphasis: true,
    });
    risk.append(progress(m.allowRate, "Risk Allow Rate"));
    grid.append(performance, pnl, accounting, kronos, risk);
    root.append(grid);
    $("statisticsFx").textContent =
      fx === null
        ? "USD — · Tỷ giá SOL/USD chưa có hoặc đã cũ. Số SOL vẫn giữ nguyên."
        : "USD ước tính theo tỷ giá SOL/USD hiện tại, không phải tỷ giá tại thời điểm giao dịch.";
    feedback.textContent =
      "Cập nhật " +
      new Date(updatedAt).toLocaleTimeString("vi-VN") +
      " · " +
      filter.value;
  }
  const refresh = async () => {
    const request = ++generation,
      strategy = filter.value;
    if (!latest || failure || loading) skeleton();
    try {
      const data = await ctx.get(
        "/api/statistics?strategy=" + encodeURIComponent(strategy),
      );
      if (!ctx.active() || request !== generation) return;
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw Error("Invalid statistics response");
      latest = data;
      updatedAt = Date.now();
      failure = false;
      loading = false;
      render();
    } catch (error) {
      if (
        !ctx.active() ||
        request !== generation ||
        error.name === "AbortError"
      )
        return;
      failure = true;
      loading = false;
      root.hidden = true;
      root.setAttribute("aria-busy", "false");
      errorBox.hidden = false;
      feedback.textContent = "Chưa tải được thống kê mới.";
      $("statisticsFx").textContent = "";
    }
  };
  filter.onchange = () => {
    latest = null;
    loading = true;
    failure = false;
    ctx.query({ strategy: filter.value === "ALL" ? null : filter.value });
    void refresh();
  };
  $("statisticsRetry").onclick = () => {
    loading = true;
    void refresh();
  };
  ctx.setRefresh(refresh);
  ctx.onShell(render);
  ctx.onDispose(() => {
    generation++;
    latest = null;
  });
  skeleton();
  await ctx.poll(refresh, 5000);
}
