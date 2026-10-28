import {
  decodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  encodeFunctionData,
  keccak256,
  toHex,
  type Address,
} from "viem";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ApprovedTradeIntent,
  ExecutionRecord,
  SwapProvider,
  UnsignedSwapTransaction,
} from "@sniper/core";
import { JsonRpcClient, hexSchema } from "@sniper/chains";
import { LocalWalletManager, LocalEvmSigner } from "@sniper/wallet";
import { KeyedLock } from "@sniper/shared";
import { DurableExecutionStore } from "./durable";
import {
  nativeAsset,
  tracedNativeDelta,
  callTraceNativeDelta,
} from "./native-transfers";
const swapAbi = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const erc20 = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const receiptSchema = z
  .object({
    transactionHash: hexSchema,
    status: hexSchema,
    blockNumber: hexSchema,
    blockHash: hexSchema,
    gasUsed: hexSchema,
    effectiveGasPrice: hexSchema,
    logs: z.array(
      z.object({
        address: z.string(),
        topics: z.array(hexSchema),
        data: hexSchema,
      }),
    ),
  })
  .nullable();
export interface EvmExecutionPolicy {
  chainId: string;
  evmChainId: number;
  maxGasWei: bigint;
  confirmationDepth: number;
  liveAcknowledged: boolean;
  receiptTimeoutMs?: number;
}
export function validateEvmSwap(
  intent: ApprovedTradeIntent,
  tx: Extract<UnsignedSwapTransaction, { family: "evm" }>,
) {
  const nativeIn = nativeAsset(intent.tokenIn),
    nativeOut = nativeAsset(intent.tokenOut);
  if (
    tx.chainId !== intent.chainId ||
    tx.providerId !== intent.route.providerId ||
    tx.quoteId !== intent.route.quote.id ||
    tx.value !== (nativeIn ? intent.amountIn : "0") ||
    tx.validUntil > intent.expiresAt ||
    (nativeIn
      ? tx.approval !== undefined
      : !tx.approval ||
        tx.approval.amount !== intent.amountIn ||
        tx.approval.token.toLowerCase() !== intent.tokenIn.toLowerCase() ||
        tx.approval.spender.toLowerCase() !== tx.to.toLowerCase())
  )
    throw new Error("TRANSACTION_INTENT_MISMATCH");
  const decoded = decodeFunctionData({ abi: swapAbi, data: tx.data });
  if (nativeIn || nativeOut) {
    if (
      !tx.wrappedNative ||
      (nativeIn && decoded.functionName !== "swapExactETHForTokens") ||
      (nativeOut && decoded.functionName !== "swapExactTokensForETH")
    )
      throw new Error("NATIVE_CALLDATA_MISMATCH");
    const values = decoded.args as readonly unknown[];
    const [amount, min, path, to, deadline] = nativeIn
      ? [BigInt(tx.value), ...values]
      : values;
    const route = path as string[];
    if (
      String(amount) !== intent.amountIn ||
      BigInt(String(min)) < BigInt(intent.route.quote.minimumAmountOut) ||
      route.length !== 2 ||
      route[0]!.toLowerCase() !==
        (nativeIn ? tx.wrappedNative : intent.tokenIn).toLowerCase() ||
      route[1]!.toLowerCase() !==
        (nativeOut ? tx.wrappedNative : intent.tokenOut).toLowerCase() ||
      String(to).toLowerCase() !== tx.walletAddress.toLowerCase() ||
      BigInt(String(deadline)) * 1000n > BigInt(intent.expiresAt)
    )
      throw new Error("NATIVE_CALLDATA_MISMATCH");
    return;
  }
  if (decoded.functionName === "swapExactTokensForTokens") {
    const [amount, min, path, to, deadline] = decoded.args;
    if (
      amount.toString() !== intent.amountIn ||
      min < BigInt(intent.route.quote.minimumAmountOut) ||
      path.length !== 2 ||
      path[0]?.toLowerCase() !== intent.tokenIn.toLowerCase() ||
      path[1]?.toLowerCase() !== intent.tokenOut.toLowerCase() ||
      to.toLowerCase() !== tx.walletAddress.toLowerCase() ||
      deadline * 1000n > BigInt(intent.expiresAt)
    )
      throw new Error("SWAP_CALLDATA_MISMATCH");
  } else if (decoded.functionName === "exactInputSingle") {
    const p = decoded.args[0];
    if (
      p.amountIn.toString() !== intent.amountIn ||
      p.amountOutMinimum < BigInt(intent.route.quote.minimumAmountOut) ||
      p.tokenIn.toLowerCase() !== intent.tokenIn.toLowerCase() ||
      p.tokenOut.toLowerCase() !== intent.tokenOut.toLowerCase() ||
      p.recipient.toLowerCase() !== tx.walletAddress.toLowerCase() ||
      p.deadline * 1000n > BigInt(intent.expiresAt) ||
      p.sqrtPriceLimitX96 !== 0n
    )
      throw new Error("SWAP_CALLDATA_MISMATCH");
  } else throw new Error("SWAP_CALLDATA_MISMATCH");
}
export class EvmLiveExecutor {
  private readonly walletsLock = new KeyedLock();
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly wallets: LocalWalletManager,
    private readonly store: DurableExecutionStore,
    private readonly policy: EvmExecutionPolicy,
    private readonly authorized: (intent: ApprovedTradeIntent) => boolean,
  ) {}
  async execute(
    intent: ApprovedTradeIntent,
    provider: SwapProvider,
  ): Promise<ExecutionRecord> {
    return this.store.lock.run(intent.idempotencyKey, () =>
      this.walletsLock.run(intent.chainId, async () => {
        const prior = this.store.get(intent.idempotencyKey);
        if (
          prior &&
          (prior.state !== "APPROVED" || prior.intentId !== intent.id)
        )
          return prior;
        if (
          this.store
            .all()
            .some(
              (record) =>
                record.chainId === intent.chainId &&
                record.intentId !== intent.id &&
                ["UNKNOWN", "SUBMITTING", "PENDING"].includes(record.state),
            )
        )
          throw new Error("PENDING_EXECUTION_RECONCILIATION_REQUIRED");
        if (
          !this.authorized(intent) ||
          intent.chainId !== this.policy.chainId ||
          intent.mode === "PAPER" ||
          (intent.mode === "LIVE" && !this.policy.liveAcknowledged)
        )
          throw new Error("LIVE_INTENT_NOT_APPROVED");
        let record = await this.store.begin(intent);
        const update = async (
          state: ExecutionRecord["state"],
          reasons: string[] = [],
          extra: Partial<ExecutionRecord> = {},
        ) => {
          record = await this.store.put({
            ...record,
            ...extra,
            state,
            reasons,
            updatedAt: Date.now(),
          });
          return record;
        };
        try {
          await update("BUILDING");
          const signer = await this.wallets.signer(
            intent.walletId,
            intent.chainId,
          );
          if (!(signer instanceof LocalEvmSigner))
            throw new Error("SIGNER_FAMILY_MISMATCH");
          const wallet = signer.address();
          if (
            !intent.walletAddress ||
            intent.walletAddress.toLowerCase() !== wallet.toLowerCase()
          )
            throw new Error("INTENT_WALLET_ADDRESS_MISMATCH");
          if (
            BigInt(await this.rpc.request("eth_chainId", [], hexSchema)) !==
            BigInt(this.policy.evmChainId)
          )
            throw new Error("CHAIN_ID_MISMATCH");
          const tx = await provider.buildSwap(intent.route.quote, wallet);
          if (tx.family !== "evm" || tx.evmChainId !== this.policy.evmChainId)
            throw new Error("TRANSACTION_FAMILY_MISMATCH");
          validateEvmSwap(intent, tx);
          await update("SIMULATING");
          const allowanceData = encodeFunctionData({
            abi: erc20,
            functionName: "allowance",
            args: [wallet, tx.to],
          });
          const allowance = nativeAsset(intent.tokenIn)
            ? BigInt(intent.amountIn)
            : BigInt(
                await this.rpc.request(
                  "eth_call",
                  [{ to: intent.tokenIn, data: allowanceData }, "latest"],
                  hexSchema,
                ),
              );
          if (allowance < BigInt(intent.amountIn)) {
            if (intent.mode === "LIVE_DRY_RUN")
              throw new Error("EXACT_APPROVAL_REQUIRED");
            await this.approveExact(intent, signer, tx, allowance);
          }
          const call = {
            from: wallet,
            to: tx.to,
            data: tx.data,
            value: toHex(BigInt(tx.value)),
          };
          const result = await this.rpc.request(
            "eth_call",
            [call, "pending"],
            hexSchema,
          );
          const decoded = decodeFunctionData({ abi: swapAbi, data: tx.data });
          const output =
            decoded.functionName !== "exactInputSingle"
              ? decodeFunctionResult({
                  abi: swapAbi,
                  functionName: "swapExactTokensForTokens",
                  data: result,
                }).at(-1)
              : decodeFunctionResult({
                  abi: swapAbi,
                  functionName: "exactInputSingle",
                  data: result,
                });
          if (
            output === undefined ||
            output < BigInt(intent.route.quote.minimumAmountOut)
          )
            throw new Error("SIMULATED_OUTPUT_TOO_LOW");
          const estimated = BigInt(
            await this.rpc.request("eth_estimateGas", [call], hexSchema),
          );
          const gas = (estimated * 120n) / 100n;
          const gasPrice = BigInt(
            await this.rpc.request("eth_gasPrice", [], hexSchema),
          );
          if (gas * gasPrice > this.policy.maxGasWei)
            throw new Error("GAS_BUDGET_EXCEEDED");
          const balance = BigInt(
            await this.rpc.request(
              "eth_getBalance",
              [wallet, "pending"],
              hexSchema,
            ),
          );
          if (balance < gas * gasPrice + BigInt(tx.value))
            throw new Error("INSUFFICIENT_NATIVE_BALANCE");
          const proof = await this.balanceProof(
            intent,
            wallet,
            call,
            gas,
            gasPrice,
          );
          if (!this.authorized(intent))
            throw new Error("STALE_OR_REVOKED_INTENT");
          if (intent.mode === "LIVE_DRY_RUN")
            return update("DRY_RUN_SUCCEEDED", ["NO_BROADCAST"], {
              simulation: {
                amountIn: proof.spent.toString(),
                amountOut: proof.received.toString(),
                evidence: "BALANCE_DELTA",
              },
            });
          const nonce = Number(
            BigInt(
              await this.rpc.request(
                "eth_getTransactionCount",
                [wallet, "pending"],
                hexSchema,
              ),
            ),
          );
          if (!Number.isSafeInteger(nonce))
            throw new Error("NONCE_OUT_OF_RANGE");
          const raw = await signer.sign({
            type: "legacy",
            chainId: this.policy.evmChainId,
            nonce,
            to: tx.to,
            data: tx.data,
            value: BigInt(tx.value),
            gas,
            gasPrice,
          });
          const hash = keccak256(raw);
          if (!this.authorized(intent))
            throw new Error("STALE_OR_REVOKED_INTENT");
          await update("SUBMITTING", [], { transactionId: hash });
          try {
            const sent = await this.rpc.request(
              "eth_sendRawTransaction",
              [raw],
              hexSchema,
            );
            if (sent.toLowerCase() !== hash.toLowerCase()) throw new Error();
            await update("PENDING");
          } catch {
            return update("UNKNOWN", [
              "SUBMISSION_RESULT_UNKNOWN_DO_NOT_RESEND",
            ]);
          }
          return this.confirm(record, intent, wallet);
        } catch (error) {
          if (record.state === "SUBMITTING" || record.state === "PENDING")
            return update("UNKNOWN", ["RECONCILIATION_REQUIRED"]);
          const reason =
            error instanceof Error && /^[A-Z_]+$/.test(error.message)
              ? error.message
              : "EXECUTION_FAILED";
          return update("FAILED", [reason]);
        }
      }),
    );
  }
  private async balanceProof(
    intent: ApprovedTradeIntent,
    wallet: Address,
    swap: { from: Address; to: Address; data: `0x${string}`; value: string },
    gas: bigint,
    gasPrice: bigint,
  ) {
    if (nativeAsset(intent.tokenIn) || nativeAsset(intent.tokenOut)) {
      const token = nativeAsset(intent.tokenIn)
        ? intent.tokenOut
        : intent.tokenIn;
      const read = {
        from: wallet,
        to: token,
        data: encodeFunctionData({
          abi: erc20,
          functionName: "balanceOf",
          args: [wallet],
        }),
        gas: "0x186a0",
        gasPrice: toHex(gasPrice),
        value: "0x0",
      };
      const rows = await this.rpc.request(
        "eth_simulateV1",
        [
          {
            blockStateCalls: [
              {
                calls: [
                  read,
                  { ...swap, gas: toHex(gas), gasPrice: toHex(gasPrice) },
                  read,
                ],
              },
            ],
            validation: true,
            traceTransfers: true,
          },
          "latest",
        ],
        z
          .array(
            z.object({
              calls: z
                .array(
                  z.object({
                    status: hexSchema,
                    returnData: hexSchema,
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
                )
                .length(3),
            }),
          )
          .length(1),
      );
      const c = rows[0]!.calls;
      if (c.some((r) => r.status !== "0x1"))
        throw new Error("STATEFUL_BALANCE_SIMULATION_FAILED");
      const before = decodeFunctionResult({
        abi: erc20,
        functionName: "balanceOf",
        data: c[0]!.returnData,
      });
      const after = decodeFunctionResult({
        abi: erc20,
        functionName: "balanceOf",
        data: c[2]!.returnData,
      });
      const native = tracedNativeDelta(c[1]!.logs, wallet);
      const spent = nativeAsset(intent.tokenIn) ? -native : before - after,
        received = nativeAsset(intent.tokenOut) ? native : after - before;
      if (
        spent !== BigInt(intent.amountIn) ||
        received < BigInt(intent.route.quote.minimumAmountOut)
      )
        throw new Error("SIMULATED_BALANCE_DELTA_MISMATCH");
      return { spent, received };
    }
    const read = (token: string) => ({
      from: wallet,
      to: token,
      data: encodeFunctionData({
        abi: erc20,
        functionName: "balanceOf",
        args: [wallet],
      }),
      gas: "0x186a0",
      gasPrice: toHex(gasPrice),
      value: "0x0",
    });
    const calls = [
      read(intent.tokenIn),
      read(intent.tokenOut),
      { ...swap, gas: toHex(gas), gasPrice: toHex(gasPrice) },
      read(intent.tokenIn),
      read(intent.tokenOut),
    ];
    const schema = z
      .array(
        z.object({
          calls: z
            .array(
              z.object({
                status: hexSchema,
                returnData: hexSchema,
                error: z.unknown().optional(),
              }),
            )
            .length(5),
        }),
      )
      .length(1);
    let result;
    try {
      result = await this.rpc.request(
        "eth_simulateV1",
        [
          {
            blockStateCalls: [{ calls }],
            validation: true,
            traceTransfers: false,
          },
          "latest",
        ],
        schema,
      );
    } catch {
      throw new Error("STATEFUL_BALANCE_SIMULATION_UNAVAILABLE");
    }
    const rows = result[0]!.calls;
    if (rows.some((row) => row.status !== "0x1" || row.error !== undefined))
      throw new Error("STATEFUL_BALANCE_SIMULATION_FAILED");
    const amount = (index: number) =>
      decodeFunctionResult({
        abi: erc20,
        functionName: "balanceOf",
        data: rows[index]!.returnData,
      });
    const spent = amount(0) - amount(3),
      received = amount(4) - amount(1);
    if (
      spent !== BigInt(intent.amountIn) ||
      received < BigInt(intent.route.quote.minimumAmountOut)
    )
      throw new Error("SIMULATED_BALANCE_DELTA_MISMATCH");
    return { spent, received };
  }
  private async approveExact(
    intent: ApprovedTradeIntent,
    signer: LocalEvmSigner,
    tx: Extract<UnsignedSwapTransaction, { family: "evm" }>,
    allowance: bigint,
  ) {
    if (
      intent.mode !== "LIVE" ||
      !this.policy.liveAcknowledged ||
      !this.authorized(intent)
    )
      throw new Error("APPROVAL_NOT_AUTHORIZED");
    const amounts =
      allowance > 0n
        ? [0n, BigInt(intent.amountIn)]
        : [BigInt(intent.amountIn)];
    for (const amount of amounts) {
      const key = `${intent.idempotencyKey}:approval:${tx.to}:${amount}`;
      let approval = this.store.get(key);
      if (approval) {
        if (approval.state === "CONFIRMED") continue;
        throw new Error("APPROVAL_RECONCILIATION_REQUIRED");
      }
      approval = await this.store.put({
        id: randomUUID(),
        intentId: intent.id,
        idempotencyKey: key,
        walletId: intent.walletId,
        chainId: intent.chainId,
        mode: "LIVE",
        operation: "APPROVAL",
        approval: {
          token: intent.tokenIn,
          spender: tx.to,
          amount: amount.toString(),
        },
        state: "APPROVED",
        updatedAt: Date.now(),
        reasons: ["APPROVAL_ONLY"],
      });
      const update = async (
        state: ExecutionRecord["state"],
        reasons: string[],
        extra: Partial<ExecutionRecord> = {},
      ) => {
        approval = await this.store.put({
          ...approval!,
          ...extra,
          state,
          reasons,
          updatedAt: Date.now(),
        });
      };
      try {
        const data = encodeFunctionData({
          abi: erc20,
          functionName: "approve",
          args: [tx.to, amount],
        });
        const call = {
          from: signer.address(),
          to: intent.tokenIn,
          data,
          value: "0x0",
        };
        const returned = await this.rpc.request(
          "eth_call",
          [call, "pending"],
          hexSchema,
        );
        if (
          returned !== "0x" &&
          decodeFunctionResult({
            abi: erc20,
            functionName: "approve",
            data: returned,
          }) !== true
        )
          throw new Error("APPROVAL_SIMULATION_FAILED");
        const gas =
          (BigInt(
            await this.rpc.request("eth_estimateGas", [call], hexSchema),
          ) *
            120n) /
          100n;
        const gasPrice = BigInt(
          await this.rpc.request("eth_gasPrice", [], hexSchema),
        );
        if (gas * gasPrice > this.policy.maxGasWei / BigInt(amounts.length))
          throw new Error("APPROVAL_GAS_BUDGET_EXCEEDED");
        if (!this.authorized(intent))
          throw new Error("STALE_OR_REVOKED_INTENT");
        const nonce = Number(
          BigInt(
            await this.rpc.request(
              "eth_getTransactionCount",
              [signer.address(), "pending"],
              hexSchema,
            ),
          ),
        );
        if (!Number.isSafeInteger(nonce)) throw new Error("NONCE_OUT_OF_RANGE");
        const raw = await signer.sign({
          type: "legacy",
          chainId: this.policy.evmChainId,
          nonce,
          to: intent.tokenIn as Address,
          data,
          value: 0n,
          gas,
          gasPrice,
        });
        const hash = keccak256(raw);
        if (!this.authorized(intent))
          throw new Error("STALE_OR_REVOKED_INTENT");
        await update("SUBMITTING", ["APPROVAL_ONLY"], { transactionId: hash });
        try {
          if (
            (await this.rpc.request(
              "eth_sendRawTransaction",
              [raw],
              hexSchema,
            )) !== hash
          )
            throw new Error();
          await update("PENDING", ["APPROVAL_ONLY"]);
        } catch {
          await update("UNKNOWN", [
            "APPROVAL_SUBMISSION_UNKNOWN_DO_NOT_RESEND",
          ]);
          throw new Error("APPROVAL_RECONCILIATION_REQUIRED");
        }
        const end = Date.now() + (this.policy.receiptTimeoutMs ?? 45000);
        let confirmed = false;
        while (Date.now() < end) {
          const receipt = await this.rpc.request(
            "eth_getTransactionReceipt",
            [hash],
            receiptSchema,
          );
          if (receipt) {
            if (receipt.transactionHash !== hash)
              throw new Error("RECEIPT_HASH_MISMATCH");
            const head = BigInt(
              await this.rpc.request("eth_blockNumber", [], hexSchema),
            );
            if (
              head >=
              BigInt(receipt.blockNumber) +
                BigInt(this.policy.confirmationDepth)
            ) {
              const block = await this.rpc.request(
                "eth_getBlockByNumber",
                [receipt.blockNumber, false],
                z.object({ hash: hexSchema }),
              );
              if (block.hash === receipt.blockHash) {
                const fee = (
                  BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)
                ).toString();
                if (BigInt(receipt.status) !== 1n) {
                  await update("FAILED", ["APPROVAL_REVERTED"], {
                    networkFee: fee,
                  });
                  throw new Error("APPROVAL_REVERTED");
                }
                const observed = BigInt(
                  await this.rpc.request(
                    "eth_call",
                    [
                      {
                        to: intent.tokenIn,
                        data: encodeFunctionData({
                          abi: erc20,
                          functionName: "allowance",
                          args: [signer.address(), tx.to],
                        }),
                      },
                      "latest",
                    ],
                    hexSchema,
                  ),
                );
                if (observed !== amount) {
                  await update("UNKNOWN", ["APPROVAL_ALLOWANCE_MISMATCH"], {
                    networkFee: fee,
                  });
                  throw new Error("APPROVAL_RECONCILIATION_REQUIRED");
                }
                await update("CONFIRMED", ["APPROVAL_ONLY"], {
                  networkFee: fee,
                });
                confirmed = true;
                break;
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (!confirmed) {
          await update("UNKNOWN", [
            "APPROVAL_CONFIRMATION_TIMEOUT_DO_NOT_RESEND",
          ]);
          throw new Error("APPROVAL_RECONCILIATION_REQUIRED");
        }
      } catch (error) {
        if (
          approval!.state !== "CONFIRMED" &&
          approval!.state !== "FAILED" &&
          approval!.state !== "UNKNOWN"
        )
          await update(approval!.transactionId ? "UNKNOWN" : "FAILED", [
            "APPROVAL_FAILED",
          ]);
        throw error;
      }
    }
  }
  async confirm(
    record: ExecutionRecord,
    intent?: ApprovedTradeIntent,
    wallet?: Address,
    wait = true,
  ): Promise<ExecutionRecord> {
    if (!record.transactionId) throw new Error("TRANSACTION_ID_MISSING");
    if (
      BigInt(await this.rpc.request("eth_chainId", [], hexSchema)) !==
      BigInt(this.policy.evmChainId)
    )
      throw new Error("CHAIN_ID_MISMATCH");
    const end = Date.now() + (this.policy.receiptTimeoutMs ?? 45000);
    while (Date.now() < end) {
      const receipt: z.infer<typeof receiptSchema> = await this.rpc.request(
        "eth_getTransactionReceipt",
        [record.transactionId],
        receiptSchema,
      );
      if (receipt) {
        if (receipt.transactionHash !== record.transactionId)
          throw new Error("RECEIPT_HASH_MISMATCH");
        if (![0n, 1n].includes(BigInt(receipt.status)))
          throw new Error("RECEIPT_STATUS_INVALID");
        const head = BigInt(
          await this.rpc.request("eth_blockNumber", [], hexSchema),
        );
        if (
          head >=
          BigInt(receipt.blockNumber) + BigInt(this.policy.confirmationDepth)
        ) {
          const block = await this.rpc.request(
            "eth_getBlockByNumber",
            [receipt.blockNumber, false],
            z.object({ hash: hexSchema }),
          );
          if (block.hash !== receipt.blockHash) {
            if (!wait) return record;
            continue;
          }
          const networkFee = (
            BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)
          ).toString();
          if (BigInt(receipt.status) === 0n)
            return this.store.put({
              ...record,
              state: "FAILED",
              networkFee,
              updatedAt: Date.now(),
              reasons: ["TRANSACTION_REVERTED"],
            });
          let actualOut: bigint | undefined;
          let actualIn: bigint | undefined;
          if (record.operation === "APPROVAL") {
            const approval = record.approval;
            const topic = keccak256(toHex("Approval(address,address,uint256)"));
            const proven =
              approval &&
              wallet &&
              receipt.logs.some(
                (log) =>
                  log.address.toLowerCase() === approval.token.toLowerCase() &&
                  log.topics.length === 3 &&
                  log.topics[0] === topic &&
                  log.topics[1]!.slice(-40).toLowerCase() ===
                    wallet.slice(2).toLowerCase() &&
                  log.topics[2]!.slice(-40).toLowerCase() ===
                    approval.spender.slice(2).toLowerCase() &&
                  BigInt(log.data) === BigInt(approval.amount),
              );
            return this.store.put({
              ...record,
              networkFee,
              state: proven ? "CONFIRMED" : "UNKNOWN",
              reasons: proven
                ? ["APPROVAL_ONLY"]
                : ["APPROVAL_RECEIPT_REQUIRES_RECONCILIATION"],
              updatedAt: Date.now(),
            });
          }
          if (intent && wallet) {
            const topic = keccak256(toHex("Transfer(address,address,uint256)"));
            let incoming = 0n,
              outgoing = 0n;
            for (const log of receipt.logs) {
              if (
                log.address.toLowerCase() !== intent.tokenOut.toLowerCase() ||
                log.topics[0] !== topic ||
                log.topics.length !== 3
              )
                continue;
              const from = "0x" + log.topics[1]!.slice(-40),
                to = "0x" + log.topics[2]!.slice(-40);
              if (to.toLowerCase() === wallet.toLowerCase())
                incoming += BigInt(log.data);
              if (from.toLowerCase() === wallet.toLowerCase())
                outgoing += BigInt(log.data);
            }
            if (incoming >= outgoing) actualOut = incoming - outgoing;
            incoming = 0n;
            outgoing = 0n;
            for (const log of receipt.logs) {
              if (
                log.address.toLowerCase() !== intent.tokenIn.toLowerCase() ||
                log.topics[0] !== topic ||
                log.topics.length !== 3
              )
                continue;
              const from = "0x" + log.topics[1]!.slice(-40),
                to = "0x" + log.topics[2]!.slice(-40);
              if (to.toLowerCase() === wallet.toLowerCase())
                incoming += BigInt(log.data);
              if (from.toLowerCase() === wallet.toLowerCase())
                outgoing += BigInt(log.data);
            }
            if (outgoing >= incoming) actualIn = outgoing - incoming;
            if (nativeAsset(intent.tokenIn) || nativeAsset(intent.tokenOut)) {
              try {
                const mined = await this.rpc.request(
                  "eth_getTransactionByHash",
                  [record.transactionId],
                  z.object({
                    hash: hexSchema,
                    from: z.string(),
                    to: z.string(),
                    value: hexSchema,
                  }),
                );
                if (
                  mined.hash !== record.transactionId ||
                  mined.from.toLowerCase() !== wallet.toLowerCase()
                )
                  throw Error("NATIVE_RECEIPT_AUTHORITY_MISMATCH");
                if (
                  nativeAsset(intent.tokenIn) &&
                  BigInt(mined.value) !== BigInt(intent.amountIn)
                )
                  throw Error("NATIVE_RECEIPT_VALUE_MISMATCH");
                const trace = await this.rpc.request(
                  "debug_traceTransaction",
                  [
                    record.transactionId,
                    {
                      tracer: "callTracer",
                      tracerConfig: { onlyTopCall: false, withLog: false },
                    },
                  ],
                  z.unknown(),
                );
                const delta = callTraceNativeDelta(trace, wallet);
                if (nativeAsset(intent.tokenIn)) actualIn = -delta;
                if (nativeAsset(intent.tokenOut)) actualOut = delta;
              } catch {
                actualIn = undefined;
                actualOut = undefined;
              }
            }
          }
          // Receipt thành công nhưng không chứng minh số token nhận: chờ đối soát, không mở vị thế.
          if (
            !intent ||
            actualOut === undefined ||
            actualIn === undefined ||
            actualIn !== BigInt(intent.amountIn) ||
            actualOut < BigInt(intent.route.quote.minimumAmountOut)
          )
            return this.store.put({
              ...record,
              state: "UNKNOWN",
              updatedAt: Date.now(),
              reasons: ["RECEIPT_FILL_REQUIRES_RECONCILIATION"],
              networkFee,
            });
          return this.store.put({
            ...record,
            state: "CONFIRMED",
            actualAmountIn: actualIn.toString(),
            actualAmountOut: actualOut.toString(),
            networkFee: (
              BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)
            ).toString(),
            updatedAt: Date.now(),
            reasons: [],
          });
        }
      }
      if (!wait) return record;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return this.store.put({
      ...record,
      state: "UNKNOWN",
      reasons: ["CONFIRMATION_TIMEOUT_DO_NOT_RESEND"],
      updatedAt: Date.now(),
    });
  }
}
