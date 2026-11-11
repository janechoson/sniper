const byId = (id) => document.getElementById(id);
let busy = false,
  actionError = null,
  refreshEpoch = 0;
async function get(path) {
  const response = await fetch(path, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok)
    throw Error(data.error || "Không đọc được trạng thái máy chủ");
  return data;
}
async function post(path, body = {}) {
  const shell = await get("/api/ui/shell");
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": shell.csrf },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Thao tác bị chặn");
  return data;
}
const sol = (value) =>
  value == null
    ? "Chưa đủ dữ liệu"
    : Number(value).toLocaleString("en-US", { maximumFractionDigits: 9 }) +
      " SOL";
function chart(points, unit) {
  const svg = byId("accountChart");
  svg.replaceChildren();
  const known = points.filter(
    (p) => p.value !== null && Number.isFinite(p.value),
  );
  svg.setAttribute(
    "aria-label",
    "Lịch sử số dư " +
      unit +
      ", " +
      known.length +
      " quan sát thật hoặc mô phỏng theo mode",
  );
  if (!known.length) return;
  const lo = Math.min(...known.map((p) => p.value)),
    hi = Math.max(...known.map((p) => p.value));
  const from = points[0].at,
    to = points.at(-1).at;
  const x = (p) => 12 + (776 * (p.at - from)) / Math.max(1, to - from);
  const y = (p) => 108 - (96 * (p.value - lo)) / Math.max(1, hi - lo);
  let segment = [];
  const flush = () => {
    if (!segment.length) return;
    const line = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline",
    );
    line.setAttribute(
      "points",
      segment.map((p) => `${x(p)},${y(p)}`).join(" "),
    );
    line.setAttribute("class", "account-history-line");
    svg.append(line);
    segment = [];
  };
  for (const p of points) {
    if (p.value === null || !Number.isFinite(p.value)) {
      flush();
      continue;
    }
    segment.push(p);
    const dot = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle",
    );
    dot.setAttribute("cx", String(x(p)));
    dot.setAttribute("cy", String(y(p)));
    dot.setAttribute("r", "3");
    const title = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "title",
    );
    title.textContent =
      new Date(p.at).toLocaleString() + ": " + p.value.toFixed(4) + " " + unit;
    dot.append(title);
    svg.append(dot);
  }
  flush();
}
async function refresh() {
  const epoch = ++refreshEpoch;
  const mode = await get("/api/mode");
  const account = await get("/api/account-balance");
  if (epoch !== refreshEpoch) return;
  if (String(account.mode).toUpperCase() !== mode.mode)
    throw Error("Mode đang chuyển, đang chờ dữ liệu tài khoản mới");
  document.body.dataset.tradingMode = mode.mode.toLowerCase();
  byId("selectDemo").setAttribute("aria-pressed", String(mode.mode === "DEMO"));
  byId("selectLive").setAttribute("aria-pressed", String(mode.mode === "LIVE"));
  byId("accountModeTitle").textContent = "KRONOS · " + mode.mode;
  byId("modeState").textContent =
    actionError ||
    (mode.active ? "Session đang chạy" : "Session đã dừng") +
      (mode.liveConfirmationRequired ? " · Cần xác nhận mới để chạy LIVE" : "");
  byId("resetDemo").hidden = mode.mode !== "DEMO";
  byId("resetDemo").disabled = mode.active || busy;
  byId("stopMode").disabled = !mode.active || busy;
  const metrics = byId("accountMetrics");
  metrics.replaceChildren();
  const add = (label, value) => {
    const card = document.createElement("div"),
      name = document.createElement("span"),
      number = document.createElement("strong");
    name.textContent = label;
    number.textContent = value;
    card.append(name, number);
    metrics.append(card);
  };
  if (mode.mode === "DEMO") {
    add("Vốn ban đầu", sol(account.initialCapitalSol));
    add("Tiền ảo khả dụng", sol(account.availableCashSol));
    add("Đang giữ chỗ", sol(account.reservedCashSol));
    add("Equity ước tính", sol(account.equitySol));
    add("PnL đã thực hiện", sol(account.realizedPnlSol));
    add("PnL chưa thực hiện", sol(account.unrealizedPnlSol));
    add("Vị thế ảo", String(account.holdings.length));
    chart(
      account.history.map((p) => ({ at: p.at, value: Number(p.cashSol) })),
      "SOL",
    );
    byId("accountAssumptions").textContent =
      "Biểu đồ số dư SOL · Khớp mô phỏng tại minimum output của quote; phí là ước tính. Vốn 100 SOL không tính vào lợi nhuận.";
    byId("terminalUsd").textContent = sol(account.availableCashSol) + " DEMO";
  } else {
    const points = account.points || [];
    add(
      "Số dư SOL quan sát gần nhất",
      points.at(-1)?.totalLamports == null
        ? "Chưa đủ dữ liệu"
        : (Number(points.at(-1).totalLamports) / 1e9).toFixed(6) + " SOL",
    );
    chart(
      points.map((p) => ({
        at: p.at,
        value: p.totalLamports == null ? null : Number(p.totalLamports) / 1e9,
      })),
      "SOL",
    );
    byId("accountAssumptions").textContent =
      "LIVE · Lịch sử quan sát tài khoản thật; khoảng thiếu dữ liệu giữ nguyên.";
  }
}
async function act(work) {
  if (busy) return;
  busy = true;
  actionError = null;
  refreshEpoch++;
  window.dispatchEvent(new window.Event("trading-mode-changing"));
  byId("selectDemo").disabled = byId("selectLive").disabled = true;
  try {
    await work();
  } catch (e) {
    actionError = e.message;
  } finally {
    busy = false;
    await refresh().catch((e) => {
      byId("modeState").textContent = actionError || e.message;
    });
    byId("selectDemo").disabled = byId("selectLive").disabled = false;
    window.dispatchEvent(new window.Event("trading-mode-changed"));
  }
}
byId("selectDemo").onclick = () =>
  act(() => post("/api/mode", { mode: "DEMO" }));
byId("selectLive").onclick = () => {
  if (
    !window.confirm(
      "Bật LIVE sẽ dùng ví Solana thật và có thể chi tiền thật. Bạn xác nhận chạy LIVE?",
    )
  )
    return;
  void act(() =>
    post("/api/mode", { mode: "LIVE", confirmation: "START LIVE" }),
  );
};
byId("stopMode").onclick = () => act(() => post("/api/mode/stop"));
byId("resetDemo").onclick = () => {
  if (
    !window.confirm(
      "Reset Demo về 100 SOL? Session phải dừng. Lịch sử DEMO cũ được lưu archive; LIVE được giữ nguyên.",
    )
  )
    return;
  void act(() => post("/api/demo/reset", { confirmation: "RESET DEMO" }));
};
void refresh().catch((e) => {
  byId("modeState").textContent = e.message;
});
setInterval(() => {
  if (!busy)
    void refresh().catch((e) => {
      byId("modeState").textContent = e.message;
    });
}, 5000);
