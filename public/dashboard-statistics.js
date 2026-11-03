import { el } from "./dashboard-core.js";
export async function mount(ctx) {
  const filter = document.getElementById("statisticsStrategy"), root = document.getElementById("terminalStatistics");
  filter.value = new URLSearchParams(location.search).get("strategy") || "ALL";
  const refresh = async () => {
    const data = await ctx.get("/api/statistics?strategy=" + encodeURIComponent(filter.value));
    root.replaceChildren(...Object.entries(data).map(([label, value]) => {
      const row = el("div", undefined, "terminal-metric");
      row.append(el("span", label), el("strong", value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value)));
      return row;
    }));
  };
  ctx.setRefresh(refresh);
  filter.onchange = () => {ctx.query({ strategy: filter.value === "ALL" ? null : filter.value });ctx.refresh();};
  await ctx.poll(refresh, 5000);
}
