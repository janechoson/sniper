import anchor, { BorshAccountsCoder } from "@coral-xyz/anchor";
type BN = import("@coral-xyz/anchor").BN;
const BN = anchor.BN;
import { PublicKey } from "@solana/web3.js";
import {
  unpackAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { z } from "zod";
import type { NormalizedTokenState, TokenDiscoveryEvent } from "@sniper/core";
import type { DexDeploymentConfig, TrustedQuoteAsset } from "@sniper/config";
import { parseUnitsSafe, ratioToNumber, toDisplayNumber } from "@sniper/shared";
import { JsonRpcClient } from "../rpc/http";
import {
  solanaAccountSchema,
  accountInfo,
  SolanaTokenAnalyzer,
} from "../security/solana";
import { RollingMarketBook } from "./market";
import type { QuoteUsdPriceProvider } from "./prices";
import { loadVerifiedIdl } from "./idl";
const key = z.custom<PublicKey>((v) => v instanceof PublicKey);
const bn = z.custom<BN>((v) => BN.isBN(v));
export class SolanaPoolMarketReader {
  private readonly coder: BorshAccountsCoder;
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly analyzer: SolanaTokenAnalyzer,
    private readonly deployment: DexDeploymentConfig,
    private readonly quotes: TrustedQuoteAsset[],
    private readonly book: RollingMarketBook,
    private readonly prices?: QuoteUsdPriceProvider,
  ) {
    if (
      deployment.family !== "raydium-cpmm" &&
      deployment.family !== "meteora-dlmm"
    )
      throw new Error("POOL_LAYOUT_UNSUPPORTED");
    const idl = loadVerifiedIdl(deployment.family).idl;
    if (idl.address !== deployment.programId)
      throw new Error("IDL_PROGRAM_MISMATCH");
    this.coder = new BorshAccountsCoder(idl);
  }
  async refresh(
    event: TokenDiscoveryEvent,
  ): Promise<NormalizedTokenState["market"]> {
    const response = await this.rpc.request(
      "getAccountInfo",
      [event.poolAddress, { encoding: "base64", commitment: "confirmed" }],
      z.object({ value: solanaAccountSchema.nullable() }),
    );
    if (!response.value || response.value.owner !== this.deployment.programId)
      throw new Error("POOL_OWNER_MISMATCH");
    const isCpmm = this.deployment.family === "raydium-cpmm";
    const raw: unknown = this.coder.decode(
      isCpmm ? "PoolState" : "LbPair",
      Buffer.from(response.value.data[0], "base64"),
    );
    let mintA: string,
      mintB: string,
      vaultA: string,
      vaultB: string,
      feeA = 0n,
      feeB = 0n,
      binPrice: number | undefined;
    if (isCpmm) {
      const value = z
        .object({
          token_0_mint: key,
          token_1_mint: key,
          token_0_vault: key,
          token_1_vault: key,
          protocol_fees_token_0: bn,
          protocol_fees_token_1: bn,
          fund_fees_token_0: bn,
          fund_fees_token_1: bn,
          creator_fees_token_0: bn,
          creator_fees_token_1: bn,
        })
        .parse(raw);
      mintA = value.token_0_mint.toBase58();
      mintB = value.token_1_mint.toBase58();
      vaultA = value.token_0_vault.toBase58();
      vaultB = value.token_1_vault.toBase58();
      feeA =
        BigInt(value.protocol_fees_token_0.toString()) +
        BigInt(value.fund_fees_token_0.toString()) +
        BigInt(value.creator_fees_token_0.toString());
      feeB =
        BigInt(value.protocol_fees_token_1.toString()) +
        BigInt(value.fund_fees_token_1.toString()) +
        BigInt(value.creator_fees_token_1.toString());
    } else {
      const value = z
        .object({
          token_x_mint: key,
          token_y_mint: key,
          reserve_x: key,
          reserve_y: key,
          active_id: z.number().int(),
          bin_step: z.number().int().positive(),
        })
        .parse(raw);
      mintA = value.token_x_mint.toBase58();
      mintB = value.token_y_mint.toBase58();
      vaultA = value.reserve_x.toBase58();
      vaultB = value.reserve_y.toBase58();
      binPrice = (1 + value.bin_step / 10000) ** value.active_id;
    }
    if (event.tokenAddress !== mintA && event.tokenAddress !== mintB)
      throw new Error("POOL_TOKEN_MISMATCH");
    const isA = event.tokenAddress === mintA;
    const configuredQuote = this.quotes.find(
      (q) => q.address === (isA ? mintB : mintA),
    );
    const quote =
      configuredQuote && this.prices
        ? await this.prices.resolve(event.chainId, configuredQuote)
        : configuredQuote;
    if (
      !quote?.usdPrice ||
      !quote.priceSource ||
      quote.priceVerifiedAt === undefined ||
      Date.now() - quote.priceVerifiedAt > 60000
    )
      return {};
    const [token, accounts] = await Promise.all([
      this.analyzer.analyze(event.tokenAddress),
      this.rpc.request(
        "getMultipleAccounts",
        [[vaultA, vaultB], { encoding: "base64", commitment: "confirmed" }],
        z.object({ value: z.array(solanaAccountSchema.nullable()).length(2) }),
      ),
    ]);
    if (
      token.info.decimals === undefined ||
      accounts.value.some((v) => v === null)
    )
      return {};
    const balances = accounts.value.map((value, index) => {
      const account = value!;
      const program = new PublicKey(account.owner);
      if (
        !program.equals(TOKEN_PROGRAM_ID) &&
        !program.equals(TOKEN_2022_PROGRAM_ID)
      )
        throw new Error("VAULT_TOKEN_PROGRAM_MISMATCH");
      const decoded = unpackAccount(
        new PublicKey(index === 0 ? vaultA : vaultB),
        accountInfo(account),
        program,
      );
      if (decoded.mint.toBase58() !== (index === 0 ? mintA : mintB))
        throw new Error("VAULT_MINT_MISMATCH");
      return decoded.amount;
    });
    const reserveA = balances[0]! - feeA,
      reserveB = balances[1]! - feeB;
    if (reserveA <= 0n || reserveB <= 0n) return {};
    const quoteUsd = toDisplayNumber(parseUnitsSafe(quote.usdPrice, 18), 18);
    if (quoteUsd === undefined) return {};
    let price: number | undefined, liquidity: number | undefined;
    if (isCpmm) {
      price = ratioToNumber(
        (isA ? reserveB : reserveA) *
          10n ** BigInt(token.info.decimals) *
          parseUnitsSafe(quote.usdPrice, 18),
        (isA ? reserveA : reserveB) *
          10n ** BigInt(quote.decimals) *
          10n ** 18n,
      );
      liquidity = toDisplayNumber(
        (isA ? reserveB : reserveA) * 2n * parseUnitsSafe(quote.usdPrice, 18),
        quote.decimals + 18,
      );
    } else if (
      binPrice !== undefined &&
      Number.isFinite(binPrice) &&
      binPrice > 0
    ) {
      const decimalsA = isA ? token.info.decimals : quote.decimals,
        decimalsB = isA ? quote.decimals : token.info.decimals;
      const xyPrice = binPrice * 10 ** (decimalsA - decimalsB);
      price = (isA ? xyPrice : 1 / xyPrice) * quoteUsd;
      const tokenQuantity = toDisplayNumber(
          isA ? reserveA : reserveB,
          token.info.decimals,
        ),
        quoteQuantity = toDisplayNumber(
          isA ? reserveB : reserveA,
          quote.decimals,
        );
      if (tokenQuantity !== undefined && quoteQuantity !== undefined)
        liquidity = tokenQuantity * price + quoteQuantity * quoteUsd;
    }
    if (price !== undefined && !Number.isFinite(price)) price = undefined;
    if (liquidity !== undefined && !Number.isFinite(liquidity))
      liquidity = undefined;
    this.book.observe(event.id, {
      at: Date.now(),
      priceUsd: price,
      liquidityUsd: liquidity,
    });
    return this.book.features(event.id);
  }
}
