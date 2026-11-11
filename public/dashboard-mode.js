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
const validNumber = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value));
const sol = (value) =>
  !validNumber(value)
    ? "N/A"
    : Number(value).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }) + " SOL";
let accountSnapshot;
function paintAccount() {
  const snapshot = accountSnapshot;
  for (const [id, value] of [
    ["kpiEquity", snapshot?.equity],
    ["kpiRealized", snapshot?.realized],
    ["kpiUnrealized", snapshot?.unrealized],
  ]) {
    const target = byId(id);
    if (!target) continue;
    target.textContent = sol(value);
    target.title =
      snapshot?.error ||
      (validNumber(value)
        ? "Dữ liệu " + snapshot.mode
        : "Chưa đủ dữ liệu tài khoản");
    target.classList.toggle(
      "positive",
      id !== "kpiEquity" && validNumber(value) && Number(value) > 0,
    );
    target.classList.toggle(
      "negative",
      id !== "kpiEquity" && validNumber(value) && Number(value) < 0,
    );
  }
  if (byId("kpiEquityNote"))
    byId("kpiEquityNote").textContent =
      snapshot?.mode === "DEMO"
        ? "Ước tính · tài khoản mô phỏng"
        : "Theo quan sát ví đã đối soát";
  if (byId("kpiPnlNote"))
    byId("kpiPnlNote").textContent =
      snapshot?.mode === "LIVE"
        ? "Trước phí · thống kê thực thi"
        : "Kết quả đã ghi nhận";
}
window.BOTAccountView = { paint: paintAccount };
async function refresh() {
  const epoch = ++refreshEpoch;
  const mode = await get("/api/mode");
  if (epoch !== refreshEpoch) return;
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
  byId("accountAssumptions").textContent =
    mode.mode === "DEMO"
      ? "Vốn ảo · khớp mô phỏng theo quote; phí ước tính. Reset chỉ khả dụng khi session dừng."
      : "Tiền thật · số dư ví theo đối soát blockchain. LIVE luôn cần xác nhận.";
  try {
    const [account, statistics] = await Promise.all([
      get("/api/account-balance"),
      mode.mode === "LIVE"
        ? get("/api/statistics").catch(() => null)
        : Promise.resolve(null),
    ]);
    if (epoch !== refreshEpoch) return;
    if (String(account.mode).toUpperCase() !== mode.mode)
      throw Error("Mode đang chuyển, đang chờ dữ liệu tài khoản mới");
    const point = account.points?.at(-1);
    const fresh =
      point && point.at <= Date.now() && Date.now() - point.at < 60000;
    accountSnapshot =
      mode.mode === "DEMO"
        ? {
            mode: mode.mode,
            equity: account.equitySol,
            realized: account.realizedPnlSol,
            unrealized: account.unrealizedPnlSol,
          }
        : {
            mode: mode.mode,
            equity:
              fresh && validNumber(point.totalLamports)
                ? Number(point.totalLamports) / 1e9
                : null,
            realized: validNumber(statistics?.realizedLamports)
              ? Number(statistics.realizedLamports) / 1e9
              : null,
            unrealized: validNumber(statistics?.unrealizedLamports)
              ? Number(statistics.unrealizedLamports) / 1e9
              : null,
          };
    paintAccount();
  } catch (error) {
    if (epoch !== refreshEpoch) return;
    accountSnapshot = { mode: mode.mode, error: error.message };
    paintAccount();
    throw error;
  }
}
async function act(work) {
  if (busy) return;
  busy = true;
  actionError = null;
  accountSnapshot = undefined;
  refreshEpoch++;
  window.dispatchEvent(new window.Event("trading-mode-changing"));
  byId("selectDemo").disabled = byId("selectLive").disabled = true;
  try {
    await work();
  } catch (e) {
    actionError = e.message;
    byId("modeAccount").open = true;
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
let timer;
function startPolling() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (!busy)
      void refresh().catch((e) => {
        byId("modeState").textContent = e.message;
      });
  }, 5000);
}
startPolling();
window.addEventListener("pagehide", () => {
  clearInterval(timer);
  refreshEpoch++;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    startPolling();
    void refresh().catch((e) => {
      byId("modeState").textContent = e.message;
    });
  }
});
