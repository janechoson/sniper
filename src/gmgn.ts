import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { Settings } from "./config.js";
import {
  Blocked,
  ProviderFailure,
  known,
  unknown,
  type Candidate,
  type Evidence,
  type Market,
  type Security,
} from "./domain.js";
import { normalizeTokenLogo } from "./token-metadata.js";
const object = z.record(z.string(), z.unknown());
export const record = (v: unknown): Record<string, unknown> =>
  object.safeParse(v).success ? (v as Record<string, unknown>) : {};
export function address(value: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
    throw new Blocked("Invalid Solana public address");
  return new PublicKey(value).toBase58();
}
export function numberEvidence(v: unknown): Evidence<number> {
  if (
    (typeof v !== "number" && typeof v !== "string") ||
    (typeof v === "string" && v.trim() === "")
  )
    return unknown();
  const n = Number(v);
  return Number.isFinite(n) && n >= 0
    ? known(n)
    : unknown("Invalid GMGN numeric value");
}
export function percent(v: unknown): Evidence<number> {
  const n = numberEvidence(v);
  return n.state === "KNOWN" && n.value <= 1
    ? known(n.value * 100)
    : unknown("Percentage unavailable or outside GMGN fractional units");
}
const bool = (v: unknown): Evidence<boolean> =>
  typeof v === "boolean"
    ? known(v)
    : unknown("GMGN did not verify this authority");
const optionalText = (v: unknown, max = 128) =>
  typeof v === "string" ? v.slice(0, max) : undefined;
export function parseDiscovery(raw: unknown): Candidate[] {
  const r = object.parse(raw);
  const now =
    typeof record(r._gmgnSnapshot).fetchedAt === "number"
      ? Number(record(r._gmgnSnapshot).fetchedAt)
      : Date.now();
  const result: Candidate[] = [];
  for (const category of ["new_creation", "pump", "completed"]) {
    const rows = z
      .array(object)
      .parse(category === "pump" ? (r.near_completion ?? r.pump) : r[category]);
    for (const row of rows) {
      try {
        const mint = address(z.string().parse(row.address));
        const created = numberEvidence(
          row.created_timestamp ?? row.creation_timestamp,
        );
        const listing = Object.fromEntries(
          [
            "rug_ratio",
            "renounced_mint",
            "renounced_freeze_account",
            "top_10_holder_rate",
            "creator_balance_rate",
            "bundler_trader_amount_rate",
            "smart_degen_count",
            "renowned_count",
            "liquidity",
            "usd_market_cap",
          ]
            .filter((k) => row[k] !== undefined)
            .map((k) => [k, row[k]]),
        );
        result.push({
          discovery: {
            sources: ["SNIPER"],
            firstSeenAt: now,
            lastSeenAt: now,
            sniper: { firstSeenAt: now, lastSeenAt: now },
          },
          mint,
          symbol: optionalText(row.symbol, 32),
          name: optionalText(row.name),
          logo: normalizeTokenLogo(row.logo),
          source: "gmgn:" + String(row.launchpad_platform ?? category),
          discoveredAt: now,
          createdAt:
            created.state === "KNOWN" && created.value > 0
              ? created.value * 1000
              : undefined,
          listing: { ...listing, logo: normalizeTokenLogo(row.logo) },
        });
      } catch {
        /* A malformed individual row is not a candidate. */
      }
    }
  }
  return result;
}
export function parseTrending(
  raw: unknown,
  interval = "5m",
  now = Date.now(),
): Candidate[] {
  const envelope = record(raw),
    data = record(envelope.data ?? envelope);
  if (typeof record(envelope._gmgnSnapshot).fetchedAt === "number")
    now = Number(record(envelope._gmgnSnapshot).fetchedAt);
  if (envelope.code !== undefined && envelope.code !== 0)
    throw new ProviderFailure("GMGN_TRENDING_RESPONSE_ERROR", "GMGN_TRENDING");
  if (!Array.isArray(data.rank))
    throw new ProviderFailure("GMGN_TRENDING_SCHEMA_INVALID", "GMGN_TRENDING");
  const candidates: Candidate[] = [];
  for (const value of data.rank.slice(0, 100)) {
    const row = record(value);
    try {
      const mint = address(z.string().parse(row.address)),
        created = numberEvidence(row.creation_timestamp);
      const rank =
        typeof row.rank === "number" &&
        Number.isInteger(row.rank) &&
        row.rank > 0
          ? row.rank
          : undefined;
      candidates.push({
        mint,
        symbol: optionalText(row.symbol, 32),
        name: optionalText(row.name),
        logo: normalizeTokenLogo(row.logo),
        source: "gmgn:trending",
        discoveredAt: now,
        createdAt:
          created.state === "KNOWN" && created.value > 0
            ? created.value * 1000
            : undefined,
        listing: {
          ...row,
          logo: normalizeTokenLogo(row.logo),
          price: {
            price: row.price,
            ["volume_" + interval]: row.volume,
            ["buys_" + interval]: row.buys,
            ["sells_" + interval]: row.sells,
          },
        },
        discovery: {
          sources: ["TRENDING"],
          firstSeenAt: now,
          lastSeenAt: now,
          trending: {
            firstSeenAt: now,
            lastSeenAt: now,
            sequenceStartedAt: now,
            consecutiveObservations: 1,
            rank,
            basis: `sol:${interval}:volume:desc:renounced,frozen`,
            history: rank === undefined ? [] : [{ at: now, rank }],
            movement: "UNKNOWN",
          },
        },
      });
    } catch {
      /* malformed individual mint never enters discovery */
    }
  }
  return candidates;
}
export function normalizeMarket(raw: unknown): Market {
  const i = object.parse(raw),
    p = record(i.price),
    pool = record(i.pool);
  const price = numberEvidence(p.price),
    supply = numberEvidence(i.circulating_supply);
  return {
    at:
      typeof record(i._gmgnSnapshot).fetchedAt === "number"
        ? Number(record(i._gmgnSnapshot).fetchedAt)
        : Date.now(),
    price,
    priceUsd: price.state === "KNOWN" ? String(p.price) : undefined,
    decimals:
      typeof i.decimals === "number" &&
      Number.isInteger(i.decimals) &&
      i.decimals >= 0 &&
      i.decimals <= 18
        ? i.decimals
        : undefined,
    liquidity: numberEvidence(i.liquidity ?? pool.liquidity),
    marketCap:
      numberEvidence(i.usd_market_cap ?? i.market_cap).state === "KNOWN"
        ? numberEvidence(i.usd_market_cap ?? i.market_cap)
        : price.state === "KNOWN" && supply.state === "KNOWN"
          ? known(price.value * supply.value)
          : unknown(),
    volume: numberEvidence(p.volume_24h),
    buys: numberEvidence(p.buys_24h),
    sells: numberEvidence(p.sells_24h),
    windows: Object.fromEntries(
      ["1m", "5m", "1h", "6h", "24h"]
        .filter((w) =>
          [
            "price_",
            "volume_",
            "buy_volume_",
            "sell_volume_",
            "buys_",
            "sells_",
          ].some((prefix) => p[prefix + w] !== undefined),
        )
        .map((w) => [
          w,
          {
            startPrice: numberEvidence(p["price_" + w]),
            volume: numberEvidence(p["volume_" + w]),
            buys: numberEvidence(p["buys_" + w]),
            sells: numberEvidence(p["sells_" + w]),
            buyVolume: numberEvidence(p["buy_volume_" + w]),
            sellVolume: numberEvidence(p["sell_volume_" + w]),
          },
        ]),
    ),
  };
}
export function normalizeSecurity(
  raw: unknown,
  c: Candidate,
  s: Settings,
): Security {
  const r = object.parse(raw),
    listing = c.listing ?? {};
  const listingAt = c.discovery?.lastSeenAt ?? c.discoveredAt;
  const endpointAt = Number(record(r._gmgnSnapshot).fetchedAt ?? Date.now());
  const currentListing =
    Date.now() - listingAt >= 0 && Date.now() - listingAt <= s.maxSnapshotAgeMs;
  const mintRenounced = bool(
      r.renounced_mint ?? (currentListing ? listing.renounced_mint : undefined),
    ),
    freezeRenounced = bool(
      r.renounced_freeze_account ??
        (currentListing ? listing.renounced_freeze_account : undefined),
    );
  // A known security endpoint supersedes advisory listing evidence. UNKNOWN
  // cannot erase a still-current listing warning; expired listings authorize nothing.
  const endpointRug = numberEvidence(r.rug_ratio);
  const suppliedRugRatio =
    endpointRug.state === "KNOWN" &&
    endpointRug.value <= 1 &&
    (!currentListing ||
      endpointAt >= listingAt ||
      endpointRug.value >= s.criticalRugRatio)
      ? endpointRug
      : currentListing
        ? numberEvidence(listing.rug_ratio)
        : unknown<number>("Listing rug evidence has expired");
  const rugRatio =
    suppliedRugRatio.state === "KNOWN" && suppliedRugRatio.value <= 1
      ? suppliedRugRatio
      : unknown<number>("GMGN rug-risk ratio is unavailable");
  const findings: Security["findings"] = [];
  for (const [code, evidence, label] of [
    ["MINT_CONTROL", mintRenounced, "mint supply"],
    ["FREEZE_CONTROL", freezeRenounced, "token transfers"],
  ] as const) {
    if (evidence.state === "KNOWN" && !evidence.value)
      findings.push({
        level: "CRITICAL",
        code,
        reason: `GMGN reports active control over ${label}`,
      });
    else if (evidence.state === "UNKNOWN")
      findings.push({
        level: "UNKNOWN",
        code,
        reason: `GMGN has not verified control over ${label}`,
      });
  }
  // Solana's null/empty honeypot field is explicitly not applicable in the installed skill.
  if (
    [r.is_honeypot, r.honeypot, r.can_not_sell].some((v) =>
      [true, 1, "1", "true", "yes"].includes(v as string | number | boolean),
    )
  )
    findings.push({
      level: "CRITICAL",
      code: "HONEYPOT_REPORTED",
      reason: "GMGN explicitly reports an inability to sell",
    });
  if (rugRatio.state === "KNOWN" && rugRatio.value <= 1) {
    if (rugRatio.value >= s.criticalRugRatio)
      findings.push({
        level: "CRITICAL",
        code: "GMGN_RUG_RISK",
        reason: "GMGN rug-risk label exceeds the configured critical threshold",
      });
    else if (rugRatio.value > s.warningRugRatio)
      findings.push({
        level: "WARNING",
        code: "GMGN_RUG_WARNING",
        reason: "GMGN reports elevated rug risk",
      });
  }
  for (const field of ["buy_tax", "sell_tax"]) {
    const tax = percent(r[field]);
    if (tax.state === "KNOWN" && tax.value > s.maxTaxPercent)
      findings.push({
        level: "CRITICAL",
        code: "EXCESSIVE_TAX",
        reason: `GMGN ${field} exceeds the configured tax limit`,
      });
  }
  const safe = Object.fromEntries(
    [
      "renounced_mint",
      "renounced_freeze_account",
      "is_honeypot",
      "rug_ratio",
      "buy_tax",
      "sell_tax",
      "top_10_holder_rate",
      "creator_balance_rate",
      "dev_team_hold_rate",
      "burn_status",
      "is_wash_trading",
    ]
      .filter((k) => r[k] !== undefined)
      .map((k) => [k, r[k]]),
  );
  return {
    at:
      typeof record(r._gmgnSnapshot).fetchedAt === "number"
        ? Number(record(r._gmgnSnapshot).fetchedAt)
        : Date.now(),
    findings,
    mintRenounced,
    freezeRenounced,
    rugRatio,
    raw: {
      ...safe,
      rugEvidence: {
        source: suppliedRugRatio === endpointRug ? "token-security" : "listing",
        fetchedAt:
          suppliedRugRatio === endpointRug
            ? Number(record(r._gmgnSnapshot).fetchedAt ?? Date.now())
            : listingAt,
        policy:
          "KNOWN_ENDPOINT_SUPERSEDES_LISTING_UNKNOWN_RETAINS_CURRENT_WARNING",
      },
    },
  };
}
