const node = (tag, text, cls) => {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = String(text);
  if (cls) value.className = cls;
  return value;
};
const shortMint = (mint) => mint && mint.length > 18 ? `${mint.slice(0, 7)}…${mint.slice(-6)}` : mint || "Token";
const time = (at) => Number.isFinite(Number(at)) ? new Date(Number(at)).toLocaleString("vi-VN") : "Không rõ";
const moneyPct = (value) => value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
const learningStatusVi = (status) => ({ DRAFT: "Bản nháp", OBSERVING: "Đang theo dõi", VALIDATING: "Đang kiểm định", VALIDATED: "Đã hợp lệ", REJECTED: "Bị từ chối", RETIRED: "Đã ngừng dùng", PENDING: "Đang chờ", RUNNING: "Đang chạy", RETRY_WAIT: "Chờ thử lại", COMPLETED: "Hoàn tất", DEAD_LETTER: "Đã dừng vì lỗi", FAILED: "Thất bại", ANALYZED: "Đã phân tích", ANALYZED_NO_HYPOTHESIS: "Đã phân tích, chưa có giả thuyết", ANALYZING: "Đang phân tích", QUEUED: "Đang chờ xử lý", WAITING_FOR_DATA: "Chờ dữ liệu" }[status] || status || "Chưa có trạng thái");
const learningErrorVi = (error) => String(error || "").startsWith("CODEX_HTTP_429") ? `OpenAI giới hạn tốc độ gọi; hệ thống chờ cooldown rồi thử lại · ${error}` : String(error || "").startsWith("CODEX_INPUT_TOO_LARGE") ? "Dữ liệu gửi phân tích vượt giới hạn cho phép." : error || "Không có chi tiết lỗi.";

function chartSvg(candles, fills = [], compact = false) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", compact ? "0 0 360 100" : "0 0 1000 400");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Nến M1 đã lưu cùng mốc khớp lệnh thực tế");
  if (!candles?.length) {
    const message = document.createElementNS(svg.namespaceURI, "text");
    message.setAttribute("x", "12"); message.setAttribute("y", "50");
    message.textContent = "Không có nến M1 đã lưu cho giao dịch này";
    svg.append(message);
    return svg;
  }
  const width = compact ? 360 : 1000, height = compact ? 100 : 400;
  const left = compact ? 4 : 54, right = compact ? 356 : 980;
  const chartTop = compact ? 8 : 24, chartBottom = compact ? 92 : 330;
  const low = Math.min(...candles.map((c) => Number(c.low))), high = Math.max(...candles.map((c) => Number(c.high)));
  const range = high - low || Math.abs(high) * .01 || 1;
  const x = (i) => left + ((i + .5) * (right - left)) / candles.length;
  const y = (price) => chartTop + ((high - Number(price)) / range) * (chartBottom - chartTop);
  const maxVolume = Math.max(1, ...candles.map((c) => Number(c.volumeUsd) || 0));
  const candleWidth = Math.max(compact ? .8 : 2, ((right - left) / candles.length) * .58);
  candles.forEach((candle, index) => {
    const up = Number(candle.close) >= Number(candle.open), color = up ? "#16833b" : "#df2631";
    const wick = document.createElementNS(svg.namespaceURI, "line");
    wick.setAttribute("x1", x(index)); wick.setAttribute("x2", x(index)); wick.setAttribute("y1", y(candle.high)); wick.setAttribute("y2", y(candle.low)); wick.setAttribute("stroke", color); svg.append(wick);
    const body = document.createElementNS(svg.namespaceURI, "rect");
    body.setAttribute("x", x(index) - candleWidth / 2); body.setAttribute("y", y(Math.max(candle.open, candle.close)));
    body.setAttribute("width", candleWidth); body.setAttribute("height", Math.max(1, Math.abs(y(candle.open) - y(candle.close))));
    body.setAttribute("fill", color); svg.append(body);
    if (!compact && candle.volumeUsd != null) {
      const volume = document.createElementNS(svg.namespaceURI, "rect");
      volume.setAttribute("x", x(index) - candleWidth / 2); volume.setAttribute("y", 390 - (Number(candle.volumeUsd) / maxVolume) * 48);
      volume.setAttribute("width", candleWidth); volume.setAttribute("height", (Number(candle.volumeUsd) / maxVolume) * 48);
      volume.setAttribute("fill", color); volume.setAttribute("opacity", ".32"); svg.append(volume);
    }
    if (!compact) {
      const title = document.createElementNS(svg.namespaceURI, "title");
      title.textContent = `${time(candle.at)} · O ${candle.open} H ${candle.high} L ${candle.low} C ${candle.close} · Volume USD ${candle.volumeUsd ?? "không có"}`;
      body.append(title);
    }
  });
  for (const fill of fills) {
    const index = candles.findIndex((c) => Number(fill.at) >= Number(c.at) && Number(fill.at) < Number(c.at) + 60000);
    if (index < 0) continue;
    const marker = document.createElementNS(svg.namespaceURI, "circle");
    marker.setAttribute("cx", x(index)); marker.setAttribute("cy", compact ? (fill.side === "BUY" ? 20 : 80) : (fill.side === "BUY" ? 35 : 350));
    marker.setAttribute("r", compact ? 5 : 8); marker.setAttribute("fill", fill.side === "BUY" ? "#008b37" : "#e21d2b");
    const title = document.createElementNS(svg.namespaceURI, "title");
    title.textContent = `${fill.side} · ${time(fill.at)} · Giá khớp ${fill.price ?? "không có"} · SL ${fill.quantity ?? "không có"}`;
    marker.append(title); svg.append(marker);
    if (!compact) {
      const text = document.createElementNS(svg.namespaceURI, "text");
      text.setAttribute("x", x(index)); text.setAttribute("y", compact ? 22 : (fill.side === "BUY" ? 38 : 353));
      text.setAttribute("text-anchor", "middle"); text.setAttribute("fill", "#fff"); text.setAttribute("font-size", "10"); text.setAttribute("font-weight", "700"); text.textContent = fill.side === "BUY" ? "B" : "S"; svg.append(text);
    }
  }
  if (!compact) {
    const crossV = document.createElementNS(svg.namespaceURI, "line"),
      crossH = document.createElementNS(svg.namespaceURI, "line");
    for (const line of [crossV, crossH]) {
      line.setAttribute("stroke", "#8b7565"); line.setAttribute("stroke-dasharray", "4 4");
      line.setAttribute("opacity", "0"); line.setAttribute("pointer-events", "none"); svg.append(line);
    }
    crossV.setAttribute("y1", chartTop); crossV.setAttribute("y2", chartBottom);
    crossH.setAttribute("x1", left); crossH.setAttribute("x2", right);
    svg.addEventListener("pointermove", (event) => {
      const rect = svg.getBoundingClientRect(), px = ((event.clientX - rect.left) / rect.width) * width,
        py = ((event.clientY - rect.top) / rect.height) * height;
      crossV.setAttribute("x1", px); crossV.setAttribute("x2", px); crossV.setAttribute("opacity", "0.75");
      crossH.setAttribute("y1", py); crossH.setAttribute("y2", py); crossH.setAttribute("opacity", "0.75");
      const index = Math.max(0, Math.min(candles.length - 1, Math.round(((px - left) / (right - left)) * candles.length - .5)));
      const candle = candles[index];
      if (candle) svg.setAttribute("aria-label", `${time(candle.at)} · O ${candle.open} H ${candle.high} L ${candle.low} C ${candle.close} · Volume USD ${candle.volumeUsd ?? "không có"}`);
    });
    svg.addEventListener("pointerleave", () => { crossV.setAttribute("opacity", "0"); crossH.setAttribute("opacity", "0"); });
    const axis = document.createElementNS(svg.namespaceURI, "text");
    axis.setAttribute("x", left); axis.setAttribute("y", 398); axis.setAttribute("fill", "#705344"); axis.setAttribute("font-size", "11");
    axis.textContent = time(candles[0].at); svg.append(axis);
    const endLabel = document.createElementNS(svg.namespaceURI, "text");
    endLabel.setAttribute("x", right); endLabel.setAttribute("y", 398); endLabel.setAttribute("text-anchor", "end"); endLabel.setAttribute("fill", "#705344"); endLabel.setAttribute("font-size", "11");
    endLabel.textContent = time(candles.at(-1).at); svg.append(endLabel);
  }
  return svg;
}

export async function mount(ctx) {
  const gallery = document.getElementById("learningGallery"), modal = document.getElementById("experienceModal");
  const patternSelect = document.getElementById("galleryPattern"), daysSelect = document.getElementById("galleryDays");
  let page = 1, outcome = "ALL", pending = false;
  const fetchGallery = async () => {
    if (pending) return;
    pending = true;
    document.getElementById("galleryStatus").textContent = "Đang tải giao dịch…";
    const query = new URLSearchParams({ page: String(page), limit: "24", pattern: patternSelect.value, outcome, days: daysSelect.value });
    try {
      const result = await ctx.get(`/api/chart-learning/experiences?${query}`);
      gallery.replaceChildren();
      for (const item of result.items) {
        const card = node("button", undefined, "experience-card"); card.type = "button";
        card.setAttribute("aria-label", `Mở replay ${item.tokenName || shortMint(item.mint)}, ${item.pattern}, ${moneyPct(item.pnlPct)}`);
        const title = node("span", item.tokenName || shortMint(item.mint), "experience-token");
        const chart = node("span", undefined, "experience-thumb"); chart.append(chartSvg(item.candles, item.fills, true));
        const footer = node("span", undefined, "experience-card-footer");
        const badges = node("span", undefined, "experience-badges");
        badges.append(node("span", item.pattern, `pattern-chip pattern-${item.pattern.toLowerCase().replaceAll("_", "-")}`));
        badges.append(node("span", learningStatusVi(item.analysisStatus), `learning-status status-${item.analysisStatus.toLowerCase().replaceAll("_", "-")}`));
        footer.append(badges);
        footer.append(node("span", moneyPct(item.pnlPct), `experience-pnl ${Number(item.pnlPct) >= 0 ? "positive" : "negative"}`));
        card.append(title, chart, footer);
        card.addEventListener("click", () => openExperience(item.caseId));
        gallery.append(card);
      }
      const pages = document.getElementById("galleryPagination"); pages.replaceChildren();
      if (result.pages > 1) {
        const previous = node("button", "‹ Trước"); previous.type = "button"; previous.disabled = result.page <= 1;
        previous.addEventListener("click", () => { page--; fetchGallery(); });
        const next = node("button", "Sau ›"); next.type = "button"; next.disabled = result.page >= result.pages;
        next.addEventListener("click", () => { page++; fetchGallery(); });
        pages.append(previous, node("span", `${result.page} / ${result.pages}`), next);
      }
      const available = new Set(result.patterns), selectedPattern = patternSelect.value;
      for (const option of [...patternSelect.options].slice(1)) option.remove();
      for (const name of [...available].sort()) patternSelect.add(new Option(name, name));
      patternSelect.value = selectedPattern;
      document.getElementById("galleryStatus").textContent = result.total ? `${result.total.toLocaleString("vi-VN")} giao dịch · trang ${result.page}/${result.pages}` : "Chưa có giao dịch đã đóng phù hợp. Case thiếu dữ liệu vẫn được giữ trong hệ thống learning.";
    } catch (error) {
      gallery.replaceChildren(); document.getElementById("galleryStatus").textContent = `Không tải được Chart Learning: ${error.message || "lỗi kết nối"}`;
    } finally { pending = false; }
  };
  const openExperience = async (caseId) => {
    const detail = document.getElementById("experienceDetail"); detail.replaceChildren(node("p", "Đang tải replay…")); modal.showModal();
    try {
      const result = await ctx.get(`/api/chart-learning/experiences/${encodeURIComponent(caseId)}`);
      if (result.error) throw new Error("Không tìm thấy giao dịch.");
      renderDetail(detail, result, ctx, () => openExperience(caseId));
    } catch (error) { detail.replaceChildren(node("p", error.message || "Không tải được replay.")); }
  };
  patternSelect.addEventListener("change", () => { page = 1; fetchGallery(); });
  daysSelect.addEventListener("change", () => { page = 1; fetchGallery(); });
  document.querySelectorAll(".gallery-outcome button").forEach((button) => button.addEventListener("click", () => {
    outcome = button.dataset.outcome; page = 1;
    document.querySelectorAll(".gallery-outcome button").forEach((entry) => entry.setAttribute("aria-pressed", String(entry === button)));
    fetchGallery();
  }));
  document.getElementById("experienceClose").addEventListener("click", () => modal.close());
  modal.addEventListener("click", (event) => { if (event.target === modal) modal.close(); });
  await fetchGallery();
  try {
    const d = await ctx.get("/api/chart-learning/diagnostics");
    const labels = [["Giao dịch đóng", d.closedTrades], ["Case learning", d.learningCases], ["Đã phân tích", d.analyzed], ["Rule nháp", d.drafts], ["Rule hợp lệ", d.validated], ["Thiếu dữ liệu", d.incomplete], ["Job lỗi", d.failedJobs], ["Chờ validation", d.pendingValidation]];
    const box = document.getElementById("chartDiagnostics"); box.replaceChildren();
    for (const [label, value] of labels) { const row = node("p"); row.append(node("span", `${label}: `), node("strong", value)); box.append(row); }
  } catch { document.getElementById("chartDiagnostics").textContent = "Không tải được số liệu learning."; }
}

function renderDetail(root, data, ctx, refresh) {
  const { experience: item, candles, executions, analysis } = data;
  const head = node("header", undefined, "experience-detail-header");
  head.append(node("p", item.payload.tokenSymbol || shortMint(item.mint), "eyebrow"));
  head.append(node("h2", item.payload.tokenName || item.payload.tokenSymbol || shortMint(item.mint)));
  head.append(node("p", item.mint, "experience-mint"));
  const duration = item.closedAt ? Math.max(0, Math.round((Number(item.closedAt) - Number(item.entryAt)) / 60000)) : null;
  head.append(node("p", `${item.mode.toUpperCase()} · ${learningStatusVi(item.learningStatus)} · ${item.dataQuality} · ${learningStatusVi(item.analysisStatus)} · ${moneyPct(item.pnlPct)} · ${duration === null ? "thời lượng chưa rõ" : `${duration} phút`}`));
  if (item.analysisError) head.append(node("p", `Lỗi learning: ${learningErrorVi(item.analysisError)}`, "analysis-error"));
  head.append(node("p", `Pattern: ${experiencePatternLabel(item, data)}`));
  const patternEvidence = item.pattern?.evidence ?? [];
  if (patternEvidence.length) head.append(node("p", `Bằng chứng pattern: ${patternEvidence.map((entry) => `${entry.metric}=${entry.value} (${entry.threshold})`).join(" · ")}`));
  root.replaceChildren(head);
  const replayControls = node("div", undefined, "replay-tabs");
  const chartHolder = node("div", undefined, "experience-detail-chart"); root.append(replayControls, chartHolder);
  const tabs = [["ALL", "Toàn bộ"], ["BUY", "Tại BUY"], ["SELL", "Tại SELL"]];
  const show = (scope) => {
    const cutoff = scope === "BUY" ? item.entryAt : scope === "SELL" ? (executions.filter((e) => e.side === "SELL").at(-1)?.at ?? item.closedAt) : Infinity;
    const visible = candles.filter((c) => scope === "ALL" || Number(c.at) + 60000 <= Number(cutoff));
    const marks = executions.filter((fill) => scope === "ALL" || (scope === "BUY" ? fill.side === "BUY" : fill.side === "SELL" && Number(fill.at) <= Number(cutoff)));
    chartHolder.replaceChildren(chartSvg(visible, marks));
    for (const mark of marks) {
      const row = node("p", `${mark.side} · ${time(mark.at)} · Giá ${mark.price ?? "không có"} · SL ${mark.quantity ?? "không có"} · phí ${mark.fee ?? "không có"}`, `execution-line ${mark.side.toLowerCase()}`);
      chartHolder.append(row);
    }
  };
  for (const [scope, label] of tabs) {
    const button = node("button", label); button.type = "button";
    button.addEventListener("click", () => { replayControls.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button))); show(scope); });
    button.setAttribute("aria-pressed", String(scope === "ALL")); replayControls.append(button);
  }
  show("ALL");
  const report = node("section", undefined, "experience-report"); report.append(node("h3", "Báo cáo trải nghiệm AI"));
  const buy = analysis?.experienceReport?.buy?.decisionTime ?? analysis?.buyReview ?? analysis?.buyAnalysis;
  const sells = analysis?.experienceReport?.sells ?? [];
  const sell = analysis?.experienceReport?.sell?.decisionTime ?? analysis?.sellReview ?? analysis?.sellAnalysis;
  for (const [title, review] of [["BUY Analysis", buy], ["SELL Analysis", sells.length ? sells.map((row) => row.decisionTime) : sell]]) {
    const section = node("section"); section.append(node("h4", title));
    if (review) {
      const reviews = Array.isArray(review) ? review : [review];
      for (const entry of reviews.filter(Boolean)) {
        section.append(node("p", `${entry.conclusion ?? "Review"} · ${entry.candidateLesson ?? entry.reason ?? ""}`));
        if (entry.evidence?.length) section.append(node("p", `Evidence: ${entry.evidence.map((ev) => `${ev.evidenceId}: ${ev.observation}`).join(" · ")}`));
        if (entry.uncertainty) section.append(node("p", `Uncertainty: ${entry.uncertainty}`));
      }
    }
    else section.append(node("p", "Pipeline hiện chưa lưu review riêng cho quyết định này; không suy diễn chất lượng chỉ từ PnL."));
    report.append(section);
  }
  if (analysis) {
    report.append(node("h4", "Phân tích case hiện có"));
    report.append(node("p", analysis.reason || analysis.uncertainty || "Đã phân tích; chưa có nội dung BUY/SELL tách biệt."));
    if (analysis.hypothesis) report.append(node("p", `Giả thuyết: ${analysis.hypothesis.name} · ${analysis.hypothesis.action} · ${analysis.hypothesis.description}`));
    if (analysis.inputMetrics) report.append(node("p", `Input trước tối ưu: ${analysis.inputMetrics.originalBytes} bytes (~${analysis.inputMetrics.originalEstimatedTokens} tokens); mỗi stage tối đa ${Math.max(0, ...Object.values(analysis.inputMetrics.optimizedStages ?? {}).map((value) => value.bytes ?? 0))} bytes.`));
  } else report.append(node("p", `Chưa có phân tích: ${data.missingReason || "đang chờ xử lý"}.`));
  report.append(node("p", `Nến lưu: ${candles.length} · executions xác nhận: ${executions.length}.`));
  root.append(report);
  const knowledge = node("section", undefined, "experience-report"); knowledge.append(node("h3", "Knowledge liên quan"));
  if (!data.knowledge?.length && !data.rules?.length) knowledge.append(node("p", "Chưa có rule hoặc giả thuyết liên kết với case này."));
  for (const rule of data.rules ?? []) knowledge.append(node("p", `${learningStatusVi(rule.status)} · ${rule.name} · ${rule.action}`));
  for (const item of data.knowledge ?? []) {
    const block = node("article", undefined, "related-knowledge");
    block.append(node("h4", `${learningStatusVi(item.validationStatus)} · ${item.applicableStage} · ${item.title}`));
    block.append(node("p", item.description));
    const evidence = node("p", `Hỗ trợ: ${item.supportingCaseIds.length} · Mâu thuẫn: ${item.contradictoryCaseIds.length}${item.latestValidation?.lifecycleState ? ` · Validation: ${item.latestValidation.lifecycleState}` : ""}`);
    block.append(evidence);
    const current = item.validationStatus;
    const actions = current === "VALIDATED" ? [["disable", "Tắt rule"], ["reject", "Từ chối"], ["delete", "Xóa mềm"]]
      : ["DISABLED", "DELETED", "REJECTED"].includes(current) ? [["restore", "Khôi phục"]]
        : [["reject", "Từ chối"], ["delete", "Xóa mềm"]];
    for (const [action, label] of actions) {
      const button = node("button", label); button.type = "button";
      button.addEventListener("click", async () => {
        const reason = window.prompt(`Lý do ${label.toLowerCase()}:`, "Operator dashboard action");
        if (!reason?.trim()) return;
        button.disabled = true;
        try {
          await ctx.post(`/api/chart-learning/knowledge/${encodeURIComponent(item.id)}/${action}`, { version: item.version, reason });
          await refresh();
        } catch (error) { button.disabled = false; button.title = error.message || "Không cập nhật được knowledge"; }
      });
      block.append(button);
    }
    knowledge.append(block);
  }
  root.append(knowledge);
}

function experiencePatternLabel(item, data) {
  return typeof item.pattern === "string" ? item.pattern : item.pattern?.label ?? data.experience.pattern ?? data.analysis?.pattern ?? "UNKNOWN";
}
