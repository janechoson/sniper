import { z } from "zod";
import type { TrustedQuoteAsset } from "@sniper/config";
import { parseUnitsSafe } from "@sniper/shared";
/** Public venue USD reference, not an on-chain oracle or wrapped-asset redemption proof. */
export async function resolveCoinbase(
  asset: TrustedQuoteAsset,
  fetcher: typeof fetch = fetch,
) {
  const oracle = asset.coinbaseOracle;
  if (!oracle) return;
  const symbols: Record<string, string[]> = {
    "SOL-USD": ["SOL", "WSOL"],
    "ETH-USD": ["ETH", "WETH"],
    "USDC-USD": ["USDC"],
  };
  if (!symbols[oracle.product]?.includes(asset.symbol))
    throw Error("PRICE_ASSET_MISMATCH");
  const response = await fetcher(
    `https://api.exchange.coinbase.com/products/${oracle.product}/ticker`,
    { signal: AbortSignal.timeout(7000), redirect: "error" },
  );
  if (!response.ok) throw Error("PRICE_HTTP_FAILED");
  const amount = z.string().regex(/^[0-9]+(?:\.[0-9]{1,18})?$/);
  const ticker = z
    .object({ price: amount, bid: amount, ask: amount, time: z.string() })
    .parse(await response.json());
  const price = parseUnitsSafe(ticker.price, 18),
    bid = parseUnitsSafe(ticker.bid, 18),
    ask = parseUnitsSafe(ticker.ask, 18);
  const observedAt = Date.parse(ticker.time);
  if (
    !Number.isFinite(observedAt) ||
    observedAt > Date.now() + 1000 ||
    Date.now() - observedAt > oracle.maxAgeSec * 1000 ||
    price <= 0n ||
    bid <= 0n ||
    ask < bid ||
    (ask - bid) * 10000n > bid * BigInt(oracle.maxSpreadBps) ||
    price * 10000n < bid * BigInt(10000 - oracle.maxSpreadBps) ||
    price * 10000n > ask * BigInt(10000 + oracle.maxSpreadBps)
  )
    throw Error("PRICE_STALE_OR_INVALID");
  return {
    ...asset,
    usdPrice: ticker.price,
    priceVerifiedAt: observedAt,
    priceSource: `EXTERNAL:COINBASE_EXCHANGE:${oracle.product}`,
    priceObservation: {
      asset: oracle.product,
      source: "EXTERNAL:COINBASE_EXCHANGE",
      observedAt,
      maxAgeMs: oracle.maxAgeSec * 1000,
      status: "VALID" as const,
    },
  };
}
