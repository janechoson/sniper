import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
} from "viem";
import { z } from "zod";
import { nativeAsset, tracedNativeDelta } from "./native-transfers";
import type { RoundTripResult, SwapProvider } from "@sniper/core";
import { JsonRpcClient, hexSchema } from "@sniper/chains";
import { parseUnitsSafe, formatUnitsSafe, ratioToNumber } from "@sniper/shared";
const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const simulation = z
  .array(
    z.object({
      calls: z.array(
        z.object({
          status: hexSchema,
          returnData: hexSchema,
          gasUsed: hexSchema,
          error: z.unknown().optional(),
          logs: z
            .array(
              z.object({
                address: z.string(),
                topics: z.array(hexSchema),
                data: hexSchema,
              }),
            )
            .default([]),
        }),
      ),
    }),
  )
  .length(1);
export class EvmRoundTripSimulator {
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly evmChainId: number,
  ) {}
  async simulate(
    trip: RoundTripResult,
    wallet: Address,
    buyProvider: SwapProvider,
    sellProvider: SwapProvider,
    prices: { nativeUsd?: string; quoteUsd: string },
  ): Promise<RoundTripResult> {
    if (!trip.sell) return trip;
    let sellFailed = false;
    try {
      if (
        BigInt(await this.rpc.request("eth_chainId", [], hexSchema)) !==
        BigInt(this.evmChainId)
      )
        throw new Error();
      const [buy, sell] = await Promise.all([
        buyProvider.buildSwap(trip.buy, wallet),
        sellProvider.buildSwap(trip.sell, wallet),
      ]);
      if (
        buy.family !== "evm" ||
        sell.family !== "evm" ||
        buy.evmChainId !== this.evmChainId ||
        sell.evmChainId !== this.evmChainId ||
        buy.value !== (trip.buy.nativeInput ? trip.buy.amountIn : "0") ||
        sell.value !== "0" ||
        trip.sell.tokenIn !== trip.buy.tokenOut ||
        trip.sell.tokenOut !== trip.buy.tokenIn
      )
        throw new Error();
      const gasPrice = BigInt(
        await this.rpc.request("eth_gasPrice", [], hexSchema),
      );
      // Geth defaults to +12s (Ethereum slot), exceeding a fresh 10s quote
      // on sub-second EVM chains. Simulate the next second of the pinned real
      // head, never rewind time or override balances/allowances/code.
      const head = await this.rpc.request(
        "eth_getBlockByNumber",
        ["latest", false],
        z.object({ number: hexSchema, timestamp: hexSchema }),
      );
      const nextTime = BigInt(
        Math.max(
          Number(BigInt(head.timestamp)) + 1,
          Math.floor(Date.now() / 1000) + 1,
        ),
      );
      if (
        nextTime * 1000n >=
        BigInt(Math.min(trip.buy.expiresAt, trip.sell.expiresAt))
      )
        throw Error("SIMULATION_DEADLINE_EXPIRED");
      const calls: {
        from: Address;
        to: string;
        data: `0x${string}`;
        gas: string;
        gasPrice: string;
        value: string;
      }[] = [];
      const kinds: ("READ" | "BUY" | "SELL")[] = [];
      const add = (
        to: string,
        data: `0x${string}`,
        kind: "READ" | "BUY" | "SELL",
        value = "0x0",
      ) => {
        calls.push({
          from: wallet,
          to,
          data,
          gas: "0x2dc6c0",
          gasPrice: `0x${gasPrice.toString(16)}`,
          value,
        });
        kinds.push(kind);
        return calls.length - 1;
      };
      const balance = (token: string) =>
        nativeAsset(token)
          ? -1
          : add(
              token,
              encodeFunctionData({
                abi,
                functionName: "balanceOf",
                args: [wallet],
              }),
              "READ",
            );
      const approve = (
        token: Address,
        spender: Address,
        amount: bigint,
        kind: "BUY" | "SELL",
      ) => {
        add(
          token,
          encodeFunctionData({
            abi,
            functionName: "approve",
            args: [spender, 0n],
          }),
          kind,
        );
        add(
          token,
          encodeFunctionData({
            abi,
            functionName: "approve",
            args: [spender, amount],
          }),
          kind,
        );
      };
      const beforeQuote = balance(trip.buy.tokenIn),
        beforeToken = balance(trip.buy.tokenOut);
      if (!trip.buy.nativeInput)
        approve(
          trip.buy.tokenIn as Address,
          buy.to,
          BigInt(trip.buy.amountIn),
          "BUY",
        );
      const buyIndex = add(
        buy.to,
        buy.data,
        "BUY",
        `0x${BigInt(buy.value).toString(16)}`,
      );
      const afterBuyToken = balance(trip.buy.tokenOut);
      approve(
        trip.sell.tokenIn as Address,
        sell.to,
        BigInt(trip.sell.amountIn),
        "SELL",
      );
      const sellIndex = add(
        sell.to,
        sell.data,
        "SELL",
        `0x${BigInt(sell.value).toString(16)}`,
      );
      const afterQuote = balance(trip.buy.tokenIn),
        afterToken = balance(trip.buy.tokenOut);
      const result = simulation.parse(
        await this.rpc.request(
          "eth_simulateV1",
          [
            {
              blockStateCalls: [
                {
                  calls,
                  blockOverrides: { time: `0x${nextTime.toString(16)}` },
                },
              ],
              validation: true,
              traceTransfers: true,
            },
            head.number,
          ],
          simulation,
        ),
      )[0]!.calls;
      const failed = result.findIndex(
        (r) => r.status !== "0x1" || r.error != null,
      );
      if (
        result.length === calls.length &&
        failed >= 0 &&
        kinds[failed] === "SELL" &&
        result[afterBuyToken]?.status === "0x1"
      ) {
        const bought =
          decodeFunctionResult({
            abi,
            functionName: "balanceOf",
            data: result[afterBuyToken]!.returnData,
          }) -
          decodeFunctionResult({
            abi,
            functionName: "balanceOf",
            data: result[beforeToken]!.returnData,
          });
        const error = z
          .object({ code: z.number() })
          .safeParse(result[failed]!.error);
        sellFailed =
          bought >= BigInt(trip.buy.minimumAmountOut) &&
          result[failed]!.status === "0x0" &&
          (result[failed]!.error === undefined ||
            (error.success && error.data.code === 3));
      }
      if (
        result.length !== calls.length ||
        result.some((r) => r.status !== "0x1" || r.error != null)
      ) {
        const e = z
          .object({
            code: z.number().optional(),
            message: z.string().optional(),
          })
          .safeParse(result[failed]?.error);
        const detail = e.success
          ? e.data.message
              ?.match(/(?:[A-Za-z]+Router|TransferHelper): [A-Z_]+/)?.[0]
              .replace(/[^A-Z_]/gi, "_")
          : undefined;
        throw new Error(
          `SIMULATION_CALL_FAILED_${failed}${e.success && e.data.code !== undefined ? `_CODE_${e.data.code}` : ""}${detail ? `_${detail.toUpperCase()}` : ""}`,
        );
      }
      for (let i = 0; i < calls.length; i++) {
        if (
          calls[i]!.data.startsWith("0x095ea7b3") &&
          result[i]!.returnData !== "0x" &&
          decodeFunctionResult({
            abi,
            functionName: "approve",
            data: result[i]!.returnData,
          }) !== true
        )
          throw new Error();
      }
      const amount = (index: number) =>
        decodeFunctionResult({
          abi,
          functionName: "balanceOf",
          data: result[index]!.returnData,
        });
      const bought = amount(afterBuyToken) - amount(beforeToken);
      const native = trip.buy.nativeInput === true;
      if (
        native &&
        tracedNativeDelta(result[buyIndex]!.logs, wallet) !==
          -BigInt(trip.buy.amountIn)
      )
        throw new Error("NATIVE_SPEND_UNPROVEN");
      const returned = native
        ? tracedNativeDelta(result[sellIndex]!.logs, wallet)
        : amount(afterQuote) - amount(beforeQuote) + BigInt(trip.buy.amountIn);
      if (
        (!native && amount(beforeQuote) < BigInt(trip.buy.amountIn)) ||
        bought < BigInt(trip.buy.minimumAmountOut) ||
        amount(afterToken) < amount(beforeToken) ||
        returned < BigInt(trip.sell.minimumAmountOut)
      )
        throw new Error("ROUND_TRIP_DELTA_MISMATCH");
      const buyFee = result.reduce(
          (sum, r, i) =>
            sum + (kinds[i] === "BUY" ? BigInt(r.gasUsed) * gasPrice : 0n),
          0n,
        ),
        sellFee = result.reduce(
          (sum, r, i) =>
            sum + (kinds[i] === "SELL" ? BigInt(r.gasUsed) * gasPrice : 0n),
          0n,
        );
      const nativePrice = prices.nativeUsd
        ? parseUnitsSafe(prices.nativeUsd, 18)
        : undefined;
      const feeUsd = (fee: bigint) =>
        nativePrice === undefined
          ? undefined
          : formatUnitsSafe(
              (fee * nativePrice + 10n ** 18n - 1n) / 10n ** 18n,
              18,
            );
      const inputUsd =
        (BigInt(trip.buy.amountIn) * parseUnitsSafe(prices.quoteUsd, 18)) /
        10n ** BigInt(trip.buy.decimalsIn);
      const outputUsd =
        (BigInt(trip.sell.minimumAmountOut) *
          parseUnitsSafe(prices.quoteUsd, 18)) /
        10n ** BigInt(trip.buy.decimalsIn);
      const feeUsdRaw =
        nativePrice === undefined
          ? undefined
          : ((buyFee + sellFee) * nativePrice) / 10n ** 18n;
      const loss =
        feeUsdRaw === undefined
          ? undefined
          : ratioToNumber((inputUsd - outputUsd + feeUsdRaw) * 100n, inputUsd);
      return {
        ...trip,
        buy: { ...trip.buy, estimatedNetworkFeeUsd: feeUsd(buyFee) },
        sell: { ...trip.sell, estimatedNetworkFeeUsd: feeUsd(sellFee) },
        sellability: "SELLABLE",
        evidence: "TRANSACTION_SIMULATION",
        roundTripLossPct: loss === undefined ? undefined : Math.max(0, loss),
        reasons:
          feeUsdRaw === undefined
            ? ["NATIVE_USD_PRICE_UNKNOWN"]
            : ["STATEFUL_SIMULATION_NO_BROADCAST"],
      };
    } catch (error) {
      return {
        ...trip,
        sellability: sellFailed ? "NOT_SELLABLE" : "UNKNOWN",
        evidence: sellFailed ? "TRANSACTION_SIMULATION" : "QUOTE_ONLY",
        reasons: [
          sellFailed
            ? "SELL_SIMULATION_FAILED"
            : "STATEFUL_ROUND_TRIP_SIMULATION_UNAVAILABLE_OR_FAILED",
          ...(error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)
            ? [error.message]
            : []),
        ],
      };
    }
  }
}
