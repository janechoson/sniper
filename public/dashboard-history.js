import "./token-avatar.js";
import {
  el,
  pnlText,
  tokenQuantity,
  accountingSol,
  accountingUsd,
  accountingFeeText,
} from "./dashboard-core.js";
export async function mount(ctx) {
  const $ = (id) => document.getElementById(id);
  const historyCards = new Map();
  function renderHistory(history, byMint) {
    const root = $("historyRows");
    $("historyEmpty").classList.toggle("hidden", history.length > 0);
    const ids = new Set(history.map((p) => p.id));
    for (const [id, saved] of historyCards)
      if (!ids.has(id)) {
        saved.row.remove();
        historyCards.delete(id);
      }
    const price = (f) =>
      !f
        ? "—"
        : f.priceUsd != null
          ? accountingUsd(f.priceUsd)
          : f.priceSol != null
            ? f.priceSol + " SOL/token"
            : "—";
    const date = (at) =>
      Number.isFinite(at) ? new Date(at).toLocaleString("vi-VN") : "—";
    history.forEach((p, index) => {
      const token = byMint.get(p.mint),
        symbol = p.symbol || token?.symbol || "Unknown Token",
        name = token?.name || p.name || symbol;
      const fingerprint = JSON.stringify([
        p,
        name,
        symbol,
        window.BOTTokenAvatar?.logo(token),
      ]);
      let saved = historyCards.get(p.id);
      if (!saved || saved.fingerprint !== fingerprint) {
        const a = p.accounting,
          row = el("details", undefined, "history-record");
        row.dataset.positionId = p.id;
        row.open = saved?.row.open || false;
        const summary = el("summary", undefined, "history-summary");
        const title = el(
          "span",
          name + (name !== symbol ? " (" + symbol + ")" : ""),
          "history-token token-name",
        );
        title.title = p.mint;
        title.append(el("small", p.strategy || "STANDARD", "strategy-badge"));
        if (window.BOTTokenAvatar)
          title.prepend(
            window.BOTTokenAvatar.create(
              {
                ...token,
                ...p,
                logo: window.BOTTokenAvatar.logo(token) || p.logo,
              },
              "token-avatar",
            ),
          );
        const path = el("span", undefined, "trade-lifecycle-path");
        path.append(
          el(
            "span",
            "ENTRY · " +
              price(a?.entry) +
              " · " +
              date(a?.entry?.at ?? p.entryAt),
          ),
          el(
            "span",
            "→ " +
              (a?.holdMs == null
                ? "—"
                : Math.floor(a.holdMs / 60000) +
                  "m " +
                  Math.floor((a.holdMs % 60000) / 1000) +
                  "s"),
          ),
          el(
            "span",
            "THOÁT CUỐI · " + price(a?.finalExit) + " · " + date(a?.closedAt),
          ),
        );
        const pnl = el(
          "strong",
          a?.grossPnlLamports == null
            ? "PnL —"
            : "PnL " +
                pnlText(
                  BigInt(a.grossPnlLamports),
                  BigInt(a.principalLamports ?? "0"),
                ),
          "history-pnl " +
            (a?.grossPnlLamports != null && BigInt(a.grossPnlLamports) < 0n
              ? "negative"
              : "positive"),
        );
        pnl.title = "Lãi/lỗ của vị thế trước phí.";
        const amounts = el(
          "span",
          "Fee " +
            accountingFeeText(a) +
            " · Net " +
            accountingSol(a?.netPnlLamports),
          "history-accounting-summary",
        );
        amounts.title =
          "Fee: Phí giao dịch đã thực sự phát sinh. Net PnL: PnL sau khi trừ phí đã phát sinh.";
        const result = el(
          "span",
          a?.grossPnlLamports == null
            ? "UNKNOWN"
            : BigInt(a.grossPnlLamports) > 0n
              ? "PROFIT"
              : BigInt(a.grossPnlLamports) < 0n
                ? "LOSS"
                : "FLAT",
          "history-result",
        );
        summary.append(
          title,
          path,
          pnl,
          amounts,
          result,
          el("span", "⌄", "history-arrow"),
        );
        const detail = el("div", undefined, "history-detail"),
          values = el("dl", undefined, "history-metrics");
        const add = (label, value) => {
          const m = el("div");
          m.append(
            el("dt", label),
            el("dd", value == null ? "—" : String(value)),
          );
          values.append(m);
        };
        add("Địa chỉ mint", p.mint);
        if (p.entryComparison) {
          add(
            "Entry owner",
            p.entryComparison.ownershipClaim?.strategy ||
              p.strategy ||
              "STANDARD",
          );
          add("Ownership rule", "FIRST_BUY_CLAIM");
          for (const strategy of ["STANDARD", "KRONOS"]) {
            const e = p.entryComparison.strategies?.[strategy];
            add(strategy + " decision", e?.decision);
            add(strategy + " execution", e?.execution);
          }
        }
        add(
          "Đã bán",
          tokenQuantity(p.originalQuantity, p.decimals) + " " + symbol,
        );
        add("Vốn đã đầu tư", accountingSol(a?.principalLamports));
        add("Entry thực khớp", price(a?.entry));
        add(
          "Signal Price (không phải Entry)",
          accountingUsd(a?.signalPriceUsd),
        );
        add("Mở vị thế lúc", date(a?.entry?.at ?? p.entryAt));
        add("Final Exit lúc", date(a?.closedAt));
        add(
          "Avg Exit",
          a?.averageExitPriceSol ? a.averageExitPriceSol + " SOL/token" : "—",
        );
        add("Gross PnL · trước phí", accountingSol(a?.grossPnlLamports));
        add(
          "Gross PnL %",
          a?.grossPnlPct == null ? "—" : a.grossPnlPct.toFixed(2) + "%",
        );
        add("Entry Fee", accountingSol(a?.entryFeesLamports));
        add("Exit Fees · mọi SELL", accountingSol(a?.exitFeesLamports));
        add("Fee · SOL / USD", accountingFeeText(a));
        add("Net PnL", accountingSol(a?.netPnlLamports));
        add(
          "Net PnL %",
          a?.netPnlPct == null ? "—" : a.netPnlPct.toFixed(2) + "%",
        );
        add(
          "Recoverable rent · net locked",
          accountingSol(a?.recoverableRentDeltaLamports),
        );
        add(
          "MFE · trước phí",
          Number.isFinite(p.mfePercent) ? p.mfePercent.toFixed(2) + "%" : "—",
        );
        add(
          "MAE · trước phí",
          Number.isFinite(p.maePercent) ? p.maePercent.toFixed(2) + "%" : "—",
        );
        add("Chế độ", p.mode.toUpperCase());
        add("Trạng thái", p.state);
        add("Lý do thoát lệnh", p.exitStatus || "—");
        add(
          "Độ đầy đủ kế toán",
          a?.feeCompleteness === "IDENTIFIED_DEBITS_RECONCILED"
            ? "Đã đối soát các khoản chi"
            : "Thiếu bằng chứng lịch sử",
        );
        const txs = el("div", undefined, "history-links");
        const txLink = (label, signature) => {
          if (!signature) return;
          const link = el("a", label);
          link.href = "https://solscan.io/tx/" + encodeURIComponent(signature);
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.title = signature;
          txs.append(link);
        };
        txLink("Entry Tx ↗", a?.entry?.signature ?? p.signature);
        const exits = el("div", undefined, "history-executions");
        for (const fill of a?.exits || []) {
          const final = a?.finalExit?.executionId === fill.executionId;
          const line = el(
            "div",
            (final ? "THOÁT CUỐI" : "THOÁT MỘT PHẦN") +
              " · " +
              date(fill.at) +
              " · " +
              price(fill) +
              " · " +
              tokenQuantity(fill.quantityAtomic, p.decimals) +
              " " +
              symbol +
              " · Proceeds " +
              accountingSol(fill.tradingLamports) +
              " · Fee " +
              accountingSol(fill.networkFeeLamports) +
              " / " +
              accountingUsd(fill.feeUsd),
          );
          exits.append(line);
          txLink(
            (final ? "Final Exit" : "Partial Exit") + " Tx ↗",
            fill.signature,
          );
        }
        if (!a?.exits?.length) txLink("Exit Tx ↗", p.sellSignature);
        const breakdown = el("details", undefined, "accounting-fee-breakdown");
        breakdown.append(el("summary", "Fee breakdown · network gồm priority"));
        for (const fee of a?.feeRecords || [])
          breakdown.append(
            el(
              "p",
              fee.side +
                " · " +
                accountingSol(fee.feeLamports) +
                " / " +
                accountingUsd(fee.feeUsd) +
                " · " +
                fee.source +
                " · FX " +
                (fee.fx ? fee.fx.source + " @ " + date(fee.fx.at) : "UNKNOWN"),
            ),
          );
        breakdown.append(
          el(
            "small",
            "Priority split / platform / route / transfer: — nếu không có actual debit evidence. Embedded route costs, slippage và price impact không trừ lần hai. Rent recoverable tách riêng.",
          ),
        );
        detail.append(values, exits, breakdown, txs);
        row.append(summary, detail);
        if (saved) saved.row.replaceWith(row);
        saved = { row, fingerprint };
        historyCards.set(p.id, saved);
      }
      if (root.children[index] !== saved.row)
        root.insertBefore(saved.row, root.children[index] || null);
    });
  }

  const filter = $("historyStrategy");
  filter.value = new URLSearchParams(location.search).get("strategy") || "ALL";
  const refresh = async () => {
    const query = new URLSearchParams(location.search);
    if (filter.value !== "ALL") query.set("strategy", filter.value);
    else query.delete("strategy");
    const rows = await ctx.get(
      "/api/history" + (query.size ? "?" + query : ""),
    );
    renderHistory(rows, new Map(rows.map((r) => [r.mint, r])));
  };
  ctx.setRefresh(refresh);
  filter.onchange = () => {
    ctx.query({ strategy: filter.value === "ALL" ? null : filter.value });
    ctx.refresh();
  };
  await ctx.poll(refresh, 5000);
}
