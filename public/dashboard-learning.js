const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (cls) node.className = cls;
  return node;
};
const time = (at) =>
  Number.isFinite(at) ? new Date(at).toLocaleString("vi-VN") : "Không rõ";
const pretty = (value) =>
  el("pre", JSON.stringify(value, null, 2), "learning-evidence");
const button = (label, work) => {
  const b = el("button", label);
  b.type = "button";
  b.addEventListener("click", work);
  return b;
};
const learningStatusVi = (status) => ({ DRAFT: "Bản nháp", OBSERVING: "Đang theo dõi", VALIDATING: "Đang kiểm định", VALIDATED: "Đã hợp lệ", REJECTED: "Bị từ chối", RETIRED: "Đã ngừng dùng", PENDING: "Đang chờ", RUNNING: "Đang chạy", RETRY_WAIT: "Chờ thử lại", COMPLETED: "Hoàn tất", DEAD_LETTER: "Đã dừng vì lỗi", FAILED: "Thất bại", CANCELLED: "Đã hủy", WAITING_FOR_ELIGIBILITY: "Chờ đủ điều kiện", READY_FOR_ANALYSIS: "Đủ dữ liệu phân tích", INCOMPLETE: "Thiếu dữ liệu", POST_SELL_COLLECTING: "Đang thu thập sau bán" }[status] || status || "Chưa có trạng thái");
const learningErrorVi = (error) => String(error || "").startsWith("CODEX_INPUT_TOO_LARGE") ? "Dữ liệu gửi phân tích vượt giới hạn cho phép." : String(error || "").startsWith("CODEX_HTTP_400") ? `OpenAI từ chối yêu cầu (HTTP 400) · ${error}` : String(error || "").startsWith("CODEX_HTTP_429") ? `OpenAI giới hạn tốc độ gọi; hệ thống chờ cooldown rồi thử lại · ${error}` : error === "CODEX_BUSY_OR_RATE_LIMITED" ? "Đang trong thời gian chờ sau lỗi giới hạn tốc độ; chưa gửi yêu cầu mới." : error || "Không có chi tiết lỗi.";

/** Local SVG candles and volume, no remote scripts or synthetic values. */
export function candleChart(candles, markers = [], select = () => {}, options = {}) {
  const wrap = el("div", undefined, "learning-chart");
  if (!candles.length) {
    wrap.append(el("p", "No persisted candles for this interval."));
    return wrap;
  }
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 1000 400");
  svg.style.touchAction = "none";
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    "Persisted one minute candlesticks with USD volume and decision markers",
  );
  const low = Math.min(...candles.map((c) => c.low)),
    high = Math.max(...candles.map((c) => c.high));
  const range = high - low || high * 0.01,
    dx = 920 / candles.length;
  const y = (v) => 30 + ((high - v) / range) * 250;
  const maxVol = Math.max(1, ...candles.map((c) => c.volumeUsd ?? 0));
  const draw = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    svg.append(n);
    return n;
  };
  for (let i = 0; i < 5; i++) {
    const value = high - (range * i) / 4;
    draw("line", {
      x1: 50,
      x2: 980,
      y1: y(value),
      y2: y(value),
      stroke: "#26344d",
    });
    draw("text", {
      x: 1,
      y: y(value),
      fill: "#aab9ce",
      "font-size": 11,
    }).textContent = value.toPrecision(4);
  }
  candles.forEach((c, i) => {
    const x = 55 + i * dx,
      color = c.close >= c.open ? "#3dd6a4" : "#fa647c";
    draw("line", { x1: x, x2: x, y1: y(c.high), y2: y(c.low), stroke: color });
    const body = draw("rect", {
      x: x - dx * 0.3,
      y: y(Math.max(c.open, c.close)),
      width: Math.max(1, dx * 0.6),
      height: Math.max(1, Math.abs(y(c.open) - y(c.close))),
      fill: color,
    });
    const title = document.createElementNS(ns, "title");
    title.textContent = `${time(c.at)}\nO ${c.open} H ${c.high} L ${c.low} C ${c.close}\nVolume USD ${c.volumeUsd ?? "MISSING"}`;
    body.append(title);
    if (c.volumeUsd !== null && options.showVolume !== false)
      draw("rect", {
        x: x - dx * 0.3,
        y: 365 - (c.volumeUsd / maxVol) * 60,
        width: Math.max(1, dx * 0.6),
        height: (c.volumeUsd / maxVol) * 60,
        fill: color,
        opacity: 0.5,
      });
  });
  draw("text", {
    x: 50,
    y: 390,
    fill: "#aab9ce",
    "font-size": 12,
  }).textContent = time(candles[0].at);
  draw("text", {
    x: 740,
    y: 390,
    fill: "#aab9ce",
    "font-size": 12,
  }).textContent = time(candles.at(-1).at);
  markers.filter(() => options.showMarkers !== false).forEach((m, j) => {
    const at = m.at ?? m.decisionAt,
      i = candles.findIndex((c) => at >= c.at && at < c.at + 60000);
    if (i < 0) return;
    const x = 55 + i * dx,
      label = m.label ?? m.action ?? m.kind ?? "Decision";
    if (m.kind === "RUG_30") {
      draw("line", {
        x1: x,
        x2: x,
        y1: 30,
        y2: 345,
        stroke: "#f04452",
        "stroke-width": 2,
        "stroke-dasharray": "5 5",
      });
      draw("rect", {
        x: Math.min(810, Math.max(60, x + 10)),
        y: 12,
        width: 155,
        height: 40,
        rx: 5,
        fill: "#b91f2b",
      });
      draw("text", {
        x: Math.min(820, Math.max(70, x + 20)),
        y: 29,
        fill: "#fff",
        "font-size": 12,
        "font-weight": 700,
      }).textContent = `RUG_30 (-${Number(m.dropPercent).toFixed(1)}%)`;
    }
    const mark = draw("circle", {
      cx: x,
      cy: 12 + (j % 3) * 9,
      r: 5,
      fill: label.includes("SELL") ? "#fbbf24" : "#93c5fd",
      tabindex: 0,
      role: "button",
      "aria-label": label + " " + time(at),
    });
    mark.addEventListener("click", () => select(m));
    mark.addEventListener("keydown", (e) => {
      if (e.key === "Enter") select(m);
    });
    const t = document.createElementNS(ns, "title");
    t.textContent = label + " " + time(at);
    mark.append(t);
  });
  const crosshairX = draw("line", {
      x1: 0, x2: 0, y1: 30, y2: 345, stroke: "#d7e0ef", opacity: 0,
      "stroke-dasharray": "3 4",
    }),
    crosshairY = draw("line", {
      x1: 50, x2: 980, y1: 0, y2: 0, stroke: "#d7e0ef", opacity: 0,
      "stroke-dasharray": "3 4",
    });
  let viewX = 0, viewWidth = 1000, dragX = null;
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect(),
      anchor = viewX + ((event.clientX - rect.left) / rect.width) * viewWidth,
      width = Math.max(300, Math.min(1000, viewWidth * (event.deltaY < 0 ? 0.85 : 1.18)));
    viewX = Math.max(0, Math.min(1000 - width, anchor - ((anchor - viewX) / viewWidth) * width));
    viewWidth = width;
    svg.setAttribute("viewBox", `${viewX} 0 ${viewWidth} 400`);
  }, { passive: false });
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragX = event.clientX;
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointerup", () => { dragX = null; });
  svg.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    if (dragX !== null) {
      const shift = ((dragX - event.clientX) / rect.width) * viewWidth;
      viewX = Math.max(0, Math.min(1000 - viewWidth, viewX + shift));
      dragX = event.clientX;
      svg.setAttribute("viewBox", `${viewX} 0 ${viewWidth} 400`);
      return;
    }
    const px = viewX + ((event.clientX - rect.left) / rect.width) * viewWidth,
      py = ((event.clientY - rect.top) / rect.height) * 400,
      index = Math.max(0, Math.min(candles.length - 1, Math.round((px - 55) / dx))),
      candle = candles[index];
    if (!candle) return;
    const cx = 55 + index * dx;
    crosshairX.setAttribute("x1", String(cx)); crosshairX.setAttribute("x2", String(cx));
    crosshairX.setAttribute("opacity", "0.8");
    crosshairY.setAttribute("y1", String(py)); crosshairY.setAttribute("y2", String(py));
    crosshairY.setAttribute("opacity", "0.8");
    svg.setAttribute("aria-label", `${time(candle.at)} · Open ${candle.open} · High ${candle.high} · Low ${candle.low} · Close ${candle.close} · Volume USD ${candle.volumeUsd ?? "N/A"}`);
  });
  wrap.append(svg);
  const legend = el("div", undefined, "learning-marker-list");
  for (const m of markers)
    legend.append(
      button(
        `${m.label ?? m.action ?? m.kind} · ${time(m.at ?? m.decisionAt)}`,
        () => select(m),
      ),
    );
  wrap.append(legend);
  return wrap;
}

export async function mount(ctx) {
  const root = document.getElementById("learningRows"),
    detail = document.getElementById("learningDetail");
  let data,
    tab = "Overview",
    selectedEventId = window.sessionStorage.getItem("chart-learning-event") || "",
    selectedEventData,
    eventFilter = window.sessionStorage.getItem("chart-learning-filter") || "ALL",
    eventSearch = window.sessionStorage.getItem("chart-learning-search") || "",
    eventPage = 0,
    chartWindow = 60,
    selectionRequest = 0;
  const read = (path, id) =>
    ctx.get(
      "/api/chart-learning" +
        path +
        (id ? "?id=" + encodeURIComponent(id) : ""),
    );
  const shortMint = (mint) =>
    mint && mint.length > 18 ? mint.slice(0, 7) + "…" + mint.slice(-7) : mint || "N/A";
  const metricValue = (value, suffix = "") =>
    value === null || value === undefined || !Number.isFinite(Number(value))
      ? "N/A"
      : Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 }) + suffix;
  function renderHealth() {
    const status = data.status || {},
      runtime = status.analyzer?.runtime || status.runtime || {},
      analysis = data.analysisStatus || {};
    const guard = data.aiGuardStatus || {}, latest = guard.latest || {};
    document.getElementById("aiGuardState").textContent = guard.enabled ? (guard.active ? "Đang suy luận" : "Bật · fail closed") : "Tắt · từ chối BUY";
    document.getElementById("aiGuardRuntime").textContent = `${guard.runtime?.state || "N/A"} · inference timeout ${guard.timeoutMs || 8000}ms · PASS TTL ${guard.passTtlMs || 15000}ms (bị chặn theo tuổi evidence) · concurrency ${guard.concurrency || 1} · fail ${guard.failPolicy || "BLOCK"} · cold start ${guard.coldStartPolicy || "UNCERTAIN"}`;
    document.getElementById("aiGuardLatest").textContent = latest.action || "Chưa có đánh giá";
    document.getElementById("aiGuardLatency").textContent = latest.id ? `${latest.durationMs}ms total · queue ${latest.queueWaitMs}ms · p50/p95/p99 ${guard.latencyMs?.p50 ?? "N/A"}/${guard.latencyMs?.p95 ?? "N/A"}/${guard.latencyMs?.p99 ?? "N/A"}ms · ${latest.summary || latest.runtimeOutcome}` : "Chưa có mẫu latency thực tế";
    document.getElementById("aiGuardKnowledge").textContent = String(guard.validatedKnowledgeCount ?? 0);
    document.getElementById("aiGuardMatches").textContent = (latest.matchedKnowledge || []).map((item) => item.knowledgeId).join(", ") || "Không có pattern đã match gần nhất";
    document.getElementById("aiGuardErrors").textContent = String(guard.errorCount ?? 0);
    document.getElementById("aiGuardQueue").textContent = `${guard.timeoutCount ?? 0} timeout · ${guard.active ? 1 : 0} active · ${guard.queued ?? 0} queued`;
    const collector = document.getElementById("learningCollector");
    collector.textContent = status.collector?.state === "PAUSED"
      ? "Tạm dừng"
      : status.collector?.state === "ERROR"
        ? "Collector gặp lỗi"
        : status.collector?.active
          ? "Đang thu thập dữ liệu"
          : "Đang quan sát · cập nhật định kỳ";
    collector.title = status.collector?.lastError || "Collector độc lập với Codex";
    document.getElementById("learningCollectorDetail").textContent = status.collector?.lastError || "Tự thu thập sau BUY đã xác nhận · gồm theo dõi sau SELL";
    const providerLabel =
      runtime.state === "READY"
          ? "AUTO · Codex sẵn sàng"
        : runtime.state === "MISSING_OPENAI_API_KEY"
          ? "Chưa cấu hình OpenAI API"
          : runtime.lastError === "CODEX_HTTP_429"
            ? "OpenAI API trả 429 · chưa rõ nguyên nhân"
            : runtime.lastError
              ? "Codex tạm ngừng · " + runtime.lastError
              : "Codex chưa sẵn sàng · " + (runtime.state || "N/A");
    document.getElementById("learningProvider").textContent = providerLabel;
    document.getElementById("learningProvider").title =
      runtime.lastError || runtime.model || runtime.state || "";
    const usage = runtime.usage || {}, cost = runtime.estimatedCost || {};
    const usageText = `API calls ${usage.totalCalls ?? runtime.calls ?? 0} · tokens input/output/total ${usage.inputTokens ?? 0}/${usage.outputTokens ?? 0}/${usage.totalTokens ?? runtime.tokens ?? 0}${cost.configured ? ` · est. $${Number(cost.usd || 0).toFixed(4)}` : ""}`;
    document.getElementById("learningProviderDetail").textContent = runtime.lastError
      ? `Lỗi gần nhất: ${runtime.lastError} · ${usageText}`
      : `${usageText} · gần nhất: ${analysis.lastAnalyzedAt ? time(analysis.lastAnalyzedAt) : "chưa phân tích case"}`;
    const auto = data.autoLearningStatus || {};
    document.getElementById("learningQueueHealth").textContent = `${auto.enabled ? "AUTO" : "TẮT"} · ${auto.automaticJobs?.pending ?? 0} chờ · ${auto.automaticJobs?.running ?? 0} chạy`;
    document.getElementById("learningQueueHealth").title = `Delay tối thiểu ${auto.delayMs ?? 30000}ms · một job mỗi case/version`;
    document.getElementById("learningQueueDetail").textContent = `${auto.automaticJobs?.completed ?? 0} hoàn tất · ${auto.automaticJobs?.retry_wait ?? 0} chờ thử lại · ${auto.automaticJobs?.dead_letter ?? 0} thất bại · kế tiếp ${auto.nextEligibleAt ? time(auto.nextEligibleAt) : "chưa xếp lịch"}`;
    document.getElementById("learningValidation").textContent = `${data.aiGuardStatus?.validatedKnowledgeCount ?? 0} knowledge đang hoạt động`;
    const drift=data.validationStatus?.drift||{};
    document.getElementById("learningValidationDetail").textContent = `Holdout tự động · drift ${drift.sample_count ?? 0} case / ${drift.dangerous_count ?? 0} rủi ro · ngưỡng ${drift.minCases ?? 10} case`;
    document.getElementById("learningStatus").textContent =
      `Shared Learning · ${data.overview.policy} · dữ liệu thị trường dùng chung giữa DEMO/LIVE`;
    document.getElementById("learningCaseStatus").textContent = `Thu thập: ${learningStatusVi(status.collector?.state || "RUNNING")} · Tự học: ${auto.enabled ? "Bật" : "Tắt"} · trễ ${auto.delayMs ?? 30000}ms · ${auto.automaticJobs?.pending ?? 0} chờ / ${auto.automaticJobs?.running ?? 0} đang chạy / ${auto.automaticJobs?.dead_letter ?? 0} thất bại · kiểm định: ${data.validationStatus?.jobs?.pending ?? 0} chờ / ${data.validationStatus?.jobs?.running ?? 0} đang chạy`;
  }
  function renderCaseList() {
    const list = document.getElementById("learningCaseList"), cases = data?.learningCases || [];
    list.replaceChildren();
    if (!cases.length) list.append(el("p", "Chưa có vị thế BUY đủ điều kiện cho Learning."));
    for (const item of cases) {
      const row = el("div", undefined, "learning-case-row");
      row.append(el("strong", shortMint(item.mint)), el("small", `${item.mode.toUpperCase()} · ${item.positionStatus} · ${learningStatusVi(item.collectionStatus)}`), el("small", `PnL ${metricValue(item.realizedPnlPct, "%")} · post-SELL ${item.followupsCollected}/4`), el("small", `Phân tích tự động: ${learningStatusVi(item.autoLearningState || "WAITING_FOR_ELIGIBILITY")}${item.eligibleAt ? ` · đủ điều kiện ${time(item.eligibleAt)}` : ""}`));
      if (item.autoLearningError) row.append(el("small", `Lý do: ${learningErrorVi(item.autoLearningError)}`));
      if (item.autoLearningState === "DEAD_LETTER" && item.autoLearningJobId)
        row.append(button("Thử phân tích lại", async () => {
          try { await ctx.post(`/api/chart-learning/auto-learning-jobs/${encodeURIComponent(item.autoLearningJobId)}/retry`, {}); data = await read(""); renderHealth(); renderCaseList(); }
          catch (error) { ctx.error(error); }
        }));
      if (item.analysisStatus === "COMPLETED") {
        row.append(button("Xem phân tích", async () => {
          try {
            const result = await ctx.get(`/api/chart-learning/analysis-jobs/${encodeURIComponent(item.analysisJobId)}`);
            const panel = document.getElementById("learningCaseAnalysis");
            let analysis = result.result;
            try { if (typeof analysis === "string") analysis = JSON.parse(analysis); } catch { /* Keep the stored result visible. */ }
            panel.hidden = false;
            panel.replaceChildren(el("h4", `Codex analysis · ${shortMint(item.mint)}`), pretty(analysis));
          } catch (error) { ctx.error(error); }
        }));
      }
      list.append(row);
    }
  }
  function renderKnowledge() {
    const list = document.getElementById("semanticKnowledgeList");
    list.replaceChildren();
    for (const item of data?.knowledge || []) {
      const row = el("div", undefined, "learning-case-row");
      row.append(el("strong", item.title), el("small", `${item.category} · ${item.applicableStage} · v${item.version} · ${learningStatusVi(item.validationStatus)}`), el("small", item.description));
      const report=item.latestValidation, metrics=report?.metrics;
      if (report) {
        const summary = metrics
          ? `TP ${metrics.TP} / FP ${metrics.FP} / TN ${metrics.TN} / FN ${metrics.FN} · P ${metricValue(metrics.precision)} · R ${metricValue(metrics.recall)} · F1 ${metricValue(metrics.f1)} · FPR ${metricValue(metrics.falsePositiveRate)} · abstain ${metricValue(metrics.abstentionRate)} · holdout ${report.independentMintCount ?? metrics.sampleCount}`
          : (report.qualityGate?.failures || []).join(", ") || "Đang chờ dữ liệu độc lập";
        row.append(el("small", `Kiểm định ${learningStatusVi(report.lifecycleState || item.validationStatus)} · ${summary}`));
      }
      if(item.controlReason)row.append(el("small",`${item.controlAction}: ${item.controlReason}`));
      const act=async(action,ask=true)=>{let reason="User intervention";if(ask){const supplied=window.prompt(`Lý do ${action} knowledge này?`);if(!supplied)return;reason=supplied;}if(action==="delete"&&!window.confirm("Xóa mềm knowledge này? Có thể khôi phục từ dashboard."))return;try{await ctx.post(`/api/chart-learning/knowledge/${encodeURIComponent(item.id)}/${action}`,{version:item.version,reason});data=await read("");renderHealth();renderKnowledge();}catch(error){ctx.error(error);}};
      const controls=document.createElement("div");controls.className="learning-case-actions";
      controls.append(button("Chi tiết",async()=>{try{const detail=await read(`/knowledge/${encodeURIComponent(item.id)}`),panel=document.createElement("pre");panel.className="learning-knowledge-detail";panel.textContent=JSON.stringify(detail,null,2);row.append(panel);}catch(error){ctx.error(error);}}));
      if(item.validationStatus!=="DELETED"){
        controls.append(button("Tắt",()=>act("disable")));
        controls.append(button("Từ chối",()=>act("reject")));
        controls.append(button("Xóa mềm",()=>act("delete")));
      }
      controls.append(button("Khôi phục",()=>act("restore")));
      list.append(row);row.append(controls);
    }
    if (!list.childElementCount) list.append(el("p", "Chưa có semantic knowledge."));
    const jobs=document.getElementById("validationJobList");
    if(jobs){jobs.replaceChildren();for(const item of data?.validationJobs||[]){let report=item.report;try{if(typeof report==="string")report=JSON.parse(report)}catch{report=null}const card=el("div",undefined,"learning-case-row");card.append(el("strong",`${item.knowledge_id} · v${item.knowledge_version}`),el("small",`${learningStatusVi(item.state)} · ${time(item.requested_at)} · lần thử ${item.attempt_count}`));if(item.error)card.append(el("small",`Lý do: ${learningErrorVi(item.error)}`));if(report?.metrics)card.append(el("small",`TP ${report.metrics.TP} · FP ${report.metrics.FP} · TN ${report.metrics.TN} · FN ${report.metrics.FN} · Precision ${metricValue(report.metrics.precision)} · Recall ${metricValue(report.metrics.recall)} · Specificity ${metricValue(report.metrics.specificity)} · FPR ${metricValue(report.metrics.falsePositiveRate)} · FNR ${metricValue(report.metrics.falseNegativeRate)} · F1 ${metricValue(report.metrics.f1)} · coverage ${metricValue(report.metrics.coverage)} · abstention ${metricValue(report.metrics.abstentionRate)}`));jobs.append(card);}if(!jobs.childElementCount)jobs.append(el("p","Chưa có holdout replay."));}
  }
  function renderEventList() {
    const list = document.getElementById("learningEventList"),
      events = data?.events || [],
      matching = events.filter((event) => {
        const query = eventSearch.trim().toLowerCase(),
          text = `${event.mint} ${event.kind}`.toLowerCase();
        if (query && !text.includes(query)) return false;
        if (eventFilter === "RUG_30" && event.kind !== "RUG_30") return false;
        if (eventFilter === "OTHER" && event.kind === "RUG_30") return false;
        if (eventFilter === "ANALYZED" && event.analysisState !== "COMPLETED") return false;
        if (eventFilter === "NOT_ANALYZED" && event.analysisState === "COMPLETED") return false;
        if (eventFilter === "RULE" && !data.rules.some((r) => r.supportingEventIds.includes(event.id) || r.contradictoryEventIds.includes(event.id))) return false;
        return true;
      });
    document.getElementById("learningEventCount").textContent = `${matching.length} / ${events.length}`;
    list.replaceChildren();
    const pageSize = 12,
      pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
    eventPage = Math.min(eventPage, pageCount - 1);
    for (const event of matching.slice(eventPage * pageSize, (eventPage + 1) * pageSize)) {
      const item = button("", () => void selectEvent(event.id));
      item.className = "learning-event-item" + (event.id === selectedEventId ? " is-selected" : "");
      item.setAttribute("role", "listitem");
      item.append(
        el("strong", shortMint(event.mint)),
        el("span", event.kind, event.kind === "RUG_30" ? "learning-rug-tag" : "learning-event-tag"),
        el("small", `${time(event.at)} · ${event.preEvent?.[0]?.count ?? 0} nến trước sự kiện`),
        el("small", event.analysisState === "COMPLETED" ? "Đã phân tích" : event.analysisState === "FAILED" ? "Phân tích lỗi" : event.analysisState === "RUNNING" ? "Đang phân tích" : "Chờ phân tích"),
        el("b", `${Number(event.dropPercent).toFixed(1)}%`, event.kind === "RUG_30" ? "negative" : ""),
      );
      list.append(item);
    }
    const pager = el("div", undefined, "learning-pager");
    pager.append(
      button("‹", () => { eventPage = Math.max(0, eventPage - 1); renderEventList(); }),
      el("span", `${eventPage + 1} / ${pageCount}`),
      button("›", () => { eventPage = Math.min(pageCount - 1, eventPage + 1); renderEventList(); }),
    );
    list.append(pager);
    for (const control of document.querySelectorAll("#learningEventFilters button"))
      control.classList.toggle("is-active", control.dataset.filter === eventFilter);
  }
  function renderSelectedEvent(record) {
    const event = record.event,
      chart = document.getElementById("learningChart"),
      selected = data.events.find((candidate) => candidate.id === event.id) || event,
      volume = document.getElementById("learningVolumeToggle").checked,
      markers = document.getElementById("learningMarkerToggle").checked,
      showRug = document.getElementById("learningRugToggle").checked,
      windowFrom = event.at - (chartWindow * 60000) / 2,
      windowTo = event.at + (chartWindow * 60000) / 2,
      visibleCandles = record.candles.filter((candle) => candle.at >= windowFrom && candle.at < windowTo);
    document.getElementById("learningChartTitle").textContent = `${shortMint(event.mint)} · ${event.kind}`;
    document.getElementById("learningChartMeta").textContent = `${time(event.at)} · cửa sổ ${chartWindow} phút · nến M1 hoàn tất`;
    document.getElementById("learningChartTag").textContent = `${visibleCandles.length} nến`;
    document.getElementById("learningCandleCount").textContent = `${visibleCandles.length} nến lưu trữ`;
    chart.replaceChildren(candleChart(
      visibleCandles,
      showRug && event.kind === "RUG_30" ? [{ ...event, label: "RUG_30" }] : [],
      () => {},
      { showVolume: volume, showMarkers: markers },
    ));
    const summary = document.getElementById("learningEventSummary");
    summary.replaceChildren(
      infoRow("Sự kiện", event.kind),
      infoRow("Token", shortMint(event.mint)),
      infoRow("Thời điểm", time(event.at)),
      infoRow("Open → Low", `${metricValue(event.candle?.open)} → ${metricValue(event.candle?.low)}`),
      infoRow("Mức giảm", `${Number(event.dropPercent).toFixed(2)}%`),
      infoRow("Định nghĩa", "(open - low) / open · nến M1 hoàn tất"),
    );
    for (const outcome of record.outcomes || [])
      summary.append(
        infoRow(
          `Quan sát sau ${outcome.horizon} phút`,
          `${metricValue(outcome.closeReturnPct, "%")} · hồi từ đáy ${metricValue(outcome.recoveryFromLowPct, "%")}`,
        ),
      );
    document.getElementById("learningInsightTag").textContent = event.kind;
    const signals = document.getElementById("learningSignals");
    signals.replaceChildren();
    for (const feature of event.preEvent || []) {
      const box = el("article", undefined, "learning-signal-window");
      box.append(el("strong", `${feature.window} phút trước sự kiện`));
      box.append(el("small", `${feature.count}/${feature.window} nến · độ phủ ${(feature.coverage * 100).toFixed(0)}% · đến ${time(event.at)}`));
      for (const [label, value, suffix] of [
        ["Biến động", feature.returnPct, "%"], ["Volume ratio", feature.volumeRatio, "×"],
        ["Volatility", feature.volatility, "%"], ["Drawdown", feature.drawdownPct, "%"],
      ]) if (value !== null && value !== undefined) box.append(infoRow(label, metricValue(value, suffix)));
      box.append(el("small", feature.behaviors?.length ? feature.behaviors.join(" · ") : "Chưa có pattern xác định"));
      signals.append(box);
    }
    if (!(event.preEvent || []).length) signals.append(el("p", "Không có feature trước sự kiện được lưu."));
    const rules = document.getElementById("learningRelatedRules");
    rules.replaceChildren();
    const related = data.rules.filter((rule) => rule.supportingEventIds.includes(event.id) || rule.contradictoryEventIds.includes(event.id));
    if (!related.length) rules.append(el("p", "Chưa có Learning Rule được tạo từ sự kiện này."));
    for (const rule of related) {
      const node = el("article", undefined, "learning-related-rule");
      node.append(el("strong", rule.name), el("span", `${learningStatusVi(rule.status)} · v${rule.version}`), el("small", `${rule.supportingEventIds.length} hỗ trợ · ${rule.contradictoryEventIds.length} mâu thuẫn`));
      rules.append(node);
    }
    const ai = document.getElementById("learningAiSummary"),
      meta = document.getElementById("learningAiMeta");
    if (selected.analysis) {
      ai.textContent = selected.analysis.reason || "Phân tích đã hoàn tất.";
      const evidence = ` · ${selected.analysis.supportingEventIds?.length ?? 0} bằng chứng hỗ trợ / ${selected.analysis.contradictoryEventIds?.length ?? 0} mâu thuẫn`;
      const hypothesis = selected.analysis.hypothesis?.name ? ` · Giả thuyết DRAFT: ${selected.analysis.hypothesis.name}` : "";
      meta.textContent = `${learningStatusVi(selected.analysisState)} · ${time(selected.analysisAt)} · ${selected.analysisRuntime?.lastModel || selected.analysisRuntime?.model || "Model không có trong bản ghi"} · độ bất định: ${selected.analysis.uncertainty || "N/A"}${evidence}${hypothesis}`;
    } else if (selected.analysisState === "PENDING" || selected.analysisState === "RUNNING") {
      ai.textContent = "Đang chờ Codex phân tích sự kiện này.";
      meta.textContent = selected.analysisState === "PENDING" ? "Job đang chờ trong hàng đợi Learning" : "Job đang được xử lý";
    } else if (selected.analysisError === "CODEX_HTTP_429") {
      ai.textContent = "OpenAI API trả về HTTP 429; dữ liệu hiện có không xác định được nguyên nhân quota hay giới hạn tốc độ.";
      meta.textContent = "Lỗi provider: CODEX_HTTP_429";
    } else if (selected.analysisState === "FAILED") {
      ai.textContent = "Phân tích chưa hoàn tất.";
      meta.textContent = learningErrorVi(selected.analysisError) || "Job thất bại · xem tab Jobs để biết chẩn đoán";
    } else {
      ai.textContent = "Chưa có phân tích AI cho sự kiện này.";
      meta.textContent = "Market evidence được lưu độc lập với trạng thái Codex.";
    }
  }
  function infoRow(label, value) {
    const row = el("div", undefined, "learning-info-row");
    row.append(el("span", label), el("strong", value));
    return row;
  }
  function renderJobs() {
    const rows = data.jobs || [],
      filter = document.getElementById("learningJobFilter")?.value || "ALL",
      wrap = el("div", undefined, "learning-jobs-wrap"),
      table = el("table");
    table.innerHTML = "<thead><tr><th>Job</th><th>Token / sự kiện</th><th>Trạng thái</th><th>Tạo lúc</th><th>Lần thử</th><th>Lỗi / lần thử tiếp</th></tr></thead>";
    const body = el("tbody");
    for (const job of rows.filter((item) => filter === "ALL" || item.state === filter)) {
      const tr = el("tr"),
        ref = job.case_id ? shortMint(job.case_id) : [job.referenceKind, job.mint ? shortMint(job.mint) : ""].filter(Boolean).join(" · ") || shortMint(job.id);
      for (const value of [job.kind || "CASE_ANALYSIS", ref, learningStatusVi(job.state), time(job.requested_at ?? job.at), String(job.retry_count ?? job.attempts ?? 0)]) tr.append(el("td", value));
      let result = job.result;
      try { if (typeof result === "string") result = JSON.parse(result); } catch { /* Keep text fallback. */ }
      const diagnostic = job.error
        ? learningErrorVi(job.error)
        : result?.reason || "—";
      tr.append(el("td", diagnostic));
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    root.replaceChildren(
    el("p", `Automatic Codex Learning · tối đa ${rows.length} job gần nhất.`, "learning-list-note"),
      el("label", "Lọc trạng thái "),
    );
    const select = document.createElement("select");
    select.id = "learningJobFilter";
    for (const [value, label] of [["ALL", "Tất cả"], ["PENDING", "Đang chờ"], ["RUNNING", "Đang chạy"], ["COMPLETED", "Hoàn tất"], ["FAILED", "Thất bại"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = filter;
    select.addEventListener("change", renderJobs);
    root.children[1].append(select);
    root.append(wrap);
  }
  function renderRules() {
    root.replaceChildren();
    if (!data.rules.length) {
      root.append(el("p", "Chưa có Learning Rule được lưu. Không có rule nào được kích hoạt tự động."));
      return;
    }
    for (const rule of data.rules) {
      const card = el("article", undefined, "learning-rule-card"),
        head = el("header"),
        title = el("div");
      title.append(el("strong", rule.name), el("small", `${rule.id} · v${rule.version}`));
      head.append(title, el("b", learningStatusVi(rule.status)));
      card.append(head,
        infoRow("Purpose", rule.action === "BLOCK" ? "BUY Guard · BLOCK" : "SELL"),
        infoRow("Observation window", `${rule.window} phút`),
        infoRow("Conditions", rule.behaviors.join(" · ") || "N/A"),
        infoRow("Evidence", `${rule.supportingEventIds.length} hỗ trợ · ${rule.contradictoryEventIds.length} mâu thuẫn`),
        infoRow("Invalidation", rule.invalidation || "N/A"),
        infoRow("Updated", time(rule.at)),
        button("Xem validation và evidence", () => void show("/rule", rule.id).catch(ctx.error)),
      );
      root.append(card);
    }
  }
  async function selectEvent(id) {
    selectedEventId = id;
    window.sessionStorage.setItem("chart-learning-event", id);
    renderEventList();
    const request = ++selectionRequest;
    try {
      const record = await read("/evidence", id);
      if (!ctx.active() || request !== selectionRequest || id !== selectedEventId) return;
      selectedEventData = record;
      renderSelectedEvent(record);
    } catch (error) { ctx.error(error); }
  }
  for (const [key, label] of [["ALL", "Tất cả"], ["RUG_30", "RUG_30"], ["OTHER", "Khác"], ["ANALYZED", "Đã phân tích"], ["NOT_ANALYZED", "Chưa phân tích"], ["RULE", "Có rule"]]) {
    const control = button(label, () => { eventFilter = key; window.sessionStorage.setItem("chart-learning-filter", key); eventPage = 0; renderEventList(); });
    control.dataset.filter = key;
    document.getElementById("learningEventFilters").append(control);
  }
  document.getElementById("learningEventSearch").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      eventSearch = event.target.value;
      window.sessionStorage.setItem("chart-learning-search", eventSearch);
      eventPage = 0;
      renderEventList();
    }, 180);
  });
  let searchTimer;
  document.getElementById("learningEventSearch").value = eventSearch;
  for (const id of ["learningVolumeToggle", "learningMarkerToggle", "learningRugToggle"])
    document.getElementById(id).addEventListener("change", () => {
      if (selectedEventData) renderSelectedEvent(selectedEventData);
    });
  for (const [minutes, label] of [[5, "5m"], [15, "15m"], [30, "30m"], [60, "1h"]]) {
    const control = button(label, () => {
      chartWindow = minutes;
      for (const candidate of document.querySelectorAll("#learningWindowControls button"))
        candidate.classList.toggle("is-active", candidate.dataset.minutes === String(minutes));
      if (selectedEventData) renderSelectedEvent(selectedEventData);
    });
    control.dataset.minutes = String(minutes);
    control.classList.toggle("is-active", minutes === chartWindow);
    document.getElementById("learningWindowControls").append(control);
  }
  const show = async (path, id) => {
    const record = await read(path, id);
    if (!ctx.active()) return;
    detail.replaceChildren(el("h3", path.slice(1) + " · " + id));
    const select = (m) => {
      if (m.snapshotId && m.id) void show("/decision", m.id).catch(ctx.error);
      else {
        const p = pretty(m);
        detail.append(p);
        p.scrollIntoView({ block: "nearest" });
      }
    };
    if (record.candles)
      detail.append(
        candleChart(record.candles, record.event ? [record.event] : [], select),
      );
    if (record.snapshot?.history?.candles)
      detail.append(
        candleChart(record.snapshot.history.candles, [record.decision], select),
      );
    if (record.replay) {
      const r = record.replay;
      detail.append(
        candleChart(
          r.candles,
          [
            ...r.markers,
            ...(record.decisions ?? []),
            ...(record.kronos ?? []).map((d) => ({
              ...d.payload,
              label: "KRONOS " + d.payload.action,
              at: d.payload.decisionAt,
            })),
            ...(record.events ?? []),
          ],
          select,
        ),
      );
      detail.append(
        el(
          "p",
          "Candidate execution classifications require contemporaneous routing evidence. Missing quotes remain INSUFFICIENT_DATA.",
        ),
      );
    }
    for (const e of record.evidence ?? [])
      detail.append(
        button(
          `${e.stance} · v${e.version} · ${e.event.kind} · ${e.event.id}`,
          () => void show("/evidence", e.event.id).catch(ctx.error),
        ),
      );
    for (const r of record.decision?.rules ?? []) {
      detail.append(
        button(
          r.name + " · " + r.id + " v" + r.version,
          () => void show("/rule", r.id).catch(ctx.error),
        ),
      );
      for (const id of [...r.supportingEventIds, ...r.contradictoryEventIds])
        detail.append(
          button(
            "Historical event " + id,
            () => void show("/evidence", id).catch(ctx.error),
          ),
        );
    }
    detail.append(pretty(record));
  };
  const render = () => {
    const workspace = document.getElementById("learningWorkspace"),
      isOverview = tab === "Overview";
    workspace.hidden = !isOverview;
    document.getElementById("learningMoreStats").hidden = !isOverview;
    document.getElementById("learningRows").hidden = isOverview;
    detail.hidden = isOverview;
    for (const tabButton of tabs.querySelectorAll("button"))
      tabButton.classList.toggle("is-active", tabButton.dataset.tab === tab);
    if (isOverview) {
      renderEventList();
      if (!data.events.length) {
        document.getElementById("learningChart").replaceChildren(el("p", "Chưa có nến sự kiện được lưu để hiển thị."));
        document.getElementById("learningChartTitle").textContent = "Đang chờ market observations";
        document.getElementById("learningChartMeta").textContent = "Nến chỉ xuất hiện sau khi collector lưu bằng chứng hoàn tất.";
        document.getElementById("learningAiSummary").textContent = "Chưa có sự kiện để Codex phân tích.";
        document.getElementById("learningEventSummary").replaceChildren(el("p", "Chưa có sự kiện thị trường được ghi nhận."));
        document.getElementById("learningSignals").replaceChildren(el("p", "Feature sẽ hiển thị khi có event."));
        document.getElementById("learningRelatedRules").replaceChildren(el("p", "Chưa có Learning Rule được tạo từ sự kiện này."));
      }
      return;
    }
    root.replaceChildren();
    let rows = [];
    if (tab === "Rules")
      rows = data.rules.map((r) => ({
        label: `${r.id} v${r.version} · ${r.name} · ${r.status} · Support ${r.supportingEventIds.length} / Contradict ${r.contradictoryEventIds.length}`,
        path: "/rule",
        id: r.id,
        at: r.at,
      }));
    if (tab === "Events")
      rows = data.events.map((e) => ({
        label: `${e.kind} · ${e.mint} · ${e.dropPercent.toFixed(2)}% open-to-low`,
        path: "/evidence",
        id: e.id,
        at: e.at,
      }));
    if (tab === "BLOCK History")
      rows = data.decisions
        .filter((d) => d.action === "BLOCK")
        .map((d) => ({
          label: `BLOCK · ${d.mint} · ${d.reason}`,
          path: "/decision",
          id: d.id,
          at: d.at,
        }));
    if (tab === "Decisions")
      rows = data.decisions.map((d) => ({
        label: `CODEX ${d.action} · ${d.mint} · ${d.reason}`,
        path: "/decision",
        id: d.id,
        at: d.at,
      }));
    if (tab === "SELL History")
      rows = [
        ...data.decisions
          .filter((d) => d.action === "SELL")
          .map((d) => ({
            label: `CODEX SELL · ${d.positionId} · ${d.reason}`,
            path: "/decision",
            id: d.id,
            at: d.at,
          })),
        ...(data.sells ?? []).map((e) => ({
          label: `${e.intent.decisionSource ?? "UNKNOWN"} SELL · ${e.intent.positionId} · ${e.state} · ${e.evidence?.simulated ? "SIMULATED" : "LIVE"} · Price ${e.accounting?.priceUsd ?? "UNKNOWN"}`,
          path: "/sell",
          id: e.id,
          at: e.at,
        })),
      ];
    if (tab === "Trade Replay")
      rows = data.replays.map((r) => ({
        label: `${r.mint} · ${r.mode} · Net ${r.accounting.netPnlLamports ?? "UNKNOWN"} lamports`,
        path: "/replay",
        id: r.positionId,
        at: r.entryAt,
      }));
    if (tab === "Timeline")
      rows = data.timeline.map((r) => ({
        label: `${r.id} v${r.version} · ${r.status} · ${r.name}`,
        path: "/rule",
        id: r.id,
        at: r.at,
      }));
    if (tab === "Jobs") {
      renderJobs();
      return;
    }
    if (tab === "Rules") {
      renderRules();
      return;
    }
    if (tab === "Replay Validation") {
      root.append(pretty(data.backtests ?? []));
      return;
    }
    if (!rows.length)
      root.append(
        el(
          "p",
          "No persisted records yet. The dashboard never generates sample trades or statistics.",
        ),
      );
    for (const r of rows) {
      const article = el("article", undefined, "learning-row");
      article.append(
        el("small", time(r.at)),
        button(r.label, () => void show(r.path, r.id).catch(ctx.error)),
      );
      root.append(article);
    }
  };
  const tabs = document.getElementById("learningTabs");
  for (const name of [
    "Overview",
    "Rules",
    "Events",
    "Trade Replay",
    "BLOCK History",
    "SELL History",
    "Decisions",
    "Timeline",
    "Auto Learning Jobs",
    "Replay Validation",
  ])
    {
      const tabButton = button(name, () => {
        tab = name;
        render();
      });
      tabButton.dataset.tab = name;
      tabs.append(tabButton);
    }
  await ctx.poll(async () => {
    data = await read("");
    if (!ctx.active()) return;
    if (tab === "Auto Learning Jobs") data.jobs = await read("/auto-learning-jobs");
    renderHealth();
    renderCaseList();
    renderKnowledge();
    const o = data.overview,
      a = data.analysisStatus || {},
      overview = document.getElementById("learningOverview");
    overview.replaceChildren();
    const cards = {
      "Market Events": o.marketEvents,
      RUG_30: o.rug30,
      Candles: o.candleCount,
      "Ready cases": a.ready ?? 0,
      "Analyzed cases": a.analyzed ?? 0,
      "Analysis pending": a.pending ?? 0,
      "Analysis running": a.running ?? 0,
      "Analysis failed": a.failed ?? 0,
      "Validated rules": o.validatedRules,
    };
    for (const [name, count] of Object.entries(cards)) {
      const card = el("div", undefined, "learning-stat");
      card.append(el("small", name), el("strong", count));
      overview.append(card);
    }
    const secondary = document.getElementById("learningSecondaryStats");
    secondary.replaceChildren();
    for (const [name, count] of Object.entries({
      "Chart windows": o.chartWindows ?? "N/A",
      "Incomplete cases": a.incomplete ?? 0,
      "Rejected rules": o.rejectedRules ?? 0,
      "Retired rules": o.retiredRules ?? 0,
      "PASS decisions": o.decisions.PASS,
      "BLOCK decisions": o.decisions.BLOCK,
      "SELL decisions": o.decisions.SELL,
      "Decision errors": o.decisions.ERROR,
      "Trades analyzed": o.tradesAnalyzed,
    })) secondary.append(infoRow(name, count));
    const prevState = data.events.find((event) => event.id === selectedEventId)?.analysisState ?? "";
    if (!selectedEventId || !data.events.some((event) => event.id === selectedEventId)) {
      selectedEventId = data.events[0]?.id || "";
      selectedEventData = undefined;
    }
    render();
    const nextState = data.events.find((event) => event.id === selectedEventId)?.analysisState ?? "";
    if (selectedEventId && (prevState !== nextState || !selectedEventData)) void selectEvent(selectedEventId);
  }, 15000);
  const params = new URLSearchParams(location.search);
  for (const kind of ["rule", "decision", "evidence", "replay"])
    if (params.has(kind)) await show("/" + kind, params.get(kind));
}
