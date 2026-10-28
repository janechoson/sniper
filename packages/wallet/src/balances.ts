import { z } from "zod";
import { encodeFunctionData, parseAbi, isAddress, type Address } from "viem";
import type { PublicWallet, WalletBalance } from "@sniper/core";
import { JsonRpcClient, hexSchema } from "@sniper/chains";
import type { WalletBalanceReader } from "./local";
const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
export class RpcWalletBalanceReader implements WalletBalanceReader {
  constructor(private readonly clients: Map<string, JsonRpcClient>) {}
  async read(
    wallet: PublicWallet,
    chainId: string,
    tokens: { address: string; decimals: number }[] = [],
  ): Promise<WalletBalance> {
    if (!wallet.chains.includes(chainId) || tokens.length > 100)
      throw new Error("BALANCE_REQUEST_NOT_ALLOWED");
    const rpc = this.clients.get(chainId);
    if (!rpc) throw new Error("RPC_UNAVAILABLE");
    const at = Date.now();
    if (wallet.family === "evm") {
      if (!isAddress(wallet.address)) throw new Error("WALLET_ADDRESS_INVALID");
      const native = BigInt(
        await rpc.request(
          "eth_getBalance",
          [wallet.address, "latest"],
          hexSchema,
        ),
      );
      const balances = await Promise.all(
        tokens.map(async (token) => {
          if (!isAddress(token.address))
            throw new Error("TOKEN_ADDRESS_INVALID");
          const data = encodeFunctionData({
            abi,
            functionName: "balanceOf",
            args: [wallet.address as Address],
          });
          const amount = BigInt(
            await rpc.request(
              "eth_call",
              [{ to: token.address, data }, "latest"],
              hexSchema,
            ),
          );
          return { ...token, amount: amount.toString() };
        }),
      );
      return {
        walletId: wallet.id,
        chainId,
        nativeAmount: native.toString(),
        nativeDecimals: 18,
        tokens: balances,
        observedAt: at,
        quality: "REAL",
      };
    }
    const native = await rpc.request(
      "getBalance",
      [wallet.address, { commitment: "confirmed" }],
      z.object({
        value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    );
    const balances = await Promise.all(
      tokens.map(async (token) => {
        const result = await rpc.request(
          "getTokenAccountsByOwner",
          [
            wallet.address,
            { mint: token.address },
            { encoding: "jsonParsed", commitment: "confirmed" },
          ],
          z.object({
            value: z
              .array(
                z.object({
                  account: z.object({
                    data: z.object({
                      parsed: z.object({
                        info: z.object({
                          mint: z.string(),
                          owner: z.string(),
                          tokenAmount: z.object({
                            amount: z.string().regex(/^\d+$/),
                            decimals: z.number().int(),
                          }),
                        }),
                      }),
                    }),
                  }),
                }),
              )
              .max(1000),
          }),
        );
        let amount = 0n;
        for (const item of result.value) {
          const info = item.account.data.parsed.info;
          if (
            info.mint !== token.address ||
            info.owner !== wallet.address ||
            info.tokenAmount.decimals !== token.decimals
          )
            throw new Error("TOKEN_BALANCE_RESPONSE_MISMATCH");
          amount += BigInt(info.tokenAmount.amount);
        }
        return { ...token, amount: amount.toString() };
      }),
    );
    return {
      walletId: wallet.id,
      chainId,
      nativeAmount: String(native.value),
      nativeDecimals: 9,
      tokens: balances,
      observedAt: at,
      quality: "REAL",
    };
  }
}
