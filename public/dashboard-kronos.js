// Read-only KRONOS call and candidate outcome dashboard.
const fmt = (n) => Number.isSafeInteger(n) ? n.toLocaleString("vi-VN") : "—";
const pct = (n, d) => Number.isSafeInteger(n) && d > 0 ? (100 * n / d).toFixed(1) + "%" : "—";

export async function mount(ctx) {
  const $ = (id) => document.getElementById(id);
  const range = $("kronosRange"), summary = $("kronosSummary"), breakdown = $("kronosBreakdown");
  const feedback = $("kronosFeedback");
  let generation = 0;
  const node = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = String(text);
    if (cls) el.className = cls;
    return el;
  };
  function metric(title, value, note, tone = "") {
    const card = node("article", undefined, "stats-card stats-kpi kronos-metric");
    if (tone) card.dataset.tone = tone;
    card.append(node("h3", title), node("strong", fmt(value), "stats-kpi-value"), node("p", note));
    return card;
  }
  function row(title, value, note) {
    const el = node("div", undefined, "stats-row");
    el.append(node("span", title, "stats-label"), node("strong", fmt(value)));
    if (note) el.title = note;
    return el;
  }
  function card(title, rows) {
    const el = node("article", undefined, "stats-card");
    el.append(node("h3", title));
    for (const item of rows) el.append(row(item[0], item[1], item[2]));
    return el;
  }
  function render(data) {
    const c = data.calls, d = data.decisions, b = data.buyOutcomes;
    summary.replaceChildren(
      metric("Tổng lượt đánh giá", c.total, `${fmt(c.entry)} entry · ${fmt(c.position)} khi đang giữ`),
      metric("Đồng ý BUY", d.buy, `Tỷ lệ ${pct(d.buy, c.entry)} trên lượt đánh giá entry`, "positive"),
      metric("WAIT / từ chối", d.wait, "KRONOS không chấp thuận BUY", "warning"),
      metric("Lỗi suy luận", d.errors, "Lỗi worker/inference được ghi nhận", d.errors ? "negative" : ""),
      metric("BUY đã khớp", b.bought, `Trong ${fmt(b.attempts)} attempt KRONOS BUY còn lưu`, "positive"),
    );
    summary.setAttribute("aria-busy", "false");
    breakdown.replaceChildren(
      card("Quyết định của KRONOS", [
        ["BUY", d.buy], ["WAIT", d.wait], ["HOLD", d.hold], ["SELL", d.sell], ["Inference error", d.errors],
        ["Chưa có kết quả ghi nhận", c.withoutRecordedOutcome, "Chênh lệch giữa số lần bắt đầu đánh giá và decision/error đã ghi; có thể gồm lượt bị ngắt hoặc thiếu log."],
      ]),
      card("Kết quả sau khi KRONOS đồng ý BUY", [
        ["Đã mua / confirmed", b.bought], ["Bị reject sau BUY", b.rejectedAfterBuy],
        ["Đang reconcile", b.reconciling], ["Đang xử lý", b.running],
        ["Attempt còn lưu", b.retainedCandidateAttempts, `Giữ tối đa ${fmt(b.retentionLimit)} attempt đã kết thúc; có thể cộng thêm attempt đang chạy.`],
      ]),
    );
    $("kronosScope").textContent = `Chế độ ${String(data.mode).toUpperCase()} · ${data.range === "all" ? "toàn bộ dữ liệu còn lưu" : data.range === "24h" ? "24 giờ gần nhất" : "7 ngày gần nhất"}. Lượt đánh giá đếm các lần bắt đầu kiểm tra entry và position; BUY là quyết định của KRONOS, không đồng nghĩa giao dịch đã khớp.`;
    const body = $("kronosRecent");
    body.replaceChildren();
    for (const item of data.latest) {
      const tr = document.createElement("tr");
      tr.append(node("td", new Date(item.at).toLocaleString("vi-VN")), node("td", item.symbol), node("td", item.action), node("td", item.reason || "—"));
      body.append(tr);
    }
    if (!data.latest.length) {
      const tr = document.createElement("tr"), td = node("td", "Chưa có quyết định KRONOS trong khoảng thời gian này.");
      td.colSpan = 4;
      tr.append(td);
      body.append(tr);
    }
  }
  const refresh = async () => {
    const request = ++generation;
    try {
      const data = await ctx.get(`/api/kronos/management?range=${encodeURIComponent(range.value)}`, "kronos-management");
      if (!ctx.active() || request !== generation) return;
      render(data);
      feedback.textContent = "Cập nhật " + new Date(data.updatedAt).toLocaleTimeString("vi-VN");
    } catch (error) {
      if (!ctx.active() || request !== generation || error.name === "AbortError") return;
      summary.replaceChildren(node("p", "Không thể tải thống kê KRONOS. Thử lại sau.", "stats-error"));
      summary.setAttribute("aria-busy", "false");
      breakdown.replaceChildren();
      feedback.textContent = "";
    }
  };
  range.onchange = () => void refresh();
  ctx.setRefresh(refresh);
  ctx.onDispose(() => { generation++; });
  await ctx.poll(refresh, 5000);
}
