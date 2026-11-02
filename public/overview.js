/* BOT B Overview DOM/classes/renderCandidate adapted; own Kronos data only. */
(() => {
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const val = (x) => (x?.state === "KNOWN" ? x.value : null);
  const number = (x) =>
    x === null || x === undefined || !Number.isFinite(Number(x))
      ? "—"
      : Number(x).toLocaleString("en-US", { maximumFractionDigits: 8 });
  const usd = (x) => (x === null || x === undefined ? "—" : "$" + number(x));
  const short = (s) => (s ? s.slice(0, 5) + "…" + s.slice(-4) : "—");
  const duration = (ms) =>
    ms === null || ms === undefined
      ? "—"
      : Math.floor(ms / 3600000) + "h " + (Math.floor(ms / 60000) % 60) + "m";
  const labels = {
    CHEAP_FILTER: "Cheap Filter",
    SECURITY: "Security",
    COMPATIBILITY: "Token Compatibility",
    HISTORY: "Market History · 60m",
    CAPITAL_FLOW: "Capital Flow",
    KRONOS: "Kronos Analysis",
    PAPER_DECISION: "Paper Decision",
    EXECUTION: "Execution",
  };
  let lastAttempt, carouselKey;
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
  function metric(label, value) {
    const n = node("div", undefined, "terminal-metric");
    n.append(node("span", label), node("strong", value));
    return n;
  }
  function renderCandidate(o) {
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
      metric("Market Cap", usd(val(m.marketCap))),
      metric("Liquidity", usd(val(m.liquidity))),
      metric("Volume 24h", usd(val(m.volume))),
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
        t.createdAt ? new Date(t.createdAt).toLocaleString("vi-VN") : "—",
      ),
    );
    content.append(metrics);
    if (h?.candles?.length) {
      const chart = node("div", undefined, "terminal-sparkline"),
        values = h.candles.map((c) => c.close),
        min = Math.min(...values),
        max = Math.max(...values);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
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
      content.append(chart);
    }
    const stages = $("terminalStages");
    stages.replaceChildren(
      ...Object.entries(labels)
        .filter(
          ([stage]) =>
            stage !==
            (frame?.tradingMode === "LIVE" ? "PAPER_DECISION" : "EXECUTION"),
        )
        .map(([stage, label]) => {
          const state = a?.stages?.[stage] || "PENDING",
            row = node("div", undefined, "terminal-stage");
          row.dataset.stage = stage;
          row.dataset.status = state;
          row.append(
            node(
              "i",
              {
                PASS: "✓",
                FAIL: "✕",
                CHECKING: "◌",
                SKIPPED: "–",
                PENDING: "○",
              }[state],
            ),
            node("span", label),
            node("b", state),
            node("em"),
          );
          return row;
        }),
    );
    const result = $("terminalResult"),
      verdict = $("terminalVerdict");
    result.dataset.result = a?.result || "IDLE";
    verdict.textContent = a?.verdict || "ĐANG CHỜ";
    result.dataset.verdict = a?.verdict || "IDLE";
    const decision = $("terminalDecision");
    decision.replaceChildren(
      metric(
        "Kronos Decision",
        (frame?.tradingMode === "LIVE"
          ? a?.summaries?.decision?.action?.replace("PAPER_", "")
          : a?.summaries?.decision?.action) || "—",
      ),
      metric("Observed Price", usd(a?.summaries?.currentPrice)),
      metric(
        "Decision Time",
        a?.summaries?.decision?.at
          ? new Date(a.summaries.decision.at).toLocaleTimeString("vi-VN")
          : "—",
      ),
      metric(
        "Forecast Horizon",
        a?.summaries?.decision?.forecast ? "5 × M1" : "—",
      ),
      metric(
        frame?.tradingMode === "LIVE" ? "Actual Entry" : "Paper Entry",
        frame?.current?.live
          ? actualPrice(frame.current.live.entry)
          : usd(a?.summaries?.entry?.value),
      ),
    );
    if (a?.reasonCode) {
      decision.append(
        node("p", a.failedStage + ": " + a.reasonCode, "terminal-reason"),
      );
    }
    if (h)
      decision.append(
        node(
          "small",
          "History: " +
            duration(h.availableHistory) +
            " · " +
            Math.round(h.historyCoverage * 100) +
            "% coverage",
        ),
      );
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
  function chart(decision) {
    const f = decision?.forecast;
    if (!f) return node("p", "Chưa có forecast.", "muted");
    const all = [decision.lastObservedClose, ...f.paths.flat()],
      low = Math.min(...all),
      high = Math.max(...all),
      range = high - low || high * 0.01;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 500 150");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      "Observed last close and forecast sample paths",
    );
    const y = (v) => 135 - ((v - low) / range) * 115;
    const line = (points, color, dash) => {
      const e = document.createElementNS(svg.namespaceURI, "polyline");
      e.setAttribute("points", points);
      e.setAttribute("fill", "none");
      e.setAttribute("stroke", color);
      e.setAttribute("stroke-width", "2");
      if (dash) e.setAttribute("stroke-dasharray", "5 4");
      svg.append(e);
    };
    line(
      `10,${y(decision.lastObservedClose)} 490,${y(decision.lastObservedClose)}`,
      "#8094a6",
      true,
    );
    f.paths.forEach((p, i) =>
      line(
        [decision.lastObservedClose, ...p]
          .map((v, j) => `${10 + (j * 480) / p.length},${y(v)}`)
          .join(" "),
        ["#00d8ff", "#15e391", "#f6c95d"][i],
        true,
      ),
    );
    const box = node("div", undefined, "kronos-chart");
    box.append(
      node(
        "p",
        "Observed: mốc close cuối · Forecast: 3 đường nét đứt, không phải giá đã xảy ra.",
      ),
      svg,
    );
    return box;
  }

  let currentView = "overview",
    frame,
    statusData,
    busy = false,
    historyCursor = 0,
    positionsCursor = 0,
    logsCursor = 0;
  const previous = { history: [], positions: [] },
    next = {};
  let kronosPolicy;
  const positionCardCache = new Map(),
    historyCardCache = new Map();
  const logState = {
    rows: [],
    paused: false,
    type: "ALL",
    page: 0,
    ignored: new Set(),
    expanded: new Set(),
    range: "today",
    search: "",
    fetching: false,
  };
  const pct = (n) =>
    typeof n === "number" && Number.isFinite(n)
      ? (n > 0 ? "+" : "") + n.toFixed(2) + "%"
      : "—";
  const get = async (path) => {
    const r = await fetch(path, {
      cache: "no-store",
      signal: window.AbortSignal.timeout(8000),
    });
    if (!r.ok) throw Error("HTTP " + r.status);
    return r.json();
  };
  function trialAttempt(f) {
    const t = f.current;
    if (!t) return null;
    const cheap = t.gates?.CHEAP_FILTER?.evidence || {},
      candidate = f.candidate || {};
    const checking =
      Object.values(t.gates || {}).some((g) => g.status === "CHECKING") &&
      f.active;
    const action = t.latest?.action;
    const verdict =
      t.mode === "LIVE" && t.execution
        ? t.execution.side + " " + t.execution.state
        : t.mode === "LIVE" && action?.startsWith("PAPER_")
          ? action.replace("PAPER_", "") + " SIGNAL"
          : checking
            ? "CHECKING"
            : t.status === "ERROR" ||
                t.status === "REJECTED" ||
                action === "UNAVAILABLE"
              ? "ERROR"
              : action === "PAPER_BUY" && !t.entry
                ? "ERROR"
                : action === "PAPER_SELL" && !t.exit
                  ? "CHỜ GIÁ PAPER SELL"
                  : action?.replaceAll("_", " ") || "ĐANG CHỜ";
    const market = cheap.market || {};
    if (t.current) market.price = { state: "KNOWN", value: t.current.value };
    return {
      attemptId: t.id,
      mint: t.mint,
      symbol: t.symbol,
      result: checking ? "RUNNING" : t.status,
      verdict,
      stages:
        t.evaluation?.stages ||
        Object.fromEntries(
          Object.entries(t.gates || {}).map(([k, v]) => [k, v.status]),
        ),
      summaries: {
        token: {
          ...candidate,
          logo: t.logo,
          createdAt: candidate.createdAt ?? cheap.metadata?.createdAt,
        },
        market,
        metrics: { holders: val(cheap.metadata?.holders) },
        history: t.evidence,
        decision: t.latest,
        currentPrice: t.current?.value ?? null,
        entry: t.entry,
      },
      failedStage: Object.entries(t.gates || {}).find(
        ([, g]) => g.status === "FAIL",
      )?.[0],
      reasonCode: t.evaluation ? t.evaluation.error : t.error,
      logs: (f.logs || [])
        .slice()
        .reverse()
        .map((l) => ({
          at: l.at,
          status: /FAIL|ERROR|REJECT/.test(l.kind)
            ? "FAIL"
            : /PASS|RESULT|PAPER_BUY|PAPER_SELL|HOLD|WAIT/.test(l.kind)
              ? "PASS"
              : "CHECKING",
          message:
            l.kind +
            (l.payload?.stage ? ": " + l.payload.stage : "") +
            (l.payload?.action ? ": " + l.payload.action : "") +
            (l.payload?.reason ? " · " + l.payload.reason : ""),
        })),
    };
  }
  function actualPrice(fill) {
    return fill?.priceUsd != null
      ? usd(fill.priceUsd)
      : fill?.priceSol != null
        ? number(fill.priceSol) + " SOL/token"
        : "—";
  }
  function sol(value) {
    return value == null ? "—" : number(Number(value) / 1e9) + " SOL";
  }
  function explorer(signature, label) {
    if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(signature))
      return node("span", "—");
    const a = node("a", label);
    a.href = "https://solscan.io/tx/" + signature;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }
  const positionHeaders = [
    "#",
    "Token / Mode",
    "Actual Entry / Paper Entry",
    "Current Mark / Exit",
    "Quantity (atomic)",
    "Gross Executed",
    "Actual Fees",
    "Net Executed",
    "Market PnL %",
    "MFE",
    "MAE",
    "Status",
    "Hold",
    "BUY / SELL tx",
  ];
  function positionRows(rows, body) {
    body.replaceChildren(
      ...rows.map((p, i) => {
        const tr = node("tr"),
          identity = node("td"),
          wrap = node("div", undefined, "terminal-table-token"),
          text = node("div");
        text.append(
          node("strong", p.symbol || short(p.mint)),
          node("small", short(p.mint) + " · " + (p.mode || "PAPER")),
        );
        wrap.append(avatar(p), text);
        identity.append(wrap);
        const l = p.live,
          stale =
            !p.exit &&
            (!p.current || Date.now() - p.current.observedAt > 45000);
        const links = node("div");
        if (l)
          links.append(
            explorer(l.entry.signature, "BUY"),
            node("span", " / "),
            explorer(l.exit?.signature, "SELL"),
          );
        const values = [
          String(i + 1),
          identity,
          l ? actualPrice(l.entry) : usd(p.entry?.value),
          l?.exit
            ? actualPrice(l.exit)
            : usd(p.current?.value ?? p.exit?.value),
          l?.quantity ?? "—",
          l ? sol(l.grossPnlLamports) : "—",
          l ? sol(l.feesLamports) : "—",
          l ? sol(l.netPnlLamports) : "—",
          pct(stale ? null : l ? l.marketPnlPct : p.pnlPct),
          pct(l ? l.mfePct : p.mfePct),
          pct(l ? l.maePct : p.maePct),
          p.status + (stale ? " · STALE" : ""),
          p.entry
            ? duration((p.exit?.observedAt ?? Date.now()) - p.entry.observedAt)
            : "—",
          links,
        ];
        for (const v of values) {
          if (v instanceof window.HTMLElement && v.tagName === "TD")
            tr.append(v);
          else {
            const td = node("td");
            if (typeof v === "string") td.textContent = v;
            else td.append(v);
            tr.append(td);
          }
        }
        tr.title = l
          ? "GMGN mark/MFE/MAE are USD estimates. Executed prices and SOL PnL use reconciled receipts. Fees / Principal: " +
            pct(l.feesPrincipalPct)
          : "PAPER: gross price return; fees/quantity not simulated.";
        return tr;
      }),
    );
    if (!rows.length) {
      const row = node("tr"),
        td = node("td", "Chưa có dữ liệu");
      td.colSpan = positionHeaders.length;
      row.append(td);
      body.append(row);
    }
  }
  function table(container, rows) {
    const t = node("table", undefined, "kronos-data-table"),
      head = node("thead"),
      hr = node("tr"),
      body = node("tbody");
    for (const v of positionHeaders) hr.append(node("th", v));
    head.append(hr);
    positionRows(rows, body);
    t.append(head, body);
    container.replaceChildren(t);
  }
  const date = (at) =>
    Number.isFinite(at) ? new Date(at).toLocaleString("vi-VN") : "—";
  const tone = (v) =>
    v == null
      ? "muted"
      : Number(v) < 0
        ? "negative"
        : Number(v) > 0
          ? "positive"
          : "muted";
  function positionMetric(label, value) {
    const m = node("div", undefined, "position-metric");
    m.append(
      node("span", label, "position-label"),
      node("strong", value == null ? "—" : String(value)),
    );
    return m;
  }
  function quantity(p, original = false) {
    const l = p.live,
      raw = original ? l?.entry?.quantityAtomic : l?.quantity;
    if (raw == null || !/^\d+$/.test(raw)) return "—";
    if (!Number.isInteger(l.decimals)) return raw + " atomic";
    const text = raw.padStart(l.decimals + 1, "0");
    return l.decimals
      ? text.slice(0, -l.decimals) +
          "." +
          text.slice(-l.decimals).replace(/0+$/, "")
      : text;
  }
  function txLinks(p) {
    const links = node("div", undefined, "history-links");
    links.append(
      explorer(p.live?.entry?.signature, "Giao dịch BUY ↗"),
      explorer(p.live?.exit?.signature, "Giao dịch SELL ↗"),
    );
    return links;
  }
  function detailMetrics(p) {
    const l = p.live,
      dl = node("dl", undefined, "history-metrics");
    const entries = [
      ["Địa chỉ mint", p.mint],
      ["Chế độ", p.mode || "PAPER"],
      ["Trạng thái", p.status],
      ["Vốn đã đầu tư", sol(l?.entry?.tradingLamports)],
      ["Entry thực khớp", l ? actualPrice(l.entry) : usd(p.entry?.value)],
      ["Mở vị thế lúc", date(p.entry?.observedAt)],
      ["Final Exit lúc", date(p.exit?.observedAt)],
      ["Giá thoát", l ? actualPrice(l.exit) : usd(p.exit?.value)],
      ["Lượng mua thực", quantity(p, true)],
      ["Lượng đang giữ", quantity(p)],
      ["Gross PnL · trước phí", l ? sol(l.grossPnlLamports) : pct(p.pnlPct)],
      ["Fee · đã phát sinh", sol(l?.feesLamports)],
      ["Net PnL", sol(l?.netPnlLamports)],
      ["Phí / vốn", pct(l?.feesPrincipalPct)],
      ["MFE · giá quan sát", pct(l ? l.mfePct : p.mfePct)],
      ["MAE · giá quan sát", pct(l ? l.maePct : p.maePct)],
      ["Quyết định BUY lúc", date(p.buyDecisionAt)],
      ["Quyết định SELL lúc", date(p.sellDecisionAt)],
      [
        "Thời gian giữ",
        p.entry
          ? duration((p.exit?.observedAt ?? Date.now()) - p.entry.observedAt)
          : "—",
      ],
      ["Execution", p.execution?.state ?? "—"],
    ];
    for (const [label, value] of entries) {
      const d = node("div");
      d.append(
        node("dt", label),
        node("dd", value == null ? "—" : String(value)),
      );
      dl.append(d);
    }
    return dl;
  }
  function renderPositionCards(rows, hasMore) {
    const root = $("positionRows");
    const openDetails = new Set(
      [...root.querySelectorAll("details[open]")].map(
        (d) => d.closest("[data-position-id]")?.dataset.positionId,
      ),
    );
    const cards = rows.map((p) => {
      const l = p.live,
        pending =
          p.execution &&
          ["SUBMITTED", "CONFIRMED", "UNKNOWN", "CREATED"].includes(
            p.execution.state,
          );
      const stale = !p.current || Date.now() - p.current.observedAt > 45000;
      const fingerprint =
        JSON.stringify(p) + "|" + stale + "|" + Math.floor(Date.now() / 60000);
      const saved = positionCardCache.get(p.id);
      if (saved?.fingerprint === fingerprint) return saved.card;
      const card = node(
        "article",
        undefined,
        "position position-card" + (pending || p.error ? " has-attention" : ""),
      );
      card.dataset.positionId = p.id;
      const header = node("div", undefined, "position-card-header"),
        identity = node("div", undefined, "position-identity"),
        name = node("div");
      name.append(node("h3", p.symbol || short(p.mint), "token-name"));
      const mint = node("button", short(p.mint), "position-mint");
      mint.type = "button";
      mint.title = p.mint;
      mint.onclick = () =>
        window.navigator.clipboard?.writeText(p.mint).catch(() => {});
      name.append(mint);
      const av = avatar(p);
      av.classList.add("position-avatar");
      identity.append(av, name);
      const stack = node("div", undefined, "position-status-stack");
      stack.append(
        node(
          "span",
          pending ? p.execution.state : stale ? "DỮ LIỆU CŨ" : "● ĐANG GIỮ",
          "position-state state-" + (pending ? "unknown" : "open"),
        ),
        node("span", p.mode || "PAPER", "position-mode"),
      );
      header.append(identity, stack);
      card.append(header);
      const ret = stale ? null : l ? l.marketPnlPct : p.pnlPct;
      const pnl = node("div", undefined, "position-pnl " + tone(ret));
      pnl.append(
        node("span", "PnL thị trường · ước tính", "position-label"),
        node("strong", pct(ret), "position-pnl-percent"),
        node(
          "span",
          l
            ? "Đã chốt · " + sol(l.grossPnlLamports)
            : "PAPER · gross price return",
          "position-pnl-sol",
        ),
      );
      card.append(pnl);
      const values = node("div", undefined, "position-metric-grid");
      values.append(
        positionMetric("Vốn đã đầu tư", sol(l?.entry?.tradingLamports)),
        positionMetric(
          "Giá hiện tại · GMGN",
          stale ? "—" : usd(p.current?.value),
        ),
        positionMetric("Đang giữ", quantity(p) + " " + (p.symbol || "token")),
        positionMetric("Fee · đã phát sinh", sol(l?.feesLamports)),
        positionMetric("Net PnL đã chốt", sol(l?.netPnlLamports)),
        positionMetric("Phí / vốn", pct(l?.feesPrincipalPct)),
      );
      card.append(values);
      const secondary = node(
        "div",
        undefined,
        "position-metric-grid position-secondary",
      );
      secondary.append(
        positionMetric(
          "Giá vào lệnh",
          l ? actualPrice(l.entry) : usd(p.entry?.value),
        ),
        positionMetric("Mở vị thế lúc", date(p.entry?.observedAt)),
        positionMetric(
          "Thời gian giữ",
          p.entry ? duration(Date.now() - p.entry.observedAt) : "—",
        ),
      );
      card.append(secondary);
      const perf = node("div", undefined, "position-performance");
      perf.append(
        positionMetric("Lãi cao nhất (MFE)", pct(l ? l.mfePct : p.mfePct)),
        positionMetric("Lỗ sâu nhất (MAE)", pct(l ? l.maePct : p.maePct)),
      );
      card.append(perf);
      const management = node("div", undefined, "position-management");
      management.append(
        positionMetric("Theo dõi", stale ? "DỮ LIỆU CŨ" : "ĐANG THEO DÕI"),
        positionMetric("Thực thi", p.execution?.state ?? "—"),
        positionMetric("Chiến lược", "KRONOS"),
      );
      card.append(management);
      const model = node("div", undefined, "kronos-position-decision");
      model.append(
        node(
          "b",
          "KRONOS · " +
            (p.latest?.action?.replace("PAPER_", "") || "CHƯA CÓ QUYẾT ĐỊNH"),
        ),
        node("p", p.latest?.reason || "Chờ model và dữ liệu hợp lệ"),
        node("small", date(p.latest?.at)),
      );
      card.append(model);
      if (p.error) {
        const warning = node("div", undefined, "position-warning");
        warning.append(node("b", "⚠ CẦN CHÚ Ý"), node("p", p.error));
        card.append(warning);
      }
      const footer = node("div", undefined, "position-card-footer");
      footer.append(
        node(
          "span",
          "GMGN mark/MFE/MAE là ước tính · không phải giá SELL được bảo đảm",
        ),
        txLinks(p),
      );
      card.append(footer);
      const details = node("details", undefined, "position-details");
      details.open = openDetails.has(p.id);
      details.append(node("summary", "Xem chi tiết"), detailMetrics(p));
      card.append(details);
      positionCardCache.set(p.id, { fingerprint, card });
      return card;
    });
    root.replaceChildren(...cards);
    for (const id of positionCardCache.keys())
      if (!rows.some((p) => p.id === id)) positionCardCache.delete(id);
    $("positionEmpty").hidden = rows.length > 0;
    $("positionActiveCount").textContent =
      rows.length + (hasMore ? "+" : "") + " ĐANG GIỮ";
    const allLive = rows.every((p) => p.live?.entry?.tradingLamports != null);
    const invested = allLive
      ? rows.reduce((sum, p) => sum + BigInt(p.live.entry.tradingLamports), 0n)
      : null;
    const attention = rows.filter(
      (p) =>
        p.error ||
        ["UNKNOWN", "SUBMITTED", "CREATED", "CONFIRMED"].includes(
          p.execution?.state,
        ),
    ).length;
    $("positionPortfolio").replaceChildren(
      positionMetric("Đang giữ", String(rows.length) + (hasMore ? "+" : "")),
      positionMetric("Vốn đã đầu tư", invested === null ? "—" : sol(invested)),
      positionMetric("Giá trị hiện tại (SOL)", rows.length ? "—" : "0 SOL"),
      positionMetric("Lãi/lỗ chưa chốt (SOL)", rows.length ? "—" : "0 SOL"),
      positionMetric("⚠ Cần chú ý", String(attention)),
    );
    $("positionsScope").textContent = hasMore
      ? "Tổng quan trong trang hiện tại · 50 vị thế mỗi trang"
      : "LIVE theo số lượng đã đối soát; giá thị trường chỉ là ước tính.";
  }
  function renderHistoryCards(rows) {
    const root = $("historyRows");
    const open = new Set(
      [...root.querySelectorAll("details[open]")].map(
        (d) => d.dataset.positionId,
      ),
    );
    root.replaceChildren(
      ...rows.map((p) => {
        const fingerprint = JSON.stringify(p),
          saved = historyCardCache.get(p.id);
        if (saved?.fingerprint === fingerprint) return saved.record;
        const l = p.live,
          record = node("details", undefined, "history-record");
        record.dataset.positionId = p.id;
        record.open = open.has(p.id);
        const summary = node("summary", undefined, "history-summary"),
          title = node("span", undefined, "history-token token-name");
        title.title = p.mint;
        title.append(
          avatar(p),
          node(
            "span",
            (p.symbol || short(p.mint)) + " · " + (p.mode || "PAPER"),
          ),
        );
        const path = node("span", undefined, "trade-lifecycle-path");
        path.append(
          node(
            "span",
            "ENTRY · " +
              (l ? actualPrice(l.entry) : usd(p.entry?.value)) +
              " · " +
              date(p.entry?.observedAt),
          ),
          node(
            "span",
            "→ " +
              (p.entry
                ? duration(
                    (p.exit?.observedAt ?? Date.now()) - p.entry.observedAt,
                  )
                : "—"),
          ),
          node(
            "span",
            "THOÁT CUỐI · " +
              (l ? actualPrice(l.exit) : usd(p.exit?.value)) +
              " · " +
              date(p.exit?.observedAt),
          ),
        );
        const gross = l?.grossPnlLamports,
          ret = l ? gross : p.pnlPct;
        const pnl = node(
          "strong",
          "PnL " + (l ? sol(gross) : pct(p.pnlPct)),
          "history-pnl " + tone(ret),
        );
        const amounts = node(
          "span",
          "Fee " + sol(l?.feesLamports) + " · Net " + sol(l?.netPnlLamports),
          "history-accounting-summary",
        );
        const result =
          ret == null
            ? "UNKNOWN"
            : Number(ret) > 0
              ? "PROFIT"
              : Number(ret) < 0
                ? "LOSS"
                : "FLAT";
        summary.append(
          title,
          path,
          pnl,
          amounts,
          node(
            "span",
            p.status !== "CLOSED" ? p.status : result,
            "history-result",
          ),
          node("span", "⌄", "history-arrow"),
        );
        const detail = node("div", undefined, "history-detail");
        detail.append(detailMetrics(p), txLinks(p));
        const executions = node("details", undefined, "history-executions");
        executions.append(node("summary", "Quyết định và chi tiết thực thi"));
        executions.ontoggle = async () => {
          if (!executions.open || executions.dataset.loaded) return;
          executions.dataset.loaded = "true";
          try {
            const r = await get("/api/trial?id=" + encodeURIComponent(p.id));
            executions.append(
              node(
                "pre",
                JSON.stringify(
                  {
                    executions: r.executions ?? [],
                    decisions: r.decisions ?? [],
                  },
                  null,
                  2,
                ),
                "kronos-json",
              ),
            );
          } catch (e) {
            executions.append(node("p", e.message));
            executions.dataset.loaded = "";
          }
        };
        detail.append(executions);
        record.append(summary, detail);
        historyCardCache.set(p.id, { fingerprint, record });
        return record;
      }),
    );
    for (const id of historyCardCache.keys())
      if (!rows.some((p) => p.id === id)) historyCardCache.delete(id);
    $("historyEmpty").hidden = rows.length > 0;
    $("historyEmpty").textContent =
      $("historyState").value === "CLOSED"
        ? "Chưa có vị thế hoàn tất trong chế độ này."
        : "Chưa có dữ liệu phù hợp với bộ lọc.";
  }
  function header(f) {
    const mode = f.tradingMode || "PAPER";
    $("overviewMode").textContent = mode + (f.dryRun ? " · DRY RUN" : "");
    $("mode").textContent = mode;
    $("mode").classList.toggle("negative", mode === "LIVE");
    $("terminalBalance").textContent = "MARKET: REAL";
    $("terminalUsd").textContent = "TRADING: " + mode;
    $("terminalDot").classList.toggle("running", !!f.enabled);
    $("terminalRunning").textContent = f.enabled
      ? "Bot Running"
      : "Server Running · Collection Paused";
    $("notice").textContent =
      f.error ||
      (!statusData?.credentials?.gmgn ||
      statusData.credentials.gmgn === "not configured"
        ? "Chưa cấu hình KRONOS_GMGN_API_KEY"
        : "REAL DATA · " + mode + (f.dryRun ? " · STOP BEFORE SIGN" : ""));
  }
  function renderOverview(f) {
    frame = f;
    rememberLogTokens([
      f.current,
      ...(f.queue || []),
      ...(f.positions?.rows || []),
    ]);
    header(f);
    const a = trialAttempt(f);
    renderCandidate({ attempt: a, token: a?.summaries?.token, queue: f.queue });
    $("terminalPositionCount").textContent =
      (f.tradingMode === "LIVE" ? "Live Positions (" : "Paper Positions (") +
      f.positions.rows.length +
      (f.positions.hasMore ? "+" : "") +
      ")";
    positionRows(f.positions.rows, $("terminalPositionRows"));
  }
  async function page(view) {
    const cursor = view === "history" ? historyCursor : positionsCursor;
    const filter =
      view === "history"
        ? "&state=" + encodeURIComponent($("historyState").value)
        : "";
    const result = await get(
      "/api/" +
        view +
        "?limit=50&cursor=" +
        cursor +
        filter +
        "&mode=" +
        encodeURIComponent($(view + "Mode").value),
    );
    rememberLogTokens(result.rows);
    if (view === "history") renderHistoryCards(result.rows);
    else renderPositionCards(result.rows, result.hasMore);
    next[view] = result.nextCursor;
    $(view + "Next").disabled = !result.hasMore;
    $(view + "Previous").disabled = !previous[view].length;
    $(view + "Page").textContent = String(previous[view].length + 1);
  }
  async function stats() {
    const mode = $("statisticsMode").value;
    const s = await get("/api/statistics?mode=" + mode);
    if (mode === "LIVE") {
      const entries = [
        ["Live Buys", s.buys],
        ["Live Open", s.open],
        ["Live Closed Trades", s.closed],
        ["Wins", s.wins],
        ["Losses", s.losses],
        ["Win Rate", s.winRate == null ? "—" : pct(s.winRate * 100)],
        ["Gross Realized PnL", sol(s.grossRealizedLamports)],
        ["Actual Fees (closed positions)", sol(s.actualFeesLamports)],
        ["Net Realized PnL", sol(s.netRealizedLamports)],
        ["Average Net PnL", sol(s.averageNetLamports)],
        ["Median Net PnL", sol(s.medianNetLamports)],
        ["Best Trade", sol(s.bestNetLamports)],
        ["Worst Trade", sol(s.worstNetLamports)],
      ];
      $("statCards").replaceChildren(
        ...entries.map(([k, v]) => {
          const n = node("div", undefined, "kronos-stat");
          n.append(node("small", k), node("strong", String(v ?? "—")));
          return n;
        }),
      );
      $("statFunnel").replaceChildren(
        node(
          "p",
          "LIVE only · Unknown accounting stays —. Failed execution fees remain in execution ledger.",
        ),
      );
      $("statDistribution").replaceChildren();
      return;
    }
    const entries = [
      ["Tokens Checked", s.tokensChecked],
      ["Kronos PASS", s.kronosPass],
      [
        "Selection Rate",
        s.selectionRate == null ? "—" : pct(s.selectionRate * 100),
      ],
      ["Paper Buys", s.paperBuys],
      ["Open", s.open],
      ["Closed", s.closed],
      ["Wins", s.wins],
      ["Losses", s.losses],
      ["Breakeven", s.flats],
      ["Win Rate", s.winRate == null ? "—" : pct(s.winRate * 100)],
      ["Average PnL", pct(s.averagePnlPct)],
      ["Median PnL", pct(s.medianPnlPct)],
      ["Best Trade", pct(s.bestTrade)],
      ["Worst Trade", pct(s.worstTrade)],
      ["Average MFE", pct(s.averageMfePct)],
      ["Average MAE", pct(s.averageMaePct)],
      ["Average Hold", duration(s.averageHoldMs)],
      [
        "Rolling Win Rate · last20",
        s.rolling20 == null ? "—" : pct(s.rolling20 * 100),
      ],
      [
        "Rolling Win Rate · last50",
        s.rolling50 == null ? "—" : pct(s.rolling50 * 100),
      ],
    ];
    $("statCards").replaceChildren(
      ...entries.map(([k, v]) => {
        const n = node("div", undefined, "kronos-stat");
        n.append(node("small", k), node("strong", v == null ? "—" : String(v)));
        return n;
      }),
    );
    $("statFunnel").replaceChildren(
      ...[
        ["Discovered", s.records],
        ...Object.entries(s.funnel),
        ["Kronos PAPER BUY", s.paperBuys],
      ].map(([k, v]) => node("p", k + " → " + v)),
    );
    $("statDistribution").replaceChildren(
      ...s.distribution.map((r) => {
        const p = node("p"),
          bar = node("progress");
        bar.max = Math.max(1, s.closed);
        bar.value = r.count;
        p.append(node("span", r.bucket), bar, node("b", String(r.count)));
        return p;
      }),
    );
    if (!s.closed)
      $("statDistribution").append(node("p", "— · Chưa có CLOSED trades"));
  }
  const logTokens = new Map();
  function rememberLogTokens(rows) {
    for (const p of rows ?? []) if (p?.id) logTokens.set(p.id, p);
    while (logTokens.size > 800)
      logTokens.delete(logTokens.keys().next().value);
  }
  function logType(e) {
    const stage = e.payload?.stage ?? "";
    if (/SECURITY|COMPATIBILITY/.test(stage) || /SECURITY/.test(e.kind))
      return "SECURITY";
    if (/INFERENCE|HOLD|WAIT|KRONOS_ERROR/.test(e.kind)) return "KRONOS";
    if (
      /BUY|SELL|POSITION|SIMULATION|QUOTE|EXIT_FEASIBILITY|RECONCIL|SIZE_|DRY_RUN|EXECUTION/.test(
        e.kind,
      )
    )
      return "TRADE";
    if (/DISCOVERY|STAGE|ATTEMPT/.test(e.kind)) return "CANDIDATE";
    return "SYSTEM";
  }
  function logResult(e) {
    if (/FAILED|FAIL|ERROR|REJECT/.test(e.kind)) return "REJECT";
    if (/UNKNOWN|UNAVAILABLE/.test(e.kind)) return "UNKNOWN";
    if (/_BUY_RECONCILED|^BUY_RECONCILED/.test(e.kind)) return "BOUGHT";
    if (/PASS|CONFIRMED|RECONCILED|POSITION_OPEN|POSITION_CLOSED/.test(e.kind))
      return "PASS";
    if (e.payload?.action) return e.payload.action.replace("PAPER_", "");
    if (/HOLD/.test(e.kind)) return "HOLD";
    if (/WAIT/.test(e.kind)) return "WAIT";
    return "PENDING";
  }
  function filteredLogs() {
    const now = Date.now(),
      start =
        logState.range === "today"
          ? new Date().setHours(0, 0, 0, 0)
          : logState.range === "7d"
            ? now - 7 * 86400000
            : logState.range === "30d"
              ? now - 30 * 86400000
              : 0;
    const search = logState.search.toLowerCase();
    return logState.rows.filter(
      (e) =>
        e.at >= start &&
        (logState.type === "ALL" || logType(e) === logState.type) &&
        (!search ||
          JSON.stringify([e, logTokens.get(e.trial_id)])
            .toLowerCase()
            .includes(search)),
    );
  }
  function renderLogTable() {
    const types = [
      ["ALL", "Tất cả"],
      ["CANDIDATE", "Candidate"],
      ["SECURITY", "Security"],
      ["KRONOS", "Kronos"],
      ["TRADE", "Trade"],
      ["SYSTEM", "System"],
    ];
    $("logTypeFilters").replaceChildren(
      ...types.map(([key, label]) => {
        const b = node(
          "button",
          undefined,
          "insights-filter-pill" + (key === logState.type ? " active" : ""),
        );
        b.type = "button";
        b.dataset.type = key;
        b.setAttribute("aria-pressed", String(key === logState.type));
        b.append(
          node("span", label),
          node(
            "b",
            String(
              key === "ALL"
                ? logState.rows.length
                : logState.rows.filter((e) => logType(e) === key).length,
            ),
          ),
        );
        b.onclick = () => {
          logState.type = key;
          logState.page = 0;
          renderLogTable();
        };
        return b;
      }),
    );
    const filtered = filteredLogs(),
      pages = Math.max(1, Math.ceil(filtered.length / 40));
    logState.page = Math.min(logState.page, pages - 1);
    const visible = filtered.slice(logState.page * 40, logState.page * 40 + 40),
      rows = [];
    for (const e of visible) {
      const tr = node("tr", undefined, "insights-log-row");
      tr.dataset.result = logResult(e);
      tr.dataset.logId = String(e.id);
      const time = node(
        "td",
        new Date(e.at).toLocaleTimeString("vi-VN", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          fractionalSecondDigits: 3,
        }),
        "insights-log-time",
      );
      const type = node("td"),
        badge = node("span", logType(e), "insights-type-badge");
      badge.dataset.type = logType(e);
      type.append(badge);
      const token = node("td"),
        p = logTokens.get(e.trial_id);
      const identity = node("div", undefined, "insights-log-token"),
        name = node("div");
      name.append(
        node(
          "strong",
          p?.symbol || p?.name || (e.trial_id ? short(e.trial_id) : "Hệ thống"),
        ),
        node(
          "small",
          p
            ? short(p.mint)
            : e.trial_id
              ? "Trial " + short(e.trial_id)
              : "Kronos",
        ),
      );
      const logAvatar = avatar(p);
      logAvatar.classList.add("insights-log-avatar");
      identity.append(logAvatar, name);
      token.append(identity);
      const message = node("td", undefined, "insights-log-message"),
        line = node("div", undefined, "insights-log-message-line");
      line.append(
        node(
          "span",
          /REJECT/.test(logResult(e))
            ? "✕"
            : logResult(e) === "PASS"
              ? "✓"
              : "···",
          "insights-log-mark",
        ),
        node("strong", e.kind.replaceAll("_", " ")),
      );
      message.append(
        line,
        node(
          "span",
          e.payload?.reason ||
            e.payload?.stage ||
            e.payload?.action ||
            "Sự kiện đã ghi nhận",
          "muted",
        ),
      );
      const result = node("td"),
        status = node("span", logResult(e), "insights-result-badge");
      status.dataset.result = logResult(e);
      result.append(status);
      const expand = node("td"),
        button = node(
          "button",
          logState.expanded.has(e.id) ? "⌃" : "⌄",
          "insights-log-expand",
        );
      button.type = "button";
      button.setAttribute("aria-label", "Chi tiết log " + e.id);
      button.setAttribute("aria-expanded", String(logState.expanded.has(e.id)));
      button.onclick = () => {
        if (logState.expanded.has(e.id)) logState.expanded.delete(e.id);
        else logState.expanded.add(e.id);
        renderLogTable();
      };
      expand.append(button);
      tr.append(time, type, token, message, result, expand);
      rows.push(tr);
      if (logState.expanded.has(e.id)) {
        const detail = node("tr", undefined, "insights-log-detail-row"),
          cell = node("td");
        cell.colSpan = 6;
        const box = node("div", undefined, "insights-log-detail");
        box.append(
          node("strong", "Chi tiết sự kiện · #" + e.id),
          node("pre", JSON.stringify(e, null, 2), "insights-log-raw"),
        );
        cell.append(box);
        detail.append(cell);
        rows.push(detail);
      }
    }
    $("terminalAllLogs").replaceChildren(...rows);
    $("logEmpty").hidden = filtered.length > 0;
    $("logPage").textContent = logState.page + 1 + " / " + pages;
    $("logPrevious").disabled = logState.page === 0;
    $("logNext").disabled = logState.page >= pages - 1;
    $("logScope").textContent =
      (filtered.length ? logState.page * 40 + 1 : 0) +
      "–" +
      Math.min(filtered.length, (logState.page + 1) * 40) +
      " / " +
      filtered.length +
      " log đã tải · Buffer tối đa 800 · Không phải toàn bộ lịch sử backend";
    $("logStreamStatus").textContent = logState.paused
      ? "Ⅱ TẠM DỪNG HIỂN THỊ"
      : "● LIVE STREAM";
    $("logStreamStatus").dataset.state = logState.paused ? "paused" : "live";
    $("logPause").setAttribute("aria-pressed", String(logState.paused));
    $("logPause").textContent = logState.paused ? "▶ Tiếp tục" : "Ⅱ Tạm dừng";
  }
  async function logs() {
    if (logState.paused || logState.fetching) {
      renderLogTable();
      return;
    }
    logState.fetching = true;
    try {
      if (
        !logState.tokenCheckedAt ||
        Date.now() - logState.tokenCheckedAt > 30000
      ) {
        const tokens = await get("/api/history?limit=100&mode=ALL&state=ALL");
        rememberLogTokens(tokens.rows);
        logState.tokenCheckedAt = Date.now();
      }
      const r = await get("/api/logs?limit=100&cursor=" + logsCursor);
      const unique = new Map(logState.rows.map((e) => [e.id, e]));
      for (const e of r.rows)
        if (!logState.ignored.has(e.id)) unique.set(e.id, e);
      logState.rows = [...unique.values()]
        .sort((a, b) => b.id - a.id)
        .slice(0, 800);
      next.logs = r.rows.at(-1)?.id;
      $("logsOlder").disabled = r.rows.length < 100;
      renderLogTable();
    } finally {
      logState.fetching = false;
    }
  }
  let settingsFingerprint;
  function configuration() {
    const f = frame || {},
      p = f.providers || {},
      m = f.inference || {},
      sizing = statusData?.sizing;
    $("collectionStatus").textContent = f.enabled
      ? "● ĐANG GIAO DỊCH / COLLECTION"
      : "Ⅱ ĐANG TẠM DỪNG";
    $("collectionEnable").disabled = !!f.enabled;
    $("collectionPause").disabled = !f.enabled;
    const rows = [
      [
        "Quy mô lệnh mua (%)",
        sizing?.positionSizePercent,
        "positionSizePercent",
      ],
      ["SOL dự phòng phí (lamport)", sizing?.baseReserveLamports],
      ["Dự phòng mỗi OPEN (lamport)", sizing?.reservePerOpenLamports],
      ...Object.entries(statusData?.settings || {}).map(([key, value]) => [
        {
          maxAgeSeconds: "Tuổi token legacy tối đa (giây)",
          trendingMaxAgeSeconds: "Tuổi token Trending tối đa (giây)",
          minLiquidityUsd: "Thanh khoản tối thiểu (USD)",
          criticalRugRatio: "Ngưỡng rug nghiêm trọng (0–1)",
          warningRugRatio: "Ngưỡng cảnh báo rug (0–1)",
          maxTaxPercent: "Thuế giao dịch tối đa (%)",
          maxSnapshotAgeMs: "Tuổi dữ liệu tối đa (ms)",
          flowMeaningfulChangePercent: "Biến động dòng tiền đáng kể (%)",
        }[key] || key,
        value,
      ]),
      ["Model Kronos", kronosPolicy?.model?.id],
      ["Model revision", kronosPolicy?.model?.revision],
      ["Số nến lịch sử tối thiểu", kronosPolicy?.minimumCandles],
      ["Số nến lịch sử tối đa", kronosPolicy?.maximumCandles],
      ["Số nến dự báo M1", kronosPolicy?.horizon],
      ["Số sampled paths", kronosPolicy?.samples],
      ["Chu kỳ inference (ms)", kronosPolicy?.inferenceIntervalMs],
      ["Timeout model (ms)", kronosPolicy?.forecastTimeoutMs],
      ["Chế độ giao dịch", f.tradingMode || "PAPER"],
      [
        "Thực thi",
        f.dryRun
          ? "DRY RUN · NO SIGN"
          : f.tradingMode === "LIVE"
            ? "LIVE"
            : "PAPER",
      ],
      ["GMGN", p.gmgn?.state || "UNKNOWN"],
      ["RPC", p.rpc?.state || "UNKNOWN"],
      ["Kronos Model", m.active ? "BUSY" : m.loaded ? "READY" : "NOT LOADED"],
      [
        "API key GMGN",
        statusData?.credentials?.gmgn === "configured"
          ? "CONFIGURED"
          : "NOT CONFIGURED",
      ],
      [
        "Giao dịch đang chờ",
        f.liveExecution?.pending?.length ?? f.execution?.pending?.length ?? 0,
      ],
    ];
    const fingerprint = JSON.stringify(rows);
    if (fingerprint === settingsFingerprint) return;
    settingsFingerprint = fingerprint;
    const grid = node("div", undefined, "setting-fields");
    for (const [label, value, id] of rows) {
      const box = node("div"),
        input = node("input");
      input.type = "text";
      input.readOnly = true;
      input.value = value == null ? "—" : String(value);
      input.setAttribute("aria-label", label);
      if (id) input.id = id;
      box.append(node("label", label));
      if (id) box.append(node("small", "Cố định1% SOL khả dụng sau dự phòng"));
      box.append(input);
      grid.append(box);
    }
    const status = node("p", undefined, "muted");
    status.append(
      node(
        "strong",
        f.enabled ? "Collection đang chạy" : "Collection đang tạm dừng",
      ),
      node(
        "span",
        " · Cấu hình hiệu lực từ backend · Không có thao tác lưu tham số tại UI",
      ),
    );
    $("configuration").replaceChildren(grid, status);
  }
  async function kronos() {
    const f = await get("/api/kronos");
    const box = $("kronosDetail");
    box.replaceChildren(
      node(
        "p",
        "Records " +
          f.summary.records +
          " · OPEN " +
          f.summary.open +
          " · CLOSED " +
          f.summary.closed,
      ),
    );
    if (frame?.current?.latest?.forecast)
      box.append(chart(frame.current.latest));
    table(
      box.appendChild(node("div", undefined, "terminal-table-wrap")),
      f.records,
    );
    const details = node("details"),
      summary = node(
        "summary",
        "Chi tiết token hiện tại / 50 decisions gần nhất",
      );
    details.append(summary);
    details.ontoggle = async () => {
      if (!details.open || !frame?.current) return;
      const r = await get(
        "/api/trial?id=" + encodeURIComponent(frame.current.id),
      );
      details.replaceChildren(summary, node("pre", JSON.stringify(r, null, 2)));
    };
    box.append(details);
  }
  async function refreshView() {
    if (currentView === "statistics") await stats();
    else if (currentView === "history" || currentView === "positions")
      await page(currentView);
    else if (currentView === "logs") await logs();
    else if (currentView === "settings") {
      if (!kronosPolicy) {
        const data = await get("/api/kronos");
        kronosPolicy = data.policy;
      }
      configuration();
    } else if (currentView === "kronos") await kronos();
  }
  function view(name) {
    currentView = name;
    document
      .querySelectorAll(".view")
      .forEach((e) => e.classList.toggle("hidden", e.id !== name));
    document
      .querySelectorAll("nav [data-view]")
      .forEach((e) => e.classList.toggle("active", e.dataset.view === name));
    void refreshView().catch(showError);
  }
  function showError(e) {
    $("notice").textContent = e.message;
  }
  async function control(action) {
    const r = await fetch("/api/kronos/control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": statusData.csrf,
      },
      body: JSON.stringify({ action, csrf: statusData.csrf }),
    });
    const v = await r.json();
    if (!r.ok) throw Error(v.error);
    await refresh();
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const f = await get("/api/overview");
      renderOverview(f);
      if (currentView === "settings") configuration();
    } catch (e) {
      $("terminalDot").classList.remove("running");
      $("terminalRunning").textContent = "Server chưa kết nối";
      showError(e);
    } finally {
      busy = false;
    }
  }
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => (b.onclick = () => view(b.dataset.view)));
  document
    .querySelectorAll("[data-open-view]")
    .forEach((b) => (b.onclick = () => view(b.dataset.openView)));
  for (const name of ["history", "positions"]) {
    $(name + "Next").onclick = () => {
      previous[name].push(name === "history" ? historyCursor : positionsCursor);
      if (name === "history") historyCursor = next[name];
      else positionsCursor = next[name];
      void page(name).catch(showError);
    };
    $(name + "Previous").onclick = () => {
      const c = previous[name].pop() || 0;
      if (name === "history") historyCursor = c;
      else positionsCursor = c;
      void page(name).catch(showError);
    };
  }
  for (const name of ["history", "positions"])
    $(name + "Mode").onchange = () => {
      if (name === "history") historyCursor = 0;
      else positionsCursor = 0;
      previous[name] = [];
      void page(name).catch(showError);
    };
  $("statisticsMode").onchange = () => void stats().catch(showError);
  $("historyState").onchange = () => {
    historyCursor = 0;
    previous.history = [];
    void page("history").catch(showError);
  };
  $("logsOlder").onclick = () => {
    if (logState.paused) return;
    logsCursor = next.logs;
    void logs().catch(showError);
  };
  $("logsLatest").onclick = () => {
    logsCursor = 0;
    logState.page = 0;
    void logs().catch(showError);
  };
  $("logPause").onclick = () => {
    logState.paused = !logState.paused;
    renderLogTable();
  };
  $("logClear").onclick = () => {
    for (const e of logState.rows) logState.ignored.add(e.id);
    logState.rows = [];
    logState.page = 0;
    logState.expanded.clear();
    renderLogTable();
    $("logFeedback").textContent =
      "Đã xóa khỏi màn hình phiên này; dữ liệu backend và bot vẫn giữ nguyên.";
  };
  $("logExport").onclick = () => {
    const blob = new window.Blob([JSON.stringify(filteredLogs(), null, 2)], {
        type: "application/json",
      }),
      url = window.URL.createObjectURL(blob),
      a = node("a");
    a.href = url;
    a.download =
      "kronos-logs-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  };
  $("logSearch").oninput = (e) => {
    logState.search = e.target.value;
    logState.page = 0;
    renderLogTable();
  };
  $("logRange").onchange = (e) => {
    logState.range = e.target.value;
    logState.page = 0;
    renderLogTable();
  };
  $("logPrevious").onclick = () => {
    logState.page = Math.max(0, logState.page - 1);
    renderLogTable();
  };
  $("logNext").onclick = () => {
    logState.page++;
    renderLogTable();
  };
  const icons = {
    document:
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 12h8 M8 16h8",
    trash: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
    download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
    search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  };
  for (const host of document.querySelectorAll("[data-log-icon]")) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
      path = document.createElementNS(svg.namespaceURI, "path");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    path.setAttribute("d", icons[host.dataset.logIcon] || icons.document);
    svg.append(path);
    host.append(svg);
  }
  $("terminalLogFilter").onchange = () => {
    if (frame) renderOverview(frame);
  };
  $("collectionEnable").onclick = () => void control("enable").catch(showError);
  $("collectionPause").onclick = () => void control("pause").catch(showError);
  $("terminalPositionRows")
    .closest("table")
    .querySelector("thead tr")
    .replaceChildren(...positionHeaders.map((h) => node("th", h)));
  window.KronosOverview = { render: renderOverview, view };
  void get("/api/status")
    .then((s) => {
      statusData = s;
      return refresh();
    })
    .catch(showError);
  setInterval(() => void refresh(), 1000);
  setInterval(() => void refreshView().catch(showError), 5000);
})();
