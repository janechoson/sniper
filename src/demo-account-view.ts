import { DemoLedger, LAMPORTS_PER_SOL } from "./demo-ledger.js";
import type { Engine } from "./engine.js";

const sol = (value: bigint) => {
  const sign = value < 0n ? "-" : "",
    n = value < 0n ? -value : value;
  return (
    sign +
    n / LAMPORTS_PER_SOL +
    "." +
    (n % LAMPORTS_PER_SOL).toString().padStart(9, "0")
  );
};
/** Read-only SOL valuation. Cash and cost basis are native lamports; missing marks remain unknown. */
function valuation(engine: Engine) {
  const ledger = new DemoLedger(engine.store.db),
    a = ledger.account(),
    holdings = ledger.holdings();
  let marks = 0n,
    costs = 0n,
    complete = true;
  const positions = engine.store.positions("demo");
  for (const h of holdings) {
    const p = positions.find((p) => p.id === h.position_id);
    costs += BigInt(String(h.cost));
    if (
      !p ||
      p.state !== "OPEN" ||
      p.quantity !== h.quantity ||
      !p.lastQuoteAt ||
      Date.now() - p.lastQuoteAt > engine.settings.maxSnapshotAgeMs ||
      p.lastQuoteAt > Date.now() ||
      p.lastValueLamports === undefined ||
      p.valuationQuantity !== p.quantity
    ) {
      complete = false;
      continue;
    }
    marks += BigInt(p.lastValueLamports);
  }
  return { ledger, a, holdings, complete, marks, costs };
}
export function captureDemoBalance(engine: Engine) {
  const { ledger, a, complete, marks } = valuation(engine);
  ledger.snapshot(complete ? a.cash + marks : undefined, {
    kind: "PERIODIC_MARK",
    currency: "SOL",
    atomicDecimals: 9,
    valuationStatus: complete ? "ESTIMATED_MARK_TO_MARKET" : "UNAVAILABLE",
  });
}
export function demoAccountView(engine: Engine) {
  const { ledger, a, holdings, complete, marks, costs } = valuation(engine);
  return {
    mode: "DEMO",
    currency: "SOL",
    accountId: a.id,
    initialCapitalLamports: String(a.initial),
    initialCapitalSol: sol(a.initial),
    availableCashLamports: String(a.cash - a.reserved),
    availableCashSol: sol(a.cash - a.reserved),
    reservedCashLamports: String(a.reserved),
    reservedCashSol: sol(a.reserved),
    cashLamports: String(a.cash),
    cashSol: sol(a.cash),
    realizedPnlLamports: String(a.realized),
    realizedPnlSol: sol(a.realized),
    unrealizedPnlLamports: complete ? String(marks - costs) : null,
    unrealizedPnlSol: complete ? sol(marks - costs) : null,
    equityLamports: complete ? String(a.cash + marks) : null,
    equitySol: complete ? sol(a.cash + marks) : null,
    valuationStatus: complete ? "ESTIMATED_MARK_TO_MARKET" : "UNAVAILABLE",
    holdings,
    history: ledger
      .history(Date.now() - 24 * 60 * 60 * 1000)
      .map((row) => ({
        ...row,
        currency: "SOL",
        cashSol: sol(BigInt(String(row.cash))),
        equitySol: row.equity === null ? null : sol(BigInt(String(row.equity))),
      })),
    executionAssumption:
      "Fresh quote minimum output; fees estimated; SOL balances and settlement use exact integer lamports.",
  };
}
