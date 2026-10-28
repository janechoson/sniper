import { randomUUID } from "node:crypto";
import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  isAddress,
  type Address,
} from "viem";
import { z } from "zod";
import {
  atomicAmountSchema,
  atomicQuoteSchema,
  type AtomicQuoteRequest,
  type AtomicTradeQuote,
  type SwapProvider,
  type UnsignedSwapTransaction,
  type ProviderHealth,
} from "@sniper/core";
import { JsonRpcClient, hexSchema } from "@sniper/chains";
import { applySlippage, ratioToNumber } from "@sniper/shared";
const v2 = parseAbi([
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)",
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)",
]);
const v3Quoter = parseAbi([
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
]);
const v3Router = parseAbi([
  "function factory() view returns (address)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const stored = z.object({
  fee: z.number().int().optional(),
  slippageBps: z.number().int(),
});
export interface EvmSwapConfiguration {
  id: string;
  chainId: string;
  evmChainId: number;
  family: "v2" | "v3";
  router: Address;
  factory: Address;
  quoter?: Address;
  feeTiers?: number[];
  quoteTtlMs?: number;
  wrappedNative?: Address;
}
export class EvmRouterSwapProvider implements SwapProvider {
  readonly id: string;
  readonly chainId: string;
  private issued = new Map<string, AtomicTradeQuote>();
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly config: EvmSwapConfiguration,
  ) {
    this.id = config.id;
    this.chainId = config.chainId;
    if (!isAddress(config.router) || !isAddress(config.factory))
      throw new Error("ROUTER_ADDRESS_INVALID");
  }
  supports(r: AtomicQuoteRequest) {
    return (
      r.chainId === this.chainId &&
      isAddress(r.tokenIn) &&
      isAddress(r.tokenOut) &&
      r.tokenIn.toLowerCase() !== r.tokenOut.toLowerCase() &&
      (!(isNative(r.tokenIn) || isNative(r.tokenOut)) ||
        (this.config.family === "v2" && !!this.config.wrappedNative))
    );
  }
  async healthCheck(): Promise<ProviderHealth> {
    try {
      const id = BigInt(await this.rpc.request("eth_chainId", [], hexSchema));
      if (id !== BigInt(this.config.evmChainId)) throw new Error();
      for (const address of [
        this.config.router,
        this.config.factory,
        ...(this.config.quoter ? [this.config.quoter] : []),
      ])
        if (
          (await this.rpc.request(
            "eth_getCode",
            [address, "latest"],
            hexSchema,
          )) === "0x"
        )
          throw new Error();
      const data = encodeFunctionData({ abi: v2, functionName: "factory" });
      const response = await this.rpc.request(
        "eth_call",
        [{ to: this.config.router, data }, "latest"],
        hexSchema,
      );
      const factory = decodeFunctionResult({
        abi: v2,
        functionName: "factory",
        data: response,
      });
      if (factory.toLowerCase() !== this.config.factory.toLowerCase())
        throw new Error();
      if (this.config.wrappedNative) {
        const wrapped = decodeFunctionResult({
          abi: v2,
          functionName: "WETH",
          data: await this.rpc.request(
            "eth_call",
            [
              {
                to: this.config.router,
                data: encodeFunctionData({ abi: v2, functionName: "WETH" }),
              },
              "latest",
            ],
            hexSchema,
          ),
        });
        if (wrapped.toLowerCase() !== this.config.wrappedNative.toLowerCase())
          throw new Error();
      }
      return {
        id: this.id,
        status: "READY",
        reasons: [],
        checkedAt: Date.now(),
      };
    } catch (error) {
      return {
        id: this.id,
        status: "DOWN",
        reasons: [
          "ROUTER_NETWORK_OR_FACTORY_UNVERIFIED",
          ...(error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)
            ? [error.message]
            : []),
        ],
        checkedAt: Date.now(),
      };
    }
  }
  async getQuote(request: AtomicQuoteRequest): Promise<AtomicTradeQuote> {
    if (
      !this.supports(request) ||
      !Number.isInteger(request.slippageBps) ||
      request.slippageBps < 0 ||
      request.slippageBps > 2000
    )
      throw new Error("QUOTE_REQUEST_INVALID");
    const input = BigInt(atomicAmountSchema.parse(request.amountIn));
    if (input === 0n) throw new Error("ZERO_INPUT");
    const quoteAt = Date.now();
    const a = (
        isNative(request.tokenIn) ? this.config.wrappedNative! : request.tokenIn
      ) as Address,
      b = (
        isNative(request.tokenOut)
          ? this.config.wrappedNative!
          : request.tokenOut
      ) as Address;
    if (a.toLowerCase() === b.toLowerCase())
      throw new Error("NATIVE_WRAP_IS_NOT_SWAP");
    const read = async (amount: bigint, fee?: number) => {
      if (this.config.family === "v2") {
        const data = encodeFunctionData({
          abi: v2,
          functionName: "getAmountsOut",
          args: [amount, [a, b]],
        });
        const result = decodeFunctionResult({
          abi: v2,
          functionName: "getAmountsOut",
          data: await this.rpc.request(
            "eth_call",
            [{ to: this.config.router, data }, "latest"],
            hexSchema,
          ),
        });
        if (result.length !== 2 || result[0] !== amount)
          throw new Error("ROUTER_AMOUNTS_INVALID");
        return result[1]!;
      }
      if (!this.config.quoter || fee === undefined)
        throw new Error("V3_QUOTER_UNCONFIGURED");
      const data = encodeFunctionData({
        abi: v3Quoter,
        functionName: "quoteExactInputSingle",
        args: [a, b, fee, amount, 0n],
      });
      return decodeFunctionResult({
        abi: v3Quoter,
        functionName: "quoteExactInputSingle",
        data: await this.rpc.request(
          "eth_call",
          [{ to: this.config.quoter, data }, "latest"],
          hexSchema,
        ),
      });
    };
    const fees =
      this.config.family === "v2"
        ? [undefined]
        : (this.config.feeTiers ?? [500, 3000, 10000]);
    const results = await Promise.allSettled(
      fees.map(async (fee) => ({ amount: await read(input, fee), fee })),
    );
    const available = results
      .flatMap((r) =>
        r.status === "fulfilled" && r.value.amount > 0n ? [r.value] : [],
      )
      .sort((x, y) => (x.amount > y.amount ? -1 : x.amount < y.amount ? 1 : 0));
    const best = available[0];
    if (!best) throw new Error("QUOTE_UNAVAILABLE");
    let impact: number | undefined;
    const probe = input / 10000n;
    if (probe > 0n) {
      try {
        const out = await read(probe, best.fee);
        if (out > 0n) {
          const ratio = ratioToNumber(best.amount * probe, input * out);
          if (ratio !== undefined) impact = Math.max(0, (1 - ratio) * 100);
        }
      } catch {
        /* Tác động giá chưa xác minh vẫn UNKNOWN. */
      }
    }
    const quote = atomicQuoteSchema.parse({
      id: randomUUID(),
      providerId: this.id,
      chainId: this.chainId,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      nativeInput: isNative(request.tokenIn),
      nativeOutput: isNative(request.tokenOut),
      amountIn: input.toString(),
      expectedAmountOut: best.amount.toString(),
      minimumAmountOut: applySlippage(
        best.amount,
        request.slippageBps,
      ).toString(),
      decimalsIn: request.decimalsIn,
      decimalsOut: request.decimalsOut,
      priceImpactPct: impact,
      quotedAt: quoteAt,
      expiresAt: quoteAt + (this.config.quoteTtlMs ?? 10000),
      source: "RPC",
      quality: "REAL",
      routeSummary: `${this.config.family} direct${best.fee === undefined ? "" : ` fee=${best.fee}`}`,
      rawProviderData: { fee: best.fee, slippageBps: request.slippageBps },
    });
    this.remember(quote);
    return structuredClone(quote);
  }
  private remember(q: AtomicTradeQuote) {
    for (const [id, quote] of this.issued)
      if (quote.expiresAt <= Date.now()) this.issued.delete(id);
    if (this.issued.size >= 500)
      this.issued.delete(this.issued.keys().next().value!);
    this.issued.set(q.id, structuredClone(q));
  }
  async buildSwap(
    input: AtomicTradeQuote,
    walletAddress: string,
  ): Promise<UnsignedSwapTransaction> {
    const quote = atomicQuoteSchema.parse(input),
      original = this.issued.get(quote.id);
    if (
      !original ||
      JSON.stringify({ ...original, estimatedNetworkFeeUsd: undefined }) !==
        JSON.stringify({ ...quote, estimatedNetworkFeeUsd: undefined }) ||
      quote.expiresAt <= Date.now() ||
      !isAddress(walletAddress)
    )
      throw new Error("UNISSUED_OR_STALE_QUOTE");
    if ((await this.healthCheck()).status !== "READY")
      throw new Error("ROUTER_UNVERIFIED");
    const details = stored.parse(quote.rawProviderData);
    const tokenIn = (
        quote.nativeInput ? this.config.wrappedNative! : quote.tokenIn
      ) as Address,
      tokenOut = (
        quote.nativeOutput ? this.config.wrappedNative! : quote.tokenOut
      ) as Address;
    const deadline = BigInt(Math.floor(quote.expiresAt / 1000));
    const args = {
      tokenIn,
      tokenOut,
      fee: details.fee ?? 0,
      recipient: walletAddress,
      deadline,
      amountIn: BigInt(quote.amountIn),
      amountOutMinimum: BigInt(quote.minimumAmountOut),
      sqrtPriceLimitX96: 0n,
    };
    const data = quote.nativeInput
      ? encodeFunctionData({
          abi: v2,
          functionName: "swapExactETHForTokens",
          args: [
            args.amountOutMinimum,
            [tokenIn, tokenOut],
            walletAddress,
            deadline,
          ],
        })
      : quote.nativeOutput
        ? encodeFunctionData({
            abi: v2,
            functionName: "swapExactTokensForETH",
            args: [
              args.amountIn,
              args.amountOutMinimum,
              [tokenIn, tokenOut],
              walletAddress,
              deadline,
            ],
          })
        : this.config.family === "v2"
          ? encodeFunctionData({
              abi: v2,
              functionName: "swapExactTokensForTokens",
              args: [
                args.amountIn,
                args.amountOutMinimum,
                [tokenIn, tokenOut],
                walletAddress,
                deadline,
              ],
            })
          : encodeFunctionData({
              abi: v3Router,
              functionName: "exactInputSingle",
              args: [args],
            });
    return {
      family: "evm",
      chainId: this.chainId,
      evmChainId: this.config.evmChainId,
      walletAddress,
      quoteId: quote.id,
      providerId: this.id,
      to: this.config.router,
      data,
      value: quote.nativeInput ? quote.amountIn : "0",
      wrappedNative: this.config.wrappedNative,
      validUntil: quote.expiresAt,
      approval: quote.nativeInput
        ? undefined
        : {
            token: tokenIn,
            spender: this.config.router,
            amount: quote.amountIn,
          },
    };
  }
}
export const NATIVE_EVM = "0x0000000000000000000000000000000000000000";
export const isNative = (address: string) =>
  address.toLowerCase() === NATIVE_EVM;
