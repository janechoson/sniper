/* Isolated PAPER UI; only calls dedicated Lab relay endpoints. */
(() => {
  const $ = (id) => document.getElementById(id),
    panel = $("kronos");
  if (!panel) return;
  let state = {},
    loading = false;
  const expanded = new Set();
  const node = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  };
  const number = (v, d = 2) =>
    Number.isFinite(v)
      ? v.toLocaleString("en-US", { maximumFractionDigits: d })
      : "—";
  const pct = (v) =>
    Number.isFinite(v) ? (v > 0 ? "+" : "") + number(v) + "%" : "—";
  const price = (p) => (p ? number(p.value, 12) : "—");
  const when = (p) =>
    p ? new Date(p.observedAt).toLocaleString("vi-VN") : "—";
  const duration = (ms) =>
    Number.isFinite(ms)
      ? Math.floor(ms / 60000) + "m " + (Math.floor(ms / 1000) % 60) + "s"
      : "—";
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
  function render(s) {
    state = s;
    const summary = s.summary ?? {};
    $("kronosStatus").textContent =
      s.error === "KRONOS_LAB_OFFLINE"
        ? "Lab offline · production độc lập"
        : s.enabled
          ? "PAPER collection đang chạy"
          : s.active
            ? "Đang hoàn tất tác vụ PAPER"
            : "PAPER collection tạm dừng";
    $("kronosEnable").disabled = !s.summary || s.enabled;
    $("kronosPause").disabled = !s.summary || !s.enabled;
    $("kronosReset").disabled = !s.summary || s.enabled || s.active;
    const cards = [
      [
        "Records",
        number(summary.records, 0) + " / " + number(summary.limit, 0),
      ],
      ["Paper Buys", number(summary.paperBuys, 0)],
      ["Open", number(summary.open, 0)],
      ["Closed", number(summary.closed, 0)],
      ["Wins", number(summary.wins, 0)],
      ["Losses", number(summary.losses, 0)],
      [
        "Win Rate",
        summary.winRate == null ? "—" : number(summary.winRate * 100) + "%",
      ],
      ["Average PnL", pct(summary.averagePnlPct)],
      ["Total Paper PnL", pct(summary.totalPaperPnlPct)],
      ["Median PnL", pct(summary.medianPnlPct)],
      [
        "Avg MFE / MAE",
        pct(summary.averageMfePct) + " / " + pct(summary.averageMaePct),
      ],
      ["Avg Hold", duration(summary.averageHoldMs)],
    ];
    $("kronosSummary").replaceChildren(
      ...cards.map(([label, value]) => {
        const c = node("div", undefined, "kronos-stat");
        c.append(node("small", label), node("strong", value));
        return c;
      }),
    );
    const m = s.inference ?? {};
    $("kronosMetrics").textContent =
      `Queue ${number(s.queueDepth, 0)} · Inference concurrency ${number(s.concurrency, 0)} · Load ${number(m.loadMs)}ms · RAM ${Number.isFinite(m.rssBytes) ? number(m.rssBytes / 1048576) : "—"}MB · p50 ${number(m.p50Ms)}ms · p95 ${number(m.p95Ms)}ms · Timeouts ${number(m.timeouts, 0)}. Total = tổng return các trade đóng với notional bằng nhau, không compounded; win rate gồm flat.`;
    const records = s.records ?? [];
    window.BOTTokenAvatar?.remember(records);
    $("kronosEmpty").hidden = !!records.length;
    $("kronosRows").replaceChildren(
      ...records.flatMap((t) => {
        const row = node("tr"),
          identity = node("td");
        const identityText = node("div");
        identityText.append(
          node("b", t.symbol || "Unknown Token"),
          node("small", t.name || "Unknown Token"),
          node("small", t.mint.slice(0, 6) + "…" + t.mint.slice(-4)),
        );
        const identityWrap = node("div", undefined, "kronos-token-identity");
        if (window.BOTTokenAvatar)
          identityWrap.append(
            window.BOTTokenAvatar.create(t, "token-avatar kronos-avatar"),
          );
        identityWrap.append(identityText);
        identity.append(identityWrap);
        row.append(identity);
        const fields = [
          t.status === "OPEN"
            ? "PAPER OPEN"
            : t.status === "CLOSED"
              ? "PAPER SOLD"
              : t.status,
          t.gates.SECURITY?.status ?? "—",
          t.latest?.action ?? "—",
          price(t.entry),
          price(t.exit ?? t.current) +
            (t.priceStale && !t.exit ? " · STALE" : ""),
          pct(t.exit ? t.pnlPct : t.currentPnlPct),
          pct(t.mfePct),
          pct(t.maePct),
          when(t.entry),
          when(t.exit),
          t.entry
            ? duration((t.exit?.observedAt ?? Date.now()) - t.entry.observedAt)
            : "—",
        ];
        fields.forEach((x) => row.append(node("td", x)));
        const td = node("td"),
          toggle = node("button", expanded.has(t.id) ? "Thu gọn" : "Chi tiết");
        td.append(toggle);
        row.append(td);
        const detailRow = node("tr"),
          detailCell = node("td");
        detailCell.colSpan = 13;
        detailRow.hidden = !expanded.has(t.id);
        const pre = node("pre", JSON.stringify(t, null, 2));
        detailCell.append(chart(t.latest), pre);
        detailRow.append(detailCell);
        toggle.onclick = async () => {
          if (expanded.has(t.id)) expanded.delete(t.id);
          else expanded.add(t.id);
          detailRow.hidden = !expanded.has(t.id);
          toggle.textContent = detailRow.hidden ? "Chi tiết" : "Thu gọn";
          if (!detailRow.hidden) {
            try {
              const data = await control({ action: "detail", id: t.id });
              pre.textContent = JSON.stringify(
                { record: t, decisionsLatest50: data.decisions },
                null,
                2,
              );
            } catch {
              /* Record remains visible offline. */
            }
          }
        };
        return [row, detailRow];
      }),
    );
  }
  async function refresh() {
    if (loading || panel.classList.contains("hidden")) return;
    loading = true;
    try {
      const response = await fetch("/api/kronos", {
        signal: window.AbortSignal.timeout(3500),
      });
      render(await response.json());
    } catch {
      render({ error: "KRONOS_LAB_OFFLINE" });
    } finally {
      loading = false;
    }
  }
  async function control(data) {
    const bot = await (await fetch("/api/status")).json();
    const response = await fetch("/api/kronos/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": bot.csrf },
      body: JSON.stringify({ ...data, csrf: state.csrf }),
      signal: window.AbortSignal.timeout(4000),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || "LAB_UNAVAILABLE");
    return value;
  }
  async function change(data) {
    try {
      await control(data);
      await refresh();
    } catch (e) {
      $("kronosStatus").textContent = e.message;
    }
  }
  $("kronosEnable").onclick = () => change({ action: "enable" });
  $("kronosPause").onclick = () => change({ action: "pause" });
  $("kronosReset").onclick = () => {
    if (
      window.confirm(
        "Reset all Kronos paper experiment records? Production data will remain unchanged.",
      )
    )
      void change({
        action: "reset",
        confirmation: "RESET KRONOS PAPER EXPERIMENT",
      });
  };
  document
    .querySelector('[data-view="kronos"]')
    ?.addEventListener("click", () => void refresh());
  setInterval(() => void refresh(), 5000);
  window.KronosUI = { render };
})();
