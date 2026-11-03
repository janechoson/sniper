import { el, sol, num } from "./dashboard-core.js";
export async function mount(ctx) {
  const $ = (id) => document.getElementById(id),
    get = ctx.get,
    error = ctx.error;
  function renderLearning(report) {
    if (!report) return;
    $("learningStats").replaceChildren(
      ...[
        ["Completed", report.completedTrades],
        ["Strategy samples", report.eligibleStrategyTrades],
        [
          "Wins / losses / breakeven",
          report.wins + " / " + report.losses + " / " + report.breakeven,
        ],
        [
          "Win rate",
          report.winRate === null ? "—" : num(report.winRate * 100) + "%",
        ],
        ["Net PnL SOL", sol(report.netLamports)],
        [
          "Average / median PnL %",
          num(report.avgNetPnlPercent) +
            " / " +
            num(report.medianNetPnlPercent),
        ],
        [
          "Average MFE / MAE %",
          num(report.avgMfePercent) + " / " + num(report.avgMaePercent),
        ],
        ["Historical confidence", report.confidence],
        ["Execution failures (separate)", report.executionFailures],
        [
          "Entry quality",
          report.entryQuality.map((x) => x.code + ": " + x.count).join(", ") ||
            "—",
        ],
        [
          "Exit quality",
          report.exitQuality.map((x) => x.code + ": " + x.count).join(", ") ||
            "—",
        ],
        [
          "Exit reasons",
          report.exitReasons.map((x) => x.code + ": " + x.count).join(", ") ||
            "—",
        ],
      ].map(([label, value]) => {
        const d = el("div");
        d.append(el("label", label), el("strong", value));
        return d;
      }),
    );
    const positive = report.patterns
      .filter((p) => p.avgNetPnlPercent > 0)
      .sort((a, b) => b.avgNetPnlPercent - a.avgNetPnlPercent)
      .slice(0, 3);
    const negative = report.patterns
      .filter((p) => p.avgNetPnlPercent < 0)
      .sort((a, b) => a.avgNetPnlPercent - b.avgNetPnlPercent)
      .slice(0, 3);
    $("learningPatterns").replaceChildren(
      ...[
        ["Winning profiles", positive],
        ["Losing profiles", negative],
      ].map(([label, patterns]) => {
        const d = el("div");
        d.append(
          el("h3", label),
          el(
            "p",
            patterns.length
              ? patterns
                  .map(
                    (p) =>
                      p.profile +
                      " · " +
                      p.wins +
                      "W/" +
                      p.losses +
                      "L · avg " +
                      num(p.avgNetPnlPercent) +
                      "% · " +
                      p.confidence,
                  )
                  .join("; ")
              : "No completed samples",
          ),
        );
        return d;
      }),
    );
    $("learningSuggestions").replaceChildren(
      el("h3", "Suggestions · never automatically applied"),
      ...report.suggestions.map((s) =>
        el("p", s.reason + " · " + s.confidence + " · n=" + s.sampleCount),
      ),
    );
    $("learningTrades").replaceChildren(
      ...report.trades.map((t) => {
        const button = el(
          "button",
          t.mint +
            " · " +
            t.result +
            " · " +
            num(t.netPnlPercent) +
            "% · " +
            t.coverage,
        );
        button.onclick = () => showLearningTrade(t.sampleId).catch(error);
        return button;
      }),
    );
  }
  async function showLearningTrade(id) {
    const detail = await get(
      "/api/learning/trade?id=" + encodeURIComponent(id),
    );
    $("trace").replaceChildren(
      ...Object.entries(detail ?? {}).map(([section, value]) => {
        const d = el("div");
        d.append(el("h3", section), el("pre", JSON.stringify(value, null, 2)));
        return d;
      }),
    );
    $("detail").showModal();
  }

  const refresh = async () => renderLearning(await ctx.get("/api/learning"));
  ctx.setRefresh(refresh);
  await ctx.poll(refresh, 15000);
}
