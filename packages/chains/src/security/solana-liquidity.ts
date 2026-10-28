import anchor, { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  unpackAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { z } from "zod";
import type {
  TokenSecurityProvider,
  TokenSecurityRequest,
  TokenSecurityProviderResult,
  SecurityEvidence,
} from "@sniper/core";
import type { DexDeploymentConfig } from "@sniper/config";
import { ratioToNumber } from "@sniper/shared";
import { JsonRpcClient } from "../rpc/http";
import { loadVerifiedIdl } from "../real/idl";
import { accountInfo, solanaAccountSchema } from "./solana";
import { rpcEvidence } from "./evidence";
import type { RpcHolderDataProvider } from "./holders";
const key = z.custom<PublicKey>((v) => v instanceof PublicKey),
  bn = z.custom<import("@coral-xyz/anchor").BN>((v) => anchor.BN.isBN(v));
const cpmm = z.object({
  token_0_mint: key,
  token_1_mint: key,
  token_0_vault: key,
  token_1_vault: key,
  lp_mint: key,
  pool_creator: key,
  status: z.number().int(),
  protocol_fees_token_0: bn,
  protocol_fees_token_1: bn,
  fund_fees_token_0: bn,
  fund_fees_token_1: bn,
  creator_fees_token_0: bn,
  creator_fees_token_1: bn,
});
const dlmm = z.object({
  token_x_mint: key,
  token_y_mint: key,
  reserve_x: key,
  reserve_y: key,
});
export class SolanaLiquiditySecurityProvider implements TokenSecurityProvider {
  readonly id = "solana-liquidity";
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly deployments: DexDeploymentConfig[],
    private readonly holders: RpcHolderDataProvider,
  ) {}
  supports(chainId: string) {
    return (
      chainId === "solana" &&
      this.deployments.some(
        (d) =>
          d.enabled &&
          d.chainId === "solana" &&
          ["raydium-cpmm", "meteora-dlmm"].includes(d.family),
      )
    );
  }
  async healthCheck() {
    return {
      id: this.id,
      status: "READY" as const,
      reasons: [],
      checkedAt: Date.now(),
    };
  }
  async analyze(
    request: TokenSecurityRequest,
  ): Promise<TokenSecurityProviderResult> {
    const begin = Date.now(),
      result: TokenSecurityProviderResult = {
        provider: this.id,
        chainId: request.chainId,
        tokenAddress: request.tokenAddress,
        status: "OK",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        findings: [],
      };
    if (!request.poolAddress) return result;
    const first = await this.rpc.request(
      "getAccountInfo",
      [request.poolAddress, { encoding: "base64", commitment: "confirmed" }],
      z.object({
        context: z.object({ slot: z.number().int() }),
        value: solanaAccountSchema.nullable(),
      }),
    );
    const deployment = this.deployments.find(
      (d) =>
        d.enabled &&
        d.chainId === request.chainId &&
        d.programId === first.value?.owner &&
        ["raydium-cpmm", "meteora-dlmm"].includes(d.family),
    );
    if (
      !first.value ||
      !deployment ||
      (deployment.family !== "raydium-cpmm" &&
        deployment.family !== "meteora-dlmm")
    )
      return result;
    const { idl } = loadVerifiedIdl(deployment.family);
    if (idl.address !== deployment.programId)
      throw new Error("POOL_PROGRAM_IDENTITY_MISMATCH");
    const coder = new BorshAccountsCoder(idl),
      isCpmm = deployment.family === "raydium-cpmm";
    const decode = (bytes: Buffer) =>
      isCpmm
        ? cpmm.parse(coder.decode("PoolState", bytes))
        : dlmm.parse(coder.decode("LbPair", bytes));
    const initial = decode(Buffer.from(first.value.data[0], "base64"));
    const vaults =
      "token_0_vault" in initial
        ? [initial.token_0_vault, initial.token_1_vault]
        : [initial.reserve_x, initial.reserve_y];
    const accounts = await this.rpc.request(
      "getMultipleAccounts",
      [
        [request.poolAddress, ...vaults.map((v) => v.toBase58())],
        {
          encoding: "base64",
          commitment: "confirmed",
          minContextSlot: first.context.slot,
        },
      ],
      z.object({
        context: z.object({ slot: z.number().int() }),
        value: z.array(solanaAccountSchema.nullable()).length(3),
      }),
    );
    const pool = accounts.value[0];
    if (!pool || pool.owner !== deployment.programId)
      throw new Error("POOL_OWNER_CHANGED");
    const current = decode(Buffer.from(pool.data[0], "base64"));
    const currentVaults =
      "token_0_vault" in current
        ? [current.token_0_vault, current.token_1_vault]
        : [current.reserve_x, current.reserve_y];
    if (currentVaults.some((v, i) => !v.equals(vaults[i]!)))
      throw new Error("POOL_VAULT_CHANGED");
    const mints =
      "token_0_mint" in current
        ? [current.token_0_mint, current.token_1_mint]
        : [current.token_x_mint, current.token_y_mint];
    if (!mints.some((m) => m.toBase58() === request.tokenAddress))
      throw new Error("POOL_TOKEN_MISMATCH");
    const amounts = accounts.value.slice(1).map((value, i) => {
      if (!value) throw new Error("VAULT_MISSING");
      const program = new PublicKey(value.owner);
      if (
        !program.equals(TOKEN_PROGRAM_ID) &&
        !program.equals(TOKEN_2022_PROGRAM_ID)
      )
        throw new Error("VAULT_PROGRAM_INVALID");
      const account = unpackAccount(vaults[i]!, accountInfo(value), program);
      if (!account.mint.equals(mints[i]!))
        throw new Error("VAULT_MINT_INVALID");
      return account.amount;
    });
    if ("token_0_mint" in current) {
      amounts[0] =
        amounts[0]! -
        BigInt(current.protocol_fees_token_0.toString()) -
        BigInt(current.fund_fees_token_0.toString()) -
        BigInt(current.creator_fees_token_0.toString());
      amounts[1] =
        amounts[1]! -
        BigInt(current.protocol_fees_token_1.toString()) -
        BigInt(current.fund_fees_token_1.toString()) -
        BigInt(current.creator_fees_token_1.toString());
    }
    if (amounts.some((v) => v < 0n))
      throw new Error("POOL_FEES_EXCEED_INVENTORY");
    const add = (
      section: "liquidity" | "trading",
      field: string,
      value: SecurityEvidence["value"],
      state: SecurityEvidence["state"] = "SAFE",
    ) =>
      result.findings.push({
        section,
        field,
        evidence: rpcEvidence(
          value,
          state,
          `${deployment.family}; slot=${accounts.context.slot}; pool=${request.poolAddress}`,
        ),
      });
    const base = mints[0]!.toBase58() === request.tokenAddress ? 0 : 1;
    add("liquidity", "baseAmount", amounts[base]!.toString());
    add("liquidity", "quoteAmount", amounts[base === 0 ? 1 : 0]!.toString());
    if ("lp_mint" in current) {
      add("liquidity", "lpOwnership", current.lp_mint.toBase58());
      if ((current.status & 4) !== 0)
        add("trading", "sellRestriction", true, "RISK");
      const distribution = await this.holders.getVerifiedDistribution(
        request.chainId,
        current.lp_mint.toBase58(),
      );
      if (distribution) {
        const total = BigInt(distribution.supply),
          largest = distribution.holders.reduce(
            (max, h) => (BigInt(h.amount) > max ? BigInt(h.amount) : max),
            0n,
          ),
          creator = distribution.holders
            .filter((h) => h.address === current.pool_creator.toBase58())
            .reduce((sum, h) => sum + BigInt(h.amount), 0n);
        const pct = ratioToNumber(largest * 100n, total),
          creatorPct = ratioToNumber(creator * 100n, total);
        if (pct !== undefined) add("liquidity", "lpConcentrationPct", pct);
        if (creatorPct !== undefined)
          add(
            "liquidity",
            "creatorLpPct",
            creatorPct,
            creatorPct > 0 ? "RISK" : "SAFE",
          );
      }
    }
    result.latencyMs = Date.now() - begin;
    return result;
  }
}
