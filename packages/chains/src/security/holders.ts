import { PublicKey } from "@solana/web3.js";
import {
  unpackAccount,
  unpackMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { z } from "zod";
import type { HolderAnalysis } from "@sniper/core";
import { ratioToNumber } from "@sniper/shared";
import type { JsonRpcClient } from "../rpc/http";
import {
  SolanaTokenAnalyzer,
  solanaAccountSchema,
  accountInfo,
} from "./solana";
export class RpcHolderDataProvider {
  private distributions = new Map<
    string,
    {
      supply: string;
      holders: { address: string; amount: string }[];
      slot: number;
      observedAt: string;
    }
  >();
  async getVerifiedDistribution(chainId: string, tokenAddress: string) {
    await this.getHolderAnalysis(chainId, tokenAddress);
    return this.distributions.get(`${chainId}:${tokenAddress}`);
  }
  constructor(
    private readonly chains: Map<
      string,
      {
        type: "evm" | "solana";
        rpc: JsonRpcClient;
        solana?: SolanaTokenAnalyzer;
      }
    >,
  ) {}
  async getHolderAnalysis(
    chainId: string,
    tokenAddress: string,
  ): Promise<HolderAnalysis> {
    this.distributions.delete(`${chainId}:${tokenAddress}`);
    const chain = this.chains.get(chainId);
    if (chain?.type !== "solana" || !chain.solana) return {};
    const { info } = await chain.solana.analyze(tokenAddress);
    if (info.totalSupply === undefined) return {};
    let supply = BigInt(info.totalSupply);
    if (supply <= 0n) return {};
    const result = await chain.rpc.request(
      "getTokenLargestAccounts",
      [tokenAddress, { commitment: "confirmed" }],
      z.object({
        context: z.object({ slot: z.number() }),
        value: z
          .array(
            z.object({
              address: z.string(),
              amount: z.string().regex(/^\d+$/),
              decimals: z.number().int(),
            }),
          )
          .max(20),
      }),
    );
    if (
      new Set(result.value.map((holder) => holder.address)).size !==
      result.value.length
    )
      return {};
    if (
      result.value.reduce((sum, holder) => sum + BigInt(holder.amount), 0n) !==
      supply
    )
      return {};
    const accounts = await chain.rpc.request(
      "getMultipleAccounts",
      [
        [tokenAddress, ...result.value.map((holder) => holder.address)],
        {
          encoding: "base64",
          commitment: "confirmed",
          minContextSlot: result.context.slot,
        },
      ],
      z.object({
        context: z.object({ slot: z.number() }),
        value: z.array(solanaAccountSchema.nullable()).max(21),
      }),
    );
    if (
      accounts.value.length !== result.value.length + 1 ||
      accounts.context.slot !== result.context.slot
    )
      return {};
    const mintValue = accounts.value.shift();
    if (!mintValue) return {};
    const mintOwner = new PublicKey(mintValue.owner);
    if (
      !mintOwner.equals(TOKEN_PROGRAM_ID) &&
      !mintOwner.equals(TOKEN_2022_PROGRAM_ID)
    )
      return {};
    const mint = unpackMint(
      new PublicKey(tokenAddress),
      accountInfo(mintValue),
      mintOwner,
    );
    supply = mint.supply;
    if (
      supply <= 0n ||
      result.value.reduce((sum, row) => sum + BigInt(row.amount), 0n) !== supply
    )
      return {};
    const holders = new Map<string, bigint>();
    let total = 0n;
    for (let i = 0; i < accounts.value.length; i++) {
      const value = accounts.value[i];
      if (!value) return {};
      const owner = new PublicKey(value.owner);
      if (
        !owner.equals(TOKEN_PROGRAM_ID) &&
        !owner.equals(TOKEN_2022_PROGRAM_ID)
      )
        return {};
      const account = unpackAccount(
        new PublicKey(result.value[i]!.address),
        accountInfo(value),
        owner,
      );
      if (account.mint.toBase58() !== tokenAddress) return {};
      total += account.amount;
      holders.set(
        account.owner.toBase58(),
        (holders.get(account.owner.toBase58()) ?? 0n) + account.amount,
      );
    }
    if (total !== supply) return {};
    if (this.distributions.size >= 300)
      this.distributions.delete(this.distributions.keys().next().value!);
    this.distributions.set(`${chainId}:${tokenAddress}`, {
      supply: supply.toString(),
      holders: [...holders].map(([address, amount]) => ({
        address,
        amount: amount.toString(),
      })),
      slot: accounts.context.slot,
      observedAt: new Date().toISOString(),
    });
    const amounts = [...holders.values()]
      .filter((value) => value > 0n)
      .sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));
    const top = (count: number) =>
      ratioToNumber(
        amounts.slice(0, count).reduce((a, b) => a + b, 0n) * 100n,
        supply,
      );
    return {
      count: amounts.length,
      top1Pct: top(1),
      top5Pct: top(5),
      top10Pct: top(10),
    };
  }
}
