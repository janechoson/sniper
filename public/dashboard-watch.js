import "./token-avatar.js";
import { el } from "./dashboard-core.js";
import { setupPositionHelpers } from "./dashboard-position-tools.js";
export async function mount(ctx, view) {
  const $ = (id) => document.getElementById(id);
  function renderDeferred(s) {
    const pipeline = s.candidatePipeline;
    const rows = pipeline?.deferred ?? [];
    $("queueSummary").textContent = window.BOTText.vi(
      `Queue ${pipeline?.queue.length ?? 0}/${pipeline?.capacity ?? 10} · Watch ${pipeline?.watch.length ?? 0} · Deferred ${rows.length}`,
    );
    $("deferredEmpty").classList.toggle("hidden", rows.length > 0);
    $("deferredRows").replaceChildren(
      ...rows.map((item) => {
        const row = el("tr"),
          token = el("td", item.symbol || item.mint.slice(0, 8), "token-name");
        token.append(el("small", item.mint));
        row.append(token);
        for (const value of [
          item.issue?.code ?? "—",
          item.issue?.stage ?? "—",
          item.failureCount,
          new Date(item.lastChecked).toLocaleTimeString("vi-VN"),
          new Date(item.nextCheckAt).toLocaleTimeString("vi-VN"),
          Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000)) + "s",
          item.state,
        ])
          row.append(el("td", value));
        return row;
      }),
    );
    $("faultMetrics").textContent = window.BOTText.vi(
      Object.entries(s.faultMetrics ?? {})
        .map(([key, value]) => `${key}: ${value}`)
        .join(" · "),
    );
  }

  if (view === "watchlist") setupPositionHelpers(ctx);
  const refresh = async () => {
    if (view === "deferred") {
      renderDeferred(await ctx.get("/api/deferred"));
      return;
    }
    const data = await ctx.get("/api/watchlist");
    const rows = data.structureWatch.filter(
      (r) => r.status === "ACTIVE" && r.eligibleForEntryWatch,
    );
    $("structureWatchRows").replaceChildren(
      ...rows.map((r) => window.BOTStructurePanel(r, "TRENDING", true)),
    );
    $("structureWatchCount").textContent = String(rows.length);
    $("watchEmpty").classList.toggle("hidden", rows.length > 0);
  };
  ctx.setRefresh(refresh);
  if (view === "watchlist") ctx.interval(() => window.BOTWatchTick?.(), 1000);
  await ctx.poll(refresh, 5000);
}
