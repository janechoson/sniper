import { env } from "../src/config.js";
import { openResearchSession } from "../src/database-session.js";
import { JupiterQuotes } from "../src/jupiter-quotes.js";
import { address } from "../src/gmgn.js";

// Read-only route probe: never constructs an Executor or a signer.
const session = openResearchSession();
const record=(kind:string,mint:string,payload:unknown)=>session.learning.prepare('INSERT INTO learning_records VALUES(?,?,?,?,?)').run('quote:'+Date.now(),kind,mint,Date.now(),JSON.stringify(payload));
try {
  const row = session.learning
    .prepare(
      "SELECT mint FROM chart_candles GROUP BY mint ORDER BY max(at) DESC LIMIT 1",
    )
    .get();
  const mint = address(process.argv[2] ?? String(row?.mint ?? ""));
  const at = Date.now(),
    amount = 10000000n;
  try {
    const quote = await new JupiterQuotes().quoteBuy(mint, amount, 100);
    record("chart_quote_probes", mint, {
      at,
      mode: "demo",
      readOnly: true,
      amount: amount.toString(),
      quote,
    });
    console.log(
      JSON.stringify({
        state: "AVAILABLE",
        mint,
        quoteAt: quote.at,
        routeOnly: quote.routeOnly,
        amount: amount.toString(),
        priceImpact: quote.order.priceImpactPct ?? null,
      }),
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "QUOTE_UNAVAILABLE";
    record("chart_quote_probes", mint, {
      at,
      mode: "demo",
      readOnly: true,
      amount: amount.toString(),
      error: code,
    });
    console.log(
      JSON.stringify({
        state: "UNAVAILABLE",
        mint,
        error: code,
        apiKeyPresent: !!env.JUPITER_API_KEY,
      }),
    );
  }
} finally {
  session.close();
}
