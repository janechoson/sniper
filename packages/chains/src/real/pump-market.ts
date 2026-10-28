import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { z } from "zod";
import type {
  Decision,
  NormalizedTokenState,
  TokenDiscoveryEvent,
} from "@sniper/core";
import type { DexDeploymentConfig, TrustedQuoteAsset } from "@sniper/config";
import { ratioToNumber } from "@sniper/shared";
import { JsonRpcClient } from "../rpc/http";
import { accountInfo, solanaAccountSchema } from "../security/solana";
import { loadVerifiedIdl } from "./idl";
import { curvePda, pumpPoolPda, WSOL, type PumpFamily } from "./pump-discovery";
import type { QuoteUsdPriceProvider } from "./prices";
import { RollingMarketBook } from "./market";
type Account = z.infer<typeof solanaAccountSchema>;
type Inspection = {
  market: NormalizedTokenState["market"];
  protocol: Record<string, string | boolean>;
  active: boolean;
  creator?: string;
};
function readAccount(
  idl: Idl,
  name: string,
  minimumThrough: string,
  bytes: Buffer,
): Record<string, unknown> {
  const prefix = structuredClone(idl),
    type = prefix.types!.find((type) => type.name === name)!;
  if (type.type.kind !== "struct" || !type.type.fields)
    throw new Error("PUMP_ACCOUNT_LAYOUT_UNSUPPORTED");
  const last = type.type.fields.findIndex(
    (field) =>
      typeof field === "object" &&
      field !== null &&
      "name" in field &&
      field.name === minimumThrough,
  );
  if (last < 0) throw new Error("PUMP_ACCOUNT_LAYOUT_UNSUPPORTED");
  type.type.fields = type.type.fields.slice(0, last + 1);
  const minimum = new BorshAccountsCoder(prefix).size(name),
    coder = new BorshAccountsCoder(idl);
  if (bytes.length < minimum) throw new Error("PUMP_ACCOUNT_TRUNCATED");
  const padded = Buffer.alloc(Math.max(bytes.length, coder.size(name)));
  bytes.copy(padded);
  return coder.decode(name, padded) as Record<string, unknown>;
}
const rawInt = (data: Record<string, unknown>, field: string) => {
  const value = data[field];
  if (!value || typeof value !== "object" || !("toString" in value))
    throw new Error("PUMP_RESERVES_INVALID");
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new Error("PUMP_RESERVES_INVALID");
  return BigInt(text);
};
const key = (data: Record<string, unknown>, field: string) => {
  const value = data[field];
  if (!(value instanceof PublicKey))
    throw new Error("PUMP_ACCOUNT_IDENTITY_INVALID");
  return value.toBase58();
};
function tokenAccount(
  address: string,
  value: Account,
  mint: string,
  owner: string,
) {
  if (
    ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(
      value.owner,
    )
  )
    throw new Error("PUMP_TOKEN_PROGRAM_MISMATCH");
  const decoded = unpackAccount(
    new PublicKey(address),
    accountInfo(value),
    new PublicKey(value.owner),
  );
  if (
    !decoded.isInitialized ||
    decoded.isFrozen ||
    decoded.mint.toBase58() !== mint ||
    decoded.owner.toBase58() !== owner
  )
    throw new Error("PUMP_VAULT_IDENTITY_MISMATCH");
  if (
    address !==
    getAssociatedTokenAddressSync(
      new PublicKey(mint),
      new PublicKey(owner),
      true,
      new PublicKey(value.owner),
    ).toBase58()
  )
    throw new Error("PUMP_VAULT_IDENTITY_MISMATCH");
  return decoded.amount;
}
export class PumpMarketReader {
  private readonly cache = new Map<
    string,
    { at: number; work: Promise<Inspection> }
  >();
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly quotes: TrustedQuoteAsset[],
    private readonly book: RollingMarketBook,
    private readonly prices?: QuoteUsdPriceProvider,
  ) {}
  async guard(
    event: TokenDiscoveryEvent,
    deployment: DexDeploymentConfig,
  ): Promise<Decision & { latencyMs: number }> {
    const start = Date.now();
    if (event.pairClassification !== "TRUSTED_QUOTE")
      return {
        passed: false,
        reasons: ["UNTRUSTED_QUOTE"],
        latencyMs: Date.now() - start,
      };
    try {
      const inspected = await this.inspect(event, deployment);
      const reasons = !inspected.active
        ? ["NO_TRADING_ROUTE"]
        : inspected.market.priceUsd === undefined ||
            inspected.market.liquidityUsd === undefined
          ? ["INSUFFICIENT_MARKET_DATA"]
          : [];
      return {
        passed: reasons.length === 0,
        reasons,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      const reason =
        error instanceof Error && /^PUMP_[A-Z_]+$/.test(error.message)
          ? error.message
          : "DISCOVERY_DATA_UNAVAILABLE";
      return {
        passed: false,
        reasons: [reason],
        latencyMs: Date.now() - start,
      };
    }
  }
  async market(event: TokenDiscoveryEvent, deployment: DexDeploymentConfig) {
    return (await this.inspect(event, deployment)).market;
  }
  async protocol(event: TokenDiscoveryEvent, deployment: DexDeploymentConfig) {
    return (await this.inspect(event, deployment)).protocol;
  }
  private inspect(event: TokenDiscoveryEvent, deployment: DexDeploymentConfig) {
    const cached = this.cache.get(event.id);
    if (cached && Date.now() - cached.at < 3000) return cached.work;
    const work = this.load(event, deployment);
    this.cache.set(event.id, { at: Date.now(), work });
    if (this.cache.size > 256)
      this.cache.delete(this.cache.keys().next().value!);
    void work.catch(() => {
      if (this.cache.get(event.id)?.work === work) this.cache.delete(event.id);
    });
    return work;
  }
  private async load(
    event: TokenDiscoveryEvent,
    deployment: DexDeploymentConfig,
  ): Promise<Inspection> {
    const family = deployment.family as PumpFamily;
    const idl = loadVerifiedIdl(family).idl;
    if (idl.address !== deployment.programId)
      throw new Error("PUMP_PROGRAM_IDENTITY_MISMATCH");
    const batch = await this.rpc.request(
      "getMultipleAccounts",
      [
        [event.poolAddress, event.tokenAddress],
        { encoding: "base64", commitment: "confirmed" },
      ],
      z.object({
        context: z.object({ slot: z.number().int() }),
        value: z.array(solanaAccountSchema.nullable()).length(2),
      }),
    );
    const [pool, mintInfo] = batch.value;
    if (!pool || pool.owner !== idl.address || pool.executable)
      throw new Error("PUMP_POOL_OWNER_MISMATCH");
    if (
      !mintInfo ||
      ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(
        mintInfo.owner,
      )
    )
      throw new Error("PUMP_INVALID_MINT");
    const mint = unpackMint(
      new PublicKey(event.tokenAddress),
      accountInfo(mintInfo),
      new PublicKey(mintInfo.owner),
    );
    const declared = z
      .object({ tokenProgram: z.string().optional() })
      .safeParse(event.rawEvent);
    if (
      declared.success &&
      declared.data.tokenProgram &&
      declared.data.tokenProgram !== mintInfo.owner
    )
      throw new Error("PUMP_TOKEN_PROGRAM_MISMATCH");
    if (!mint.isInitialized || mint.supply === 0n)
      throw new Error("PUMP_INVALID_MINT");
    const name = family === "pump-fun" ? "BondingCurve" : "Pool";
    const data = readAccount(
      idl,
      name,
      family === "pump-fun" ? "complete" : "lp_supply",
      Buffer.from(pool.data[0], "base64"),
    );
    let baseReserve: bigint,
      quoteReserve: bigint,
      realBase: bigint,
      realQuote: bigint,
      quoteMint: string,
      active = true;
    const protocol: Record<string, string | boolean> = {
      family,
      slot: String(batch.context.slot),
      tokenSupply: mint.supply.toString(),
      tokenProgram: mintInfo.owner,
    };
    if (family === "pump-fun") {
      if (event.poolAddress !== curvePda(event.tokenAddress, idl.address))
        throw new Error("PUMP_CURVE_IDENTITY_MISMATCH");
      quoteMint = key(data, "quote_mint");
      if (quoteMint === PublicKey.default.toBase58()) quoteMint = WSOL;
      if (typeof data.complete !== "boolean")
        throw new Error("PUMP_CURVE_STATE_INVALID");
      active = !data.complete;
      baseReserve = rawInt(data, "virtual_token_reserves");
      quoteReserve = rawInt(data, "virtual_quote_reserves");
      realBase = rawInt(data, "real_token_reserves");
      realQuote = rawInt(data, "real_quote_reserves");
      protocol.complete = data.complete;
      protocol.virtualTokenReserves = baseReserve.toString();
      protocol.virtualQuoteReserves = quoteReserve.toString();
      protocol.realTokenReserves = realBase.toString();
      protocol.realQuoteReserves = realQuote.toString();
      protocol.creator = key(data, "creator");
      active = active && realQuote > 0n && realBase > 0n;
    } else {
      const base = key(data, "base_mint"),
        quote = key(data, "quote_mint"),
        creator = key(data, "creator");
      if (
        base !== event.tokenAddress ||
        typeof data.index !== "number" ||
        event.poolAddress !==
          pumpPoolPda(data.index, creator, base, quote, idl.address)
      )
        throw new Error("PUMP_POOL_IDENTITY_MISMATCH");
      quoteMint = quote;
      const vaultA = key(data, "pool_base_token_account"),
        vaultB = key(data, "pool_quote_token_account");
      const vaults = await this.rpc.request(
        "getMultipleAccounts",
        [
          [vaultA, vaultB],
          {
            encoding: "base64",
            commitment: "confirmed",
            minContextSlot: batch.context.slot,
          },
        ],
        z.object({ value: z.array(solanaAccountSchema.nullable()).length(2) }),
      );
      if (!vaults.value[0] || !vaults.value[1])
        throw new Error("PUMP_VAULT_UNAVAILABLE");
      if (vaults.value[0].owner !== mintInfo.owner)
        throw new Error("PUMP_TOKEN_PROGRAM_MISMATCH");
      baseReserve = tokenAccount(
        vaultA,
        vaults.value[0],
        base,
        event.poolAddress,
      );
      const amount = tokenAccount(
        vaultB,
        vaults.value[1],
        quote,
        event.poolAddress,
      );
      const virtual = rawInt(data, "virtual_quote_reserves");
      quoteReserve = amount + virtual;
      realBase = baseReserve;
      realQuote =
        amount - rawInt(data, "protocol_fees") - rawInt(data, "creator_fees");
      protocol.virtualQuoteReserves = virtual.toString();
      protocol.effectiveQuoteReserves = quoteReserve.toString();
      protocol.realQuoteReserves = realQuote.toString();
      protocol.creator = creator;
      active = baseReserve > 0n && quoteReserve > 0n;
    }
    if (quoteMint !== event.quoteTokenAddress)
      throw new Error("PUMP_QUOTE_MISMATCH");
    if (
      baseReserve <= 0n ||
      quoteReserve < 0n ||
      realBase < 0n ||
      realQuote < 0n
    )
      throw new Error("PUMP_RESERVES_INVALID");
    const asset = this.quotes.find((asset) => asset.address === quoteMint);
    const priced =
      asset && this.prices
        ? await this.prices.resolve(event.chainId, asset)
        : asset;
    const usd =
      priced?.usdPrice !== undefined &&
      priced.priceSource &&
      priced.priceVerifiedAt !== undefined &&
      Date.now() - priced.priceVerifiedAt <= 60000
        ? Number(priced.usdPrice)
        : undefined;
    if (!asset || usd === undefined || !Number.isFinite(usd) || usd <= 0)
      return { market: {}, protocol, active };
    const scaled = ratioToNumber(
      quoteReserve * 10n ** BigInt(mint.decimals),
      baseReserve * 10n ** BigInt(asset.decimals),
    );
    const priceUsd = scaled === undefined ? undefined : scaled * usd;
    // Inventory thực, không cộng dự trữ ảo/boost vào thanh khoản có thể rút.
    const realQuoteUnits = ratioToNumber(
        realQuote,
        10n ** BigInt(asset.decimals),
      ),
      realBaseUnits = ratioToNumber(realBase, 10n ** BigInt(mint.decimals));
    const liquidityUsd =
      priceUsd === undefined ||
      realQuoteUnits === undefined ||
      realBaseUnits === undefined
        ? undefined
        : realQuoteUnits * usd + realBaseUnits * priceUsd;
    if (priceUsd !== undefined && (!Number.isFinite(priceUsd) || priceUsd < 0))
      throw new Error("PUMP_PRICE_INVALID");
    this.book.invalidateStream(event.id);
    this.book.observe(event.id, { at: Date.now(), priceUsd, liquidityUsd });
    return {
      market: { ...this.book.features(event.id), priceUsd, liquidityUsd },
      protocol,
      active,
    };
  }
}
