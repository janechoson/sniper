const stages = {
  CHEAP_FILTER: "CHEAP FILTER",
  SECURITY: "SECURITY",
  COMPATIBILITY: "COMPATIBILITY",
  HISTORY: "MARKET HISTORY",
  CAPITAL_FLOW: "CAPITAL FLOW",
  COMMON_RISK: "COMMON RISK",
  RISK: "RISK",
  STRUCTURE: "STRUCTURE",
  FINAL_ANALYSIS: "FINAL ANALYSIS",
  OWNERSHIP_CAPITAL: "CAPITAL / OWNERSHIP",
  BUY_QUOTE: "BUY QUOTE",
  EXIT_FEASIBILITY: "EXIT FEASIBILITY",
  VALIDATE: "VALIDATION",
  SIMULATE: "SIMULATION",
  PRE_SIGN: "PRE-SIGN",
  BUY: "BUY",
  POSITION: "POSITION",
};
const reasons = {
  INSUFFICIENT_STRUCTURE_EVIDENCE: "Không đủ bằng chứng cấu trúc",
  CONTROLLED_MARKUP_STRUCTURE:
    "Controlled markup pattern detected · Manipulation Structure",
  INSUFFICIENT_MARKET_HISTORY: "Chưa đủ lịch sử thị trường hợp lệ",
  HISTORY_SOURCE_UNAVAILABLE: "Nguồn lịch sử thị trường chưa khả dụng",
  INSUFFICIENT_DATA: "Chưa đủ dữ liệu để đánh giá",
  SECURITY_EVIDENCE_UNKNOWN: "Chưa xác định được bằng chứng bảo mật",
  OPEN_POSITION_DUPLICATE: "Token đã có vị thế đang mở",
  DURABLE_BUY_DUPLICATE: "Đã có BUY intent hoặc giao dịch cần xử lý",
  TOKEN_ALREADY_OWNED: "Ví đang sở hữu token",
  NO_SELL_ROUTE: "Chưa có route SELL hợp lệ",
  NO_BUY_ROUTE: "Chưa có route BUY hợp lệ",
  PRE_SIGN_EVIDENCE_STALE: "Dữ liệu kiểm tra trước ký đã cũ",
  TEMPORARY_RISK_CHANGE: "Điều kiện rủi ro đã thay đổi",
  NEW_ENTRIES_DISABLED: "Đang tắt lệnh mua mới",
};
const paths = {
  document: [
    "M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9Z",
    "M14 2v7h7",
    "M7 13h10M7 17h7M7 5h3",
  ],
  search: ["m21 21-5-5", "M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0"],
  trash: ["M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"],
  download: ["M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"],
  SECURITY: ["M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z", "m8 12 3 3 5-6"],
  RISK: ["M8 2h8M8 22h8M6 2v5l6 5-6 5v5M18 2v5l-6 5 6 5v5"],
  STRUCTURE: ["M4 20V10h3v10M10 20V4h3v16M16 20v-8h3v8"],
  CANDIDATE: ["m12 2 10 5-10 5L2 7Z", "m2 12 10 5 10-5M2 17l10 5 10-5"],
  TRADE: ["M2 3h3l3 12h10l3-9H6M9 20h.01M18 20h.01"],
  SYSTEM: [
    "M12 3v2M12 19v2M3 12h2M19 12h2M6 6l1 1M17 17l1 1M6 18l1-1M17 7l1-1",
    "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  ],
  chevron: ["m7 10 5 5 5-5"],
};

Object.assign(stages, {
  KRONOS: "KRONOS ANALYSIS",
  CONTROLLED_MARKUP: "CONTROLLED MARKUP",
});
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === "string" ? v : "");
const knownStrategy = (v) => (["KRONOS"].includes(v) ? v : "");
const stamp = (v) =>
  typeof v === "number" && Number.isFinite(v) && v > 0
    ? v
    : typeof v === "string" && v.trim()
      ? Number.isFinite(Number(v))
        ? Number(v)
        : Number.isFinite(Date.parse(v))
          ? Date.parse(v)
          : null
      : null;
const fold = (v) =>
  str(v)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .toLowerCase();
const short = (v) =>
  v ? (v.length > 16 ? v.slice(0, 8) + "…" + v.slice(-5) : v) : "—";
const commonStages = new Set([
  "CHEAP_FILTER",
  "SECURITY",
  "COMPATIBILITY",
  "HISTORY",
  "CAPITAL_FLOW",
  "COMMON_RISK",
]);
function category(type, stage) {
  if (stage === "STRUCTURE" || /STRUCTURE|MARKUP/.test(type + " " + stage))
    return "STRUCTURE";
  if (stage === "SECURITY" || /SECURITY|RUG|HONEYPOT/.test(type))
    return "SECURITY";
  if (
    ["RISK", "OWNERSHIP_CAPITAL", "COMMON_RISK"].includes(stage) ||
    /^RISK/.test(type)
  )
    return "RISK";
  if (
    [
      "BUY_QUOTE",
      "EXIT_FEASIBILITY",
      "VALIDATE",
      "SIMULATE",
      "PRE_SIGN",
      "BUY",
      "POSITION",
    ].includes(stage) ||
    /^(BUY|SELL|TRADE|EXIT_|POSITION_|OWNERSHIP_)/.test(type)
  )
    return "TRADE";
  if (stage || /^(ATTEMPT|CANDIDATE|DISCOVER|ANALYZE|KRONOS_)/.test(type))
    return "CANDIDATE";
  return "SYSTEM";
}
function outcome(type, p, status) {
  const state = status || str(p.status) || str(p.result) || str(p.state);
  if (type === "ATTEMPT_BOUGHT" || type === "BUY_CONFIRMED") return "BOUGHT";
  if (type === "SELL_CONFIRMED")
    return p.positionState === "CLOSED" ? "CLOSED" : "SELL";
  if (type === "POSITION_CLOSED" || state === "CLOSED") return "CLOSED";
  if (type === "POSITION_OPENED" || state === "OPEN") return "OPEN";
  if (/BLOCKED_OWNER|OWNERSHIP_CLAIM_DENIED|EXECUTION_BLOCKED/.test(type))
    return "BLOCKED";
  if (type === "MANIPULATION_STRUCTURE_EVALUATED")
    return p.status === "STRONG" ? "WARNING" : "UNKNOWN";
  if (type === "STRUCTURE_EVIDENCE_V3")
    return p.supportLevel === "CONFLICTED"
      ? "WARNING"
      : p.evidence?.passed === true
        ? "PASS"
        : "UNKNOWN";
  if (
    ["FAIL", "REJECTED", "REJECT", "ERROR"].includes(state) ||
    /REJECT|FAILED|_FAIL$/.test(type) ||
    type === "ERROR"
  )
    return "FAIL";
  if (state === "SKIPPED") return "SKIPPED";
  if (
    ["PENDING", "CHECKING", "CREATED", "SUBMITTED"].includes(state) ||
    /STARTED|CHECKING|QUEUED|SUBMITTED|PENDING/.test(type)
  )
    return "PENDING";
  if (/UNKNOWN|RECONCILING|NO_DECISION/.test(state + " " + type))
    return "UNKNOWN";
  if (/WARNING|DEGRADED|ATTENTION|UNAVAILABLE|BACKOFF|NO_ROUTE/.test(type))
    return "WARNING";
  if (type === "RISK_ALLOW" || state === "ALLOW") return "ALLOW";
  if (state === "PASS" || /_PASS(?:ED)?$|_APPROVED$|_CONFIRMED$/.test(type))
    return "PASS";
  if (["BUY", "SELL", "WAIT", "HOLD"].includes(p.action)) return p.action;
  return "INFO";
}
/** Attribution uses explicit fields/context or the actual ATTEMPT_* reason format, not arbitrary UUIDs. */
export function normalizeLogEvent(raw, source = "event", context = {}) {
  const p = obj(raw.payload || raw),
    message = str(p.reason) || str(p.reasonCode) || str(p.message),
    type = str(p.type) || context.stage || "SYSTEM_EVENT";
  const at = stamp(raw.at ?? p.at ?? p.createdAt),
    pieces = message.split(" · ");
  const stage =
    context.stage ||
    str(p.stage) ||
    pieces.find((v) => Object.hasOwn(stages, v)) ||
    "";
  const fromReason = /^ATTEMPT_/.test(type)
    ? message.match(
        /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?: · |$)/i,
      )?.[1]
    : "";
  const attemptId = context.attemptId || str(p.attemptId) || fromReason || "";
  const mint = str(raw.mint) || str(p.mint) || context.mint || "",
    mode = str(p.mode) || context.mode || "";
  const strategy =
    knownStrategy(p.strategy) ||
    knownStrategy(context.strategy) ||
    knownStrategy(message.match(/^(KRONOS): /)?.[1]);
  const owner =
    knownStrategy(p.owner) ||
    knownStrategy(context.owner) ||
    (["POSITION_OWNER", "OWNERSHIP_CLAIM_SUCCESS"].includes(type)
      ? knownStrategy(p.strategy)
      : "");
  const result = outcome(type, p, context.status);
  const reasonCode =
    pieces.length > 1 && Object.hasOwn(stages, pieces[1])
      ? pieces.slice(2).join(" · ")
      : message
          .replace(/^(?:KRONOS: )?[A-Z_]+: (FAIL|PASS|CHECKING) · /, "")
          .replace(/^Token OUT · /, "");
  let title = stage ? stages[stage] || stage : type.replaceAll("_", " ");
  if (type === "ATTEMPT_STARTED" || /^Bắt đầu Fresh Attempt/.test(message))
    title = "Bắt đầu Fresh Attempt";
  else if (type === "ATTEMPT_REJECTED")
    title = (stages[stage] || "CANDIDATE") + " FAIL";
  else if (type === "ATTEMPT_BOUGHT" || type === "BUY_CONFIRMED")
    title = "BUY đã xác nhận";
  else if (stage)
    title +=
      " " +
      ({
        PENDING: "CHECKING",
        FAIL: "FAIL",
        PASS: "PASS",
        ALLOW: "ALLOW",
        SKIPPED: "SKIPPED",
        BUY: "BUY",
      }[result] || result);
  let detail = reasons[reasonCode]
    ? reasons[reasonCode] + " · " + reasonCode
    : message;
  if (type === "STRUCTURE_EVIDENCE_V3")
    detail = [
      "Price: " + (p.priceStatus || "UNKNOWN"),
      "Market flow: " + (p.marketFlowStatus || "UNKNOWN"),
      "Smart Money: " + (p.smartMoneyStatus || "UNKNOWN"),
      "Support: " + (p.supportLevel || "UNKNOWN"),
    ].join(" · ");
  if (type === "MANIPULATION_STRUCTURE_EVALUATED")
    detail =
      "Controlled markup: " +
      (p.status || "UNKNOWN") +
      (Array.isArray(p.reasons) ? " · " + p.reasons.join(" / ") : "");
  if (/^ATTEMPT_/.test(type) && message === attemptId) detail = "";
  const key =
    source +
    ":" +
    (raw.id !== undefined
      ? String(raw.id)
      : [
          attemptId,
          context.index ?? "",
          at,
          mint,
          type,
          context.status ?? "",
          message,
        ].join("|"));
  return {
    key,
    at,
    type,
    stage,
    attemptId,
    mint,
    mode,
    strategy,
    owner,
    result,
    title,
    detail,
    reasonCode,
    category: category(type, stage),
    symbol: str(p.symbol) || context.symbol || "",
    name: str(p.name) || context.name || "",
    positionId: str(p.positionId),
    executionId: str(p.executionId),
    attemptStartedAt: context.startedAt,
    attemptEndedAt: context.endedAt,
    attemptResult: context.attemptResult,
    raw,
  };
}
/** Group the whole loaded buffer before filtering/paging. Never merge explicit fresh-attempt IDs. */
export function groupLogEntries(input) {
  const rows = [...new Map(input.map((e) => [e.key, e])).values()].sort(
    (a, b) => (a.at ?? 0) - (b.at ?? 0),
  );
  const bounds = new Map(),
    byMint = new Map();
  for (const e of rows)
    if (e.mint && e.attemptId) {
      const key = e.mode + ":" + e.mint + ":" + e.attemptId;
      let b = bounds.get(key);
      if (!b) {
        b = {
          key,
          mint: e.mint,
          mode: e.mode,
          id: e.attemptId,
          start: null,
          end: null,
        };
        bounds.set(key, b);
      }
      const start =
        stamp(e.attemptStartedAt) ??
        (e.type === "ATTEMPT_STARTED" ? e.at : null);
      if (start !== null)
        b.start = b.start === null ? start : Math.min(b.start, start);
      const end =
        stamp(e.attemptEndedAt) ??
        (/^ATTEMPT_(REJECTED|BOUGHT|RECONCILING)$/.test(e.type) ? e.at : null);
      if (end !== null) b.end = b.end === null ? end : Math.max(b.end, end);
    }
  for (const b of bounds.values())
    if (b.start !== null) {
      const key = b.mode + ":" + b.mint;
      if (!byMint.has(key)) byMint.set(key, []);
      byMint.get(key).push(b);
    }
  for (const list of byMint.values()) list.sort((a, b) => a.start - b.start);
  const groups = new Map();
  for (const e of rows) {
    let kind = "activity",
      id = e.key,
      attemptId = e.attemptId;
    if (!e.mint) {
      kind = "system";
      id = e.key;
    } else if (attemptId) {
      kind = "attempt";
      id = attemptId;
    } else if (e.positionId) {
      kind = "position";
      id = e.positionId;
    } else if (e.executionId) {
      kind = "execution";
      id = e.executionId;
    } else {
      const list = byMint.get(e.mode + ":" + e.mint) || [];
      const candidate =
        e.category !== "SYSTEM" &&
        !/^(POSITION_|EXIT_|KRONOS_POSITION_|KRONOS_INFERENCE_FAILED|CAPITAL_FLOW_TRANSITION)/.test(
          e.type,
        );
      if (candidate && e.at !== null) {
        const prelude = /^CANDIDATE_(QUEUED|CHECKING)$/.test(e.type);
        const bound = prelude
          ? list.find(
              (b) =>
                b.start >= e.at &&
                !list.some(
                  (p) => p !== b && p.start > e.at && p.start < b.start,
                ),
            )
          : list.findLast(
              (b) => b.start <= e.at && (b.end === null || e.at <= b.end),
            );
        if (bound) {
          kind = "attempt";
          id = attemptId = bound.id;
        }
      }
    }
    const key = [e.mode, e.mint, kind, id].join("|");
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        kind,
        mint: e.mint,
        mode: e.mode,
        attemptId,
        events: [],
        strategies: [],
        owner: "",
        latest: e,
        frameResult: "",
      };
      groups.set(key, g);
    }
    g.events.push(e);
    g.latest = e;
    if (e.strategy && !g.strategies.includes(e.strategy))
      g.strategies.push(e.strategy);
    if (e.owner) g.owner = e.owner;
    if (e.attemptResult) g.frameResult = e.attemptResult;
  }
  for (const g of groups.values())
    g.result =
      g.frameResult === "BOUGHT"
        ? "BOUGHT"
        : g.frameResult === "REJECTED"
          ? "FAIL"
          : g.frameResult === "RECONCILING"
            ? "UNKNOWN"
            : g.latest.result;
  return [...groups.values()].sort(
    (a, b) =>
      (b.latest.at ?? 0) - (a.latest.at ?? 0) || b.key.localeCompare(a.key),
  );
}

/** Route-owned view. Detail requests, timers and object URLs die on navigation. */
export async function mount(ctx) {
  await import("./token-avatar.js");
  const tokenAvatar = (value) =>
    window.BOTTokenAvatar.create(value, "token-avatar rk-log-avatar");
  const $ = (id) => document.getElementById(id);
  const make = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  };
  const icon = (name) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    e.setAttribute("viewBox", "0 0 24 24");
    e.setAttribute("fill", "none");
    e.setAttribute("stroke", "currentColor");
    e.setAttribute("stroke-width", "1.7");
    e.setAttribute("stroke-linecap", "round");
    e.setAttribute("stroke-linejoin", "round");
    e.setAttribute("aria-hidden", "true");
    for (const d of paths[name] || paths.document) {
      const p = document.createElementNS(e.namespaceURI, "path");
      p.setAttribute("d", d);
      e.append(p);
    }
    return e;
  };
  const types = [
    "ALL",
    "CANDIDATE",
    "SECURITY",
    "RISK",
    "STRUCTURE",
    "TRADE",
    "SYSTEM",
  ];
  for (const target of document.querySelectorAll("[data-log-icon]"))
    target.replaceChildren(icon(target.dataset.logIcon));
  const symbols = {
    PASS: "✓",
    ALLOW: "✓",
    BUY: "✓",
    BOUGHT: "✓",
    OPEN: "✓",
    CLOSED: "✓",
    SELL: "✓",
    FAIL: "×",
    BLOCKED: "×",
    PENDING: "◌",
    UNKNOWN: "?",
    WARNING: "!",
    SKIPPED: "–",
    WAIT: "◷",
    HOLD: "◷",
    INFO: "•",
  };
  const resultLabel = (v) =>
    ({ PENDING: "CHECKING", FAIL: "FAIL", UNKNOWN: "UNKNOWN" })[v] || v;
  const badge = (v) => {
    const e = make(
      "span",
      (symbols[v] || "•") + " " + resultLabel(v),
      "rk-log-result",
    );
    e.dataset.result = v;
    return e;
  };
  const tag = (s, owner = false) => {
    const e = make("span", s + (owner ? " · OWNER" : ""), "strategy-badge");
    e.dataset.strategy = s;
    return e;
  };
  const time = (at, ms = false) =>
    at === null
      ? "—"
      : new Date(at).toLocaleTimeString("vi-VN", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }) +
        (ms
          ? "." + String(new Date(at).getMilliseconds()).padStart(3, "0")
          : "");
  const initial = new URLSearchParams(location.search);
  let type = types.includes(initial.get("type")) ? initial.get("type") : "ALL",
    page = 0,
    paused = null,
    clearedAt = 0,
    lastUpdated = null;
  const buffer = new Map(),
    tokens = new Map(),
    attempts = new Map(),
    expanded = new Set(),
    pending = new Set(),
    detailErrors = new Map(),
    rawExpanded = new Set(),
    rowCache = new Map();
  const pageSize = 40,
    root = $("terminalAllLogs");
  $("logSearch").value = initial.get("q") || "";
  $("logRange").value = ["today", "7d", "30d", "all"].includes(
    initial.get("range"),
  )
    ? initial.get("range")
    : "today";
  $("logPause").textContent = "Tạm dừng hiển thị";
  $("logClear").title = "Chỉ xóa bộ đệm hiển thị; không xóa log trong DB";
  const filterButtons = new Map();
  $("logTypeFilters").replaceChildren(
    ...types.map((t) => {
      const b = make("button", t);
      b.className = "insights-filter-pill";
      b.type = "button";
      b.onclick = () => {
        type = t;
        page = 0;
        syncQuery();
        render();
      };
      filterButtons.set(t, b);
      return b;
    }),
  );
  function syncQuery() {
    ctx.query({
      type: type === "ALL" ? null : type,
      q: $("logSearch").value.trim() || null,
      range: $("logRange").value === "today" ? null : $("logRange").value,
    });
  }
  function rememberAttempt(a, claim, loaded = false) {
    if (!a?.attemptId || !a.mint) return;
    const old = attempts.get(a.attemptId);
    attempts.set(a.attemptId, {
      attempt: a,
      claim: claim || old?.claim,
      loaded: loaded || old?.loaded,
    });
    while (attempts.size > 60) {
      const victim = [...attempts.keys()].find(
        (id) =>
          !expanded.has([...rowCache.keys()].find((k) => k.endsWith("|" + id))),
      );
      attempts.delete(victim || attempts.keys().next().value);
    }
  }
  function entries() {
    if (paused) return paused;
    const rows = [...buffer.values()].map((e) => ({
      ...e,
      symbol: e.symbol || tokens.get(e.mint)?.symbol || "",
      name: e.name || tokens.get(e.mint)?.name || "",
    }));
    for (const { attempt: a, claim } of attempts.values()) {
      const owner =
        knownStrategy(claim?.strategy) ||
        knownStrategy(a.summaries?.ownershipClaim?.strategy);
      for (const [index, l] of (a.logs || []).entries())
        rows.push(
          normalizeLogEvent(l, "attempt", {
            attemptId: a.attemptId,
            mint: a.mint,
            mode: a.mode,
            symbol: a.symbol,
            name: a.name,
            startedAt: a.startedAt,
            endedAt: a.endedAt,
            attemptResult: a.result,
            owner,
            index,
            stage: l.stage,
            status: l.status,
          }),
        );
    }
    return rows.filter((e) => clearedAt === 0 || (e.at ?? 0) > clearedAt);
  }
  function eventInRange(e) {
    const r = $("logRange").value;
    if (r === "all") return true;
    if (e.at === null) return false;
    const now = new Date(),
      start =
        r === "today"
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
          : Date.now() - (r === "7d" ? 7 : 30) * 86400000;
    return e.at >= start;
  }
  function select() {
    const query = fold($("logSearch").value.trim());
    const all = groupLogEntries(entries());
    const searched = all.filter(
      (g) =>
        !query ||
        fold(
          [
            g.mint,
            g.attemptId,
            g.owner,
            ...g.events.flatMap((e) => [
              e.symbol,
              e.name,
              e.type,
              e.stage,
              e.strategy,
              e.title,
              e.detail,
              e.reasonCode,
            ]),
          ].join(" "),
        ).includes(query),
    );
    const inTime = searched
      .map((g) => ({ ...g, visible: g.events.filter(eventInRange) }))
      .filter((g) => g.visible.length);
    const filtered = inTime
      .map((g) => ({
        ...g,
        visible: g.visible.filter((e) => type === "ALL" || e.category === type),
      }))
      .filter((g) => g.visible.length);
    return { all, inTime, filtered };
  }
  async function loadDetail(g) {
    if (
      !g.attemptId ||
      pending.has(g.attemptId) ||
      attempts.get(g.attemptId)?.loaded ||
      paused
    )
      return;
    pending.add(g.attemptId);
    detailErrors.delete(g.attemptId);
    render();
    try {
      const data = await ctx.get(
        "/api/attempt?id=" + encodeURIComponent(g.attemptId),
        "log-attempt:" + g.attemptId,
      );
      if (!ctx.active()) return;
      if (data.attemptId !== g.attemptId || data.mint !== g.mint)
        throw Error("Attempt không còn trong bộ lưu hoặc không khớp token");
      rememberAttempt(data, data.ownershipClaim, true);
    } catch (e) {
      if (ctx.active() && e.name !== "AbortError")
        detailErrors.set(g.attemptId, e.message);
    } finally {
      pending.delete(g.attemptId);
      if (ctx.active()) render();
    }
  }
  function timeline(g, cell) {
    const note = make(
      "p",
      pending.has(g.attemptId)
        ? "Đang tải timeline đã lưu…"
        : detailErrors.get(g.attemptId) ||
            "Theo thời gian tăng dần · sự kiện đã tải; không phải toàn bộ DB",
      "rk-log-timeline-note",
    );
    cell.append(note);
    if (detailErrors.has(g.attemptId)) {
      const retry = make("button", "Thử tải lại");
      retry.type = "button";
      retry.onclick = () => loadDetail(g);
      cell.append(retry);
    }
    const list = make("ol", undefined, "rk-log-timeline");
    for (const e of g.visible) {
      const item = make("li");
      item.dataset.eventKey = e.key;
      item.dataset.result = e.result;
      const clock = make("time", time(e.at, true));
      if (e.at !== null) clock.dateTime = new Date(e.at).toISOString();
      const dot = make("span", symbols[e.result] || "•", "rk-log-timeline-dot");
      const content = make("div", undefined, "rk-log-event");
      const heading = make("div", undefined, "rk-log-event-heading");
      heading.append(make("strong", e.title), badge(e.result));
      if (e.strategy) heading.append(tag(e.strategy));
      content.append(heading);
      if (e.detail) content.append(make("p", e.detail));
      const raw = make("details", undefined, "rk-log-raw");
      raw.append(make("summary", "Dữ liệu sự kiện"));
      raw.addEventListener("toggle", () => {
        if (raw.open) rawExpanded.add(e.key);
        else rawExpanded.delete(e.key);
        if (raw.open && raw.children.length === 1)
          raw.append(make("pre", JSON.stringify(e.raw, null, 2)));
      });
      raw.open = rawExpanded.has(e.key);
      content.append(raw);
      item.append(clock, dot, content);
      list.append(item);
    }
    cell.append(list);
  }
  function toggle(g) {
    if (expanded.has(g.key)) expanded.delete(g.key);
    else expanded.add(g.key);
    render();
    if (expanded.has(g.key)) void loadDetail(g);
  }
  function render() {
    if (!ctx.active()) return;
    const selected = select(),
      groups = selected.filtered;
    page = Math.min(page, Math.max(0, Math.ceil(groups.length / pageSize) - 1));
    const wrap = root.closest(".insights-log-table-wrap"),
      view = wrap.getBoundingClientRect();
    const anchor = [
      ...root.querySelectorAll("li[data-event-key],tr[data-expanded='true']"),
    ].find((e) => {
      const r = e.getBoundingClientRect();
      return (
        r.top >= Math.max(0, view.top) &&
        r.top < Math.min(view.bottom, window.innerHeight)
      );
    });
    const anchorKey = anchor?.dataset.eventKey || anchor?.dataset.logKey,
      anchorTop = anchor?.getBoundingClientRect().top;
    const nodes = [];
    for (const g of groups.slice(page * pageSize, (page + 1) * pageSize)) {
      let pair = rowCache.get(g.key);
      if (!pair) {
        pair = {
          row: make("tr", undefined, "insights-log-row rk-log-parent"),
          detail: make("tr", undefined, "rk-log-detail"),
        };
        rowCache.set(g.key, pair);
      }
      const row = pair.row;
      row.dataset.logKey = g.key;
      row.dataset.attemptId = g.attemptId || "";
      row.dataset.expanded = String(expanded.has(g.key));
      row.dataset.result = g.result;
      row.replaceChildren();
      const clock = make("td", time(g.latest.at));
      clock.title =
        g.latest.at === null
          ? "Không có timestamp"
          : new Date(g.latest.at).toLocaleString("vi-VN");
      const identity = make("td"),
        box = make("div", undefined, "rk-log-token");
      const info = make("div"),
        meta = tokens.get(g.mint) || {},
        latestName = [...g.events].reverse().find((e) => e.symbol || e.name);
      const symbol = meta.symbol || latestName?.symbol || "",
        name = meta.name || latestName?.name || "";
      if (g.mint) {
        box.append(
          tokenAvatar({
            mint: g.mint,
            symbol: symbol || short(g.mint),
            logo: meta.logo,
            size: 30,
          }),
        );
        info.append(make("strong", symbol || name || short(g.mint)));
        const mint = make("button", short(g.mint), "rk-log-mint");
        mint.type = "button";
        mint.title = "Sao chép mint: " + g.mint;
        mint.onclick = async (e) => {
          e.stopPropagation();
          try {
            await window.navigator.clipboard.writeText(g.mint);
            $("logFeedback").textContent = "Đã sao chép mint";
          } catch {
            $("logFeedback").textContent = g.mint;
          }
        };
        info.append(mint);
      } else {
        const s = make("span", undefined, "rk-log-system-icon");
        s.append(icon("SYSTEM"));
        box.append(s);
        info.append(
          make("strong", "System"),
          make("small", "Sự kiện hệ thống"),
        );
      }
      box.append(info);
      identity.append(box);
      const strategies = make("td");
      if (g.owner) strategies.append(tag(g.owner, true));
      else if (g.strategies.length)
        for (const s of g.strategies) strategies.append(tag(s));
      else
        strategies.append(
          make(
            "span",
            commonStages.has(g.latest.stage) ? "COMMON" : "—",
            "rk-log-common",
          ),
        );
      const stage = make("td");
      stage.append(
        make(
          "strong",
          g.latest.stage
            ? stages[g.latest.stage] || g.latest.stage
            : g.latest.title,
        ),
      );
      stage.append(
        make(
          "small",
          g.attemptId
            ? "Attempt " + short(g.attemptId)
            : g.kind === "position"
              ? "Position"
              : g.kind === "execution"
                ? "Execution"
                : g.mint
                  ? "Chưa có attempt ID"
                  : "System",
        ),
      );
      stage.title = g.latest.detail;
      const status = make("td");
      status.append(badge(g.result));
      const count = make("td", g.events.length, "rk-log-count");
      count.title =
        g.visible.length +
        " sự kiện phù hợp bộ lọc / " +
        g.events.length +
        " đã tải";
      const action = make("td"),
        button = make(
          "button",
          expanded.has(g.key) ? "⌃" : "⌄",
          "rk-log-expand",
        );
      button.type = "button";
      button.setAttribute(
        "aria-label",
        (expanded.has(g.key) ? "Thu gọn" : "Mở timeline") +
          " " +
          (symbol || "System"),
      );
      button.setAttribute("aria-expanded", String(expanded.has(g.key)));
      button.onclick = (e) => {
        e.stopPropagation();
        toggle(g);
      };
      action.append(button);
      row.append(clock, identity, strategies, stage, status, count, action);
      row.onclick = (e) => {
        if (!e.target.closest("button,a,input,summary")) toggle(g);
      };
      nodes.push(row);
      if (expanded.has(g.key)) {
        const fingerprint =
          g.visible.map((e) => e.key + ":" + e.strategy).join("|") +
          pending.has(g.attemptId) +
          (detailErrors.get(g.attemptId) || "");
        if (pair.fingerprint !== fingerprint || !pair.detail.children.length) {
          const cell = make("td");
          cell.colSpan = 7;
          pair.detail.replaceChildren(cell);
          timeline(g, cell);
          pair.fingerprint = fingerprint;
        }
        nodes.push(pair.detail);
      } else pair.detail.replaceChildren();
    }
    root.replaceChildren(...nodes);
    if (anchorKey) {
      const same = [
        ...root.querySelectorAll("li[data-event-key],tr[data-log-key]"),
      ].find((e) => (e.dataset.eventKey || e.dataset.logKey) === anchorKey);
      if (same && anchorTop !== undefined)
        wrap.scrollTop += same.getBoundingClientRect().top - anchorTop;
    }
    const activeKeys = new Set(selected.all.map((g) => g.key));
    for (const [key] of rowCache)
      if (!activeKeys.has(key)) {
        rowCache.delete(key);
        expanded.delete(key);
      }
    const eventKeys = new Set(
      selected.all.flatMap((g) => g.events.map((e) => e.key)),
    );
    for (const key of rawExpanded)
      if (!eventKeys.has(key)) rawExpanded.delete(key);
    for (const [t, b] of filterButtons) {
      const n = selected.inTime.filter(
        (g) => t === "ALL" || g.visible.some((e) => e.category === t),
      ).length;
      b.textContent = t + " (" + n + ")";
      b.classList.toggle("active", t === type);
      b.setAttribute("aria-pressed", String(t === type));
    }
    $("logEmpty").classList.toggle("hidden", groups.length > 0);
    $("logEmpty").querySelector("strong").textContent =
      "Không có nhóm log phù hợp";
    $("logEmpty").querySelector("p").textContent =
      "Thử đổi bộ lọc hoặc tìm trong các sự kiện đã tải.";
    $("logPage").textContent =
      (groups.length ? page * pageSize + 1 : 0) +
      "–" +
      Math.min((page + 1) * pageSize, groups.length) +
      " / " +
      groups.length +
      " nhóm";
    $("logPrevious").disabled = page === 0;
    $("logNext").disabled = (page + 1) * pageSize >= groups.length;
    $("logScope").textContent =
      selected.all.length +
      " nhóm · " +
      entries().length +
      " sự kiện đã tải · bộ đệm giới hạn, không phải toàn bộ DB";
    $("logStreamStatus").textContent = paused
      ? "Tạm dừng hiển thị · bot vẫn chạy"
      : lastUpdated
        ? "Đang cập nhật · " + time(lastUpdated)
        : "Đang chờ dữ liệu";
    $("logStreamStatus").dataset.state = paused ? "paused" : "connected";
    $("logPause").textContent = paused
      ? "Tiếp tục hiển thị"
      : "Tạm dừng hiển thị";
  }
  function ingest(data) {
    for (const t of data.tokens || []) if (t.mint) tokens.set(t.mint, t);
    while (tokens.size > 1000) tokens.delete(tokens.keys().next().value);
    for (const [source, rows] of [
      ["event", data.events || []],
      ["flow", data.transitions || data.flow?.events || []],
    ])
      for (const r of rows) {
        const e = normalizeLogEvent(r, source, { mode: data.mode });
        buffer.set(e.key, e);
      }
    const sorted = [...buffer.values()].sort(
      (a, b) => (b.at ?? 0) - (a.at ?? 0),
    );
    buffer.clear();
    for (const e of sorted.slice(0, 2000)) buffer.set(e.key, e);
    rememberAttempt(data.overview?.attempt || data.attempt);
    lastUpdated = Date.now();
    render();
  }
  $("logSearch").oninput = () => {
    page = 0;
    syncQuery();
    render();
  };
  $("logRange").onchange = () => {
    page = 0;
    syncQuery();
    render();
  };
  $("logPause").onclick = () => {
    paused = paused ? null : entries().map((e) => ({ ...e }));
    render();
  };
  $("logClear").onclick = () => {
    clearedAt = Date.now();
    buffer.clear();
    attempts.clear();
    expanded.clear();
    rawExpanded.clear();
    rowCache.clear();
    paused = paused ? [] : null;
    page = 0;
    $("logFeedback").textContent = "Đã xóa bộ đệm hiển thị. Log DB giữ nguyên.";
    render();
  };
  $("logPrevious").onclick = () => {
    page--;
    render();
  };
  $("logNext").onclick = () => {
    page++;
    render();
  };
  $("logExport").onclick = () => {
    const groups = select().filtered.map((g) => ({
      key: g.key,
      attemptId: g.attemptId,
      mint: g.mint,
      owner: g.owner || null,
      result: g.result,
      events: g.visible.map((e) => e.raw),
    }));
    const url = URL.createObjectURL(
      new window.Blob(
        [
          JSON.stringify(
            { scope: "LOADED_BUFFER_ONLY", exportedAt: Date.now(), groups },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    ctx.trackObjectUrl(url);
    const a = make("a");
    a.href = url;
    a.download = "rug-killer-logs.json";
    a.click();
  };
  const refresh = async () => ingest(await ctx.get("/api/logs?limit=800"));
  ctx.setRefresh(refresh);
  ctx.onDispose(() => {
    buffer.clear();
    attempts.clear();
    tokens.clear();
    rowCache.clear();
    expanded.clear();
    rawExpanded.clear();
  });
  render();
  await ctx.poll(refresh, 5000);
}
