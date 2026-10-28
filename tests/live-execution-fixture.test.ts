import { describe, it, expect } from "vitest";
import {
  parseAbi,
  encodeFunctionData,
  encodeFunctionResult,
  decodeFunctionData,
  parseTransaction,
  keccak256,
  toHex,
  pad,
  type Address,
} from "viem";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { utils } from "@coral-xyz/anchor";
import { z } from "zod";
import {
  atomicQuoteSchema,
  type SwapProvider,
  type ExecutionMode,
  type UnsignedSwapTransaction,
} from "@sniper/core";
import { TradeIntentAuthority } from "@sniper/risk";
import { MemoryRepository } from "@sniper/storage";
import {
  LocalWalletManager,
  EnvironmentSecretProvider,
  TradingWallet,
} from "@sniper/wallet";
import { JsonRpcClient } from "@sniper/chains";
import {
  DurableExecutionStore,
  EvmLiveExecutor,
  SolanaLiveExecutor,
} from "@sniper/execution";
const tokenIn = ("0x" + "22".repeat(20)) as Address,
  tokenOut = ("0x" + "33".repeat(20)) as Address,
  router = ("0x" + "44".repeat(20)) as Address;
const erc20 = parseAbi([
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const swapAbi = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)",
]);
const blockHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
function makeIntent(
  chainId: string,
  walletId: string,
  mode: ExecutionMode,
  input = tokenIn as string,
  output = tokenOut as string,
  walletAddress?: string,
) {
  const buy = atomicQuoteSchema.parse({
    id: "buy-quote",
    providerId: "fixture-provider",
    chainId,
    tokenIn: input,
    tokenOut: output,
    amountIn: "1000000",
    expectedAmountOut: "1000000000",
    minimumAmountOut: "990000000",
    decimalsIn: 6,
    decimalsOut: 9,
    priceImpactPct: 0.1,
    quotedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    source: "RPC",
    quality: "REAL",
    estimatedNetworkFeeUsd: "1",
  });
  const sell = {
    ...buy,
    id: "sell-quote",
    tokenIn: output,
    tokenOut: input,
    amountIn: buy.minimumAmountOut,
    expectedAmountOut: "995000",
    minimumAmountOut: "990000",
    decimalsIn: 9,
    decimalsOut: 6,
  };
  const authority = new TradeIntentAuthority(() => true);
  const intent = authority.approve({
    decisionId: "decision",
    risk: { passed: true, reasons: [] },
    walletId,
    walletAddress,
    mode,
    side: "BUY",
    roundTrip: {
      buy,
      sell,
      sellability: "SELLABLE",
      evidence: "TRANSACTION_SIMULATION",
      roundTripLossPct: 1,
      reasons: [],
    },
    maxSlippageBps: 100,
    maxPriceImpactPct: 2,
    maxRoundTripLossPct: 5,
    idempotencyKey: `fixture:${chainId}:${mode}:${walletId}`,
    valuation: {
      quoteUsdPrice: "1",
      nativeUsdPrice: "100",
      nativeDecimals: chainId === "solana" ? 9 : 18,
    },
  });
  return { authority, intent };
}
const requestSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.array(z.unknown()),
});
describe("EVM executor với RPC trong bộ nhớ, không có mạng hoặc tiền thật", () => {
  async function harness(
    mode: ExecutionMode,
    initialAllowance = 10n,
    overspend = false,
    loseSubmissionResponse = false,
    approvedAddress?: string,
    fixedWallet = false,
  ) {
    const repository = new MemoryRepository(),
      store = new DurableExecutionStore(repository);
    const wallets = fixedWallet
      ? new TradingWallet(
          [
            {
              id: "bnb",
              name: "BNB",
              type: "evm",
              nativeSymbol: "BNB",
              enabled: true,
            },
          ],
          { EVM_PRIVATE_KEY: "0x" + "11".repeat(32) },
        )
      : new LocalWalletManager(
          [
            {
              id: "evm",
              label: "Fixture",
              family: "evm",
              chains: ["bnb"],
              enabled: true,
              signerType: "local-env",
              secretRef: "env:FIXTURE_KEY",
            },
          ],
          new EnvironmentSecretProvider(["FIXTURE_KEY"], {
            FIXTURE_KEY: "0x" + "11".repeat(32),
          }),
        );
    const wallet = (
      await wallets.publicWallet(fixedWallet ? "trading-evm" : "evm")
    ).address as Address;
    const { authority, intent } = makeIntent(
      "bnb",
      "evm",
      mode,
      tokenIn,
      tokenOut,
      approvedAddress ?? wallet,
    );
    const alternate = fixedWallet
      ? makeIntent("bnb", "trading-evm", mode, tokenIn, tokenOut, wallet)
      : undefined;
    let allowance = initialAllowance,
      nonce = 0;
    const broadcasts: {
      hash: `0x${string}`;
      kind: "swap" | "approve";
      nonce: number;
    }[] = [];
    const provider: SwapProvider = {
      id: "fixture-provider",
      chainId: "bnb",
      supports: () => true,
      getQuote: async () => intent.route.quote,
      healthCheck: async () => ({
        id: "fixture-provider",
        status: "READY",
        reasons: [],
        checkedAt: Date.now(),
      }),
      buildSwap: async (q, address) => ({
        family: "evm",
        chainId: "bnb",
        evmChainId: 56,
        walletAddress: address,
        quoteId: q.id,
        providerId: q.providerId,
        to: router,
        data: encodeFunctionData({
          abi: swapAbi,
          functionName: "swapExactTokensForTokens",
          args: [
            BigInt(q.amountIn),
            BigInt(q.minimumAmountOut),
            [tokenIn, tokenOut],
            address as Address,
            BigInt(Math.floor(q.expiresAt / 1000)),
          ],
        }),
        value: "0",
        validUntil: q.expiresAt,
        approval: { token: tokenIn, spender: router, amount: q.amountIn },
      }),
    };
    const rpc = new JsonRpcClient("fixture", "http://127.0.0.1/unused", {
      rps: 10000,
      fetcher: async (_url, init) => {
        const r = requestSchema.parse(JSON.parse(String(init?.body)));
        let result: unknown;
        switch (r.method) {
          case "eth_chainId":
            result = "0x38";
            break;
          case "eth_getBalance":
            result = "0x3635c9adc5dea00000";
            break;
          case "eth_gasPrice":
            result = "0x1";
            break;
          case "eth_estimateGas":
            result = "0x186a0";
            break;
          case "eth_getTransactionCount":
            result = toHex(nonce);
            break;
          case "eth_blockNumber":
            result = "0x66";
            break;
          case "eth_getBlockByNumber":
            result = { hash: blockHash };
            break;
          case "eth_call": {
            const c = z.object({ data: z.string() }).parse(r.params[0]);
            if (c.data.startsWith("0xdd62ed3e"))
              result = encodeFunctionResult({
                abi: erc20,
                functionName: "allowance",
                result: allowance,
              });
            else if (c.data.startsWith("0x095ea7b3"))
              result = encodeFunctionResult({
                abi: erc20,
                functionName: "approve",
                result: true,
              });
            else
              result = encodeFunctionResult({
                abi: swapAbi,
                functionName: "swapExactTokensForTokens",
                result: [1000000n, 1000000000n],
              });
            break;
          }
          case "eth_simulateV1": {
            const payload = z
              .object({
                validation: z.literal(true),
                blockStateCalls: z
                  .array(z.object({ calls: z.array(z.unknown()).length(5) }))
                  .length(1),
              })
              .parse(r.params[0]);
            expect(payload.validation).toBe(true);
            const uint = (n: bigint) =>
              encodeFunctionResult({
                abi: erc20,
                functionName: "allowance",
                result: n,
              });
            result = [
              {
                calls: [
                  uint(2000000n),
                  uint(0n),
                  "0x",
                  uint(1000000n),
                  uint(1000000000n),
                ].map((returnData) => ({ status: "0x1", returnData })),
              },
            ];
            break;
          }
          case "eth_sendRawTransaction": {
            const raw = z.string().parse(r.params[0]) as `0x${string}`;
            const hash = keccak256(raw);
            const current = store
              .all()
              .find((row) => row.transactionId === hash);
            expect(current?.state).toBe("SUBMITTING");
            expect(
              (await repository.read()).some(
                (row) =>
                  row.kind === "execution.record" &&
                  z
                    .object({
                      transactionId: z.string().optional(),
                      state: z.string(),
                    })
                    .parse(row.payload).transactionId === hash,
              ),
            ).toBe(true);
            const parsed = parseTransaction(raw);
            const signedNonce = z.number().int().parse(parsed.nonce);
            expect(parsed.chainId).toBe(56);
            expect(parsed.nonce).toBe(nonce);
            nonce++;
            if (parsed.data?.startsWith("0x095ea7b3")) {
              const decoded = decodeFunctionData({
                abi: erc20,
                data: parsed.data,
              });
              if (decoded.functionName !== "approve")
                throw new Error("WRONG_APPROVAL");
              expect(decoded.args[0].toLowerCase()).toBe(router.toLowerCase());
              allowance = decoded.args[1];
              broadcasts.push({ hash, kind: "approve", nonce: signedNonce });
            } else {
              expect(parsed.to?.toLowerCase()).toBe(router.toLowerCase());
              broadcasts.push({ hash, kind: "swap", nonce: signedNonce });
              allowance = 0n;
            }
            if (loseSubmissionResponse)
              throw new Error("FIXTURE_RESPONSE_LOST");
            result = hash;
            break;
          }
          case "eth_getTransactionReceipt": {
            const sent = broadcasts.find((b) => b.hash === r.params[0]);
            if (!sent) result = null;
            else {
              const topic = keccak256(
                toHex("Transfer(address,address,uint256)"),
              );
              result = {
                transactionHash: sent.hash,
                status: "0x1",
                blockNumber: "0x64",
                blockHash,
                gasUsed: "0x5208",
                effectiveGasPrice: "0x1",
                logs:
                  sent.kind === "approve"
                    ? []
                    : [
                        {
                          address: tokenIn,
                          topics: [
                            topic,
                            pad(wallet, { size: 32 }),
                            pad(router, { size: 32 }),
                          ],
                          data: pad(toHex(overspend ? 2000000n : 1000000n), {
                            size: 32,
                          }),
                        },
                        {
                          address: tokenOut,
                          topics: [
                            topic,
                            pad(router, { size: 32 }),
                            pad(wallet, { size: 32 }),
                          ],
                          data: pad(toHex(1000000000n), { size: 32 }),
                        },
                      ],
              };
            }
            break;
          }
          default:
            throw new Error("UNEXPECTED_FIXTURE_METHOD");
        }
        return Response.json({ jsonrpc: "2.0", id: r.id, result });
      },
    });
    const executor = new EvmLiveExecutor(
      rpc,
      wallets,
      store,
      {
        chainId: "bnb",
        evmChainId: 56,
        maxGasWei: 10n ** 18n,
        confirmationDepth: 2,
        liveAcknowledged: true,
        receiptTimeoutMs: 100,
      },
      (i) => authority.accepts(i) || !!alternate?.authority.accepts(i),
    );
    return {
      executor,
      intent,
      provider,
      broadcasts,
      store,
      rpc,
      wallet,
      alternate: alternate?.intent,
    };
  }
  it("reset approval khác 0, cấp đúng lượng, serialize nonce, ghi trước gửi và không gửi trùng", async () => {
    const h = await harness("LIVE");
    try {
      const [one, two] = await Promise.all([
        h.executor.execute(h.intent, h.provider),
        h.executor.execute(h.intent, h.provider),
      ]);
      expect(one.state).toBe("CONFIRMED");
      expect(two.id).toBe(one.id);
      expect(one.actualAmountIn).toBe("1000000");
      expect(one.actualAmountOut).toBe("1000000000");
      expect(h.broadcasts.map((b) => b.nonce)).toEqual([0, 1, 2]);
      expect(h.broadcasts.map((b) => b.kind)).toEqual([
        "approve",
        "approve",
        "swap",
      ]);
      expect(
        h.store.all().filter((r) => r.operation === "APPROVAL"),
      ).toHaveLength(2);
    } finally {
      h.rpc.close();
    }
  });
  it("ví cố định giữ một hàng đợi nonce khi intent cũ và mới dùng ID khác nhau", async () => {
    const h = await harness("LIVE", 1000000n, false, false, undefined, true);
    try {
      const results = await Promise.all([
        h.executor.execute(h.intent, h.provider),
        h.executor.execute(h.alternate!, h.provider),
      ]);
      expect(results.map((r) => r.state)).toEqual(["CONFIRMED", "CONFIRMED"]);
      expect(h.broadcasts.map((b) => b.nonce)).toEqual([0, 1, 2]);
      expect(h.broadcasts.map((b) => b.kind)).toEqual([
        "swap",
        "approve",
        "swap",
      ]);
    } finally {
      h.rpc.close();
    }
  });
  it("giao dịch UNKNOWN giữ nonce: intent khác cùng chain không được phát tiếp", async () => {
    const h = await harness("LIVE", 1000000n, false, true, undefined, true);
    try {
      const first = await h.executor.execute(h.intent, h.provider);
      expect(first.state).toBe("UNKNOWN");
      expect(h.broadcasts).toHaveLength(1);
      await expect(
        h.executor.execute(h.alternate!, h.provider),
      ).rejects.toThrow("PENDING_EXECUTION_RECONCILIATION_REQUIRED");
      expect(h.broadcasts).toHaveLength(1);
    } finally {
      h.rpc.close();
    }
  });
  it("dry-run thành công sau mô phỏng, không ký/gửi giao dịch hoặc tạo fill", async () => {
    const h = await harness("LIVE_DRY_RUN", 1000000n);
    try {
      const result = await h.executor.execute(h.intent, h.provider);
      expect(result.state).toBe("DRY_RUN_SUCCEEDED");
      expect(result.actualAmountOut).toBeUndefined();
      expect(result.simulation?.evidence).toBe("BALANCE_DELTA");
      expect(h.broadcasts).toEqual([]);
    } finally {
      h.rpc.close();
    }
  });
  it("đối soát hash đã lưu sau mất phản hồi mà không phát lại giao dịch", async () => {
    const h = await harness("LIVE", 1000000n, false, true);
    try {
      const uncertain = await h.executor.execute(h.intent, h.provider);
      expect(uncertain.state).toBe("UNKNOWN");
      expect(h.broadcasts).toHaveLength(1);
      const restored = await h.executor.confirm(
        uncertain,
        h.intent,
        h.wallet,
        false,
      );
      expect(restored.state).toBe("CONFIRMED");
      expect(restored.actualAmountOut).toBe("1000000000");
      await h.executor.execute(h.intent, h.provider);
      expect(h.broadcasts).toHaveLength(1);
    } finally {
      h.rpc.close();
    }
  });
  it("dry-run thiếu allowance chỉ báo cần approval, không gửi approval", async () => {
    const h = await harness("LIVE_DRY_RUN", 0n);
    try {
      expect(
        (await h.executor.execute(h.intent, h.provider)).reasons,
      ).toContain("EXACT_APPROVAL_REQUIRED");
      expect(h.broadcasts).toEqual([]);
    } finally {
      h.rpc.close();
    }
  });
  it("đổi khóa dưới cùng wallet ID không được dùng intent của địa chỉ cũ", async () => {
    const h = await harness("LIVE", 1000000n, false, false, tokenOut);
    try {
      const result = await h.executor.execute(h.intent, h.provider);
      expect(result.state).toBe("FAILED");
      expect(result.reasons).toContain("INTENT_WALLET_ADDRESS_MISMATCH");
      expect(h.broadcasts).toEqual([]);
    } finally {
      h.rpc.close();
    }
  });
  it("receipt không khớp số token chi ra không được chuyển CONFIRMED", async () => {
    const h = await harness("LIVE", 1000000n, true);
    try {
      expect((await h.executor.execute(h.intent, h.provider)).state).toBe(
        "UNKNOWN",
      );
    } finally {
      h.rpc.close();
    }
  });
});
describe("Solana executor với balance proof fixture", () => {
  async function harness(mode: ExecutionMode, badOutput = false) {
    const pair = Keypair.fromSeed(new Uint8Array(32).fill(7)),
      inMint = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey,
      outMint = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey,
      program = Keypair.fromSeed(new Uint8Array(32).fill(10)).publicKey;
    const wallet = pair.publicKey.toBase58(),
      source = getAssociatedTokenAddressSync(inMint, pair.publicKey),
      destination = getAssociatedTokenAddressSync(outMint, pair.publicKey);
    const { authority, intent } = makeIntent(
      "solana",
      "sol",
      mode,
      inMint.toBase58(),
      outMint.toBase58(),
      wallet,
    );
    const repository = new MemoryRepository(),
      store = new DurableExecutionStore(repository),
      wallets = new LocalWalletManager(
        [
          {
            id: "sol",
            label: "Fixture",
            family: "solana",
            chains: ["solana"],
            enabled: true,
            signerType: "local-env",
            secretRef: "env:FIXTURE_SOL_KEY",
          },
        ],
        new EnvironmentSecretProvider(["FIXTURE_SOL_KEY"], {
          FIXTURE_SOL_KEY: JSON.stringify(Array.from(pair.secretKey)),
        }),
      );
    const account = (owner: string, data: Buffer, lamports = 2039280) => ({
      owner,
      data: [data.toString("base64"), "base64"],
      lamports,
      executable: false,
    });
    const tokenAccount = (mint: PublicKey, amount: bigint) => {
      const data = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode(
        {
          mint,
          owner: pair.publicKey,
          amount,
          delegateOption: 0,
          delegate: PublicKey.default,
          state: 1,
          isNativeOption: 0,
          isNative: 0n,
          delegatedAmount: 0n,
          closeAuthorityOption: 0,
          closeAuthority: PublicKey.default,
        },
        data,
      );
      return account(TOKEN_PROGRAM_ID.toBase58(), data);
    };
    const unsignedTransaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: pair.publicKey,
        recentBlockhash: inMint.toBase58(),
        instructions: [
          new TransactionInstruction({
            programId: program,
            keys: [
              { pubkey: pair.publicKey, isSigner: true, isWritable: true },
              { pubkey: source, isSigner: false, isWritable: true },
              { pubkey: destination, isSigner: false, isWritable: true },
            ],
            data: Buffer.from([1]),
          }),
        ],
      }).compileToV0Message(),
    );
    let broadcasts = 0;
    let signature: string | undefined;
    const addressOrder = () => {
      const keys = unsignedTransaction.message.getAccountKeys();
      const result: string[] = [];
      for (let i = 0; i < keys.length; i++)
        if (unsignedTransaction.message.isAccountWritable(i))
          result.push(keys.get(i)!.toBase58());
      return result;
    };
    const values = (after: boolean) =>
      addressOrder().map((address) =>
        address === wallet
          ? account(
              SystemProgram.programId.toBase58(),
              Buffer.alloc(0),
              after ? 999995000 : 1000000000,
            )
          : address === source.toBase58()
            ? tokenAccount(inMint, after ? 0n : 1000000n)
            : tokenAccount(
                outMint,
                after ? (badOutput ? 1n : 1000000000n) : 0n,
              ),
      );
    const provider: SwapProvider = {
      id: "fixture-provider",
      chainId: "solana",
      supports: () => true,
      getQuote: async () => intent.route.quote,
      healthCheck: async () => ({
        id: "fixture-provider",
        status: "READY",
        checkedAt: Date.now(),
        reasons: [],
      }),
      buildSwap: async (q, address): Promise<UnsignedSwapTransaction> => ({
        family: "solana",
        chainId: "solana",
        walletAddress: address,
        quoteId: q.id,
        providerId: q.providerId,
        transactionBase64: Buffer.from(
          unsignedTransaction.serialize(),
        ).toString("base64"),
        lastValidBlockHeight: 200,
        validUntil: q.expiresAt,
        allowedPrograms: [program.toBase58()],
      }),
    };
    const rpc = new JsonRpcClient("fixture", "http://127.0.0.1/unused", {
      rps: 10000,
      fetcher: async (_url, init) => {
        const r = requestSchema.parse(JSON.parse(String(init?.body)));
        let result: unknown;
        if (r.method === "getGenesisHash") result = "fixture-genesis";
        else if (r.method === "getBlockHeight") result = 100;
        else if (r.method === "getFeeForMessage") result = { value: 5000 };
        else if (r.method === "getMultipleAccounts") {
          const addresses = z.array(z.string()).parse(r.params[0]);
          result = {
            context: { slot: 100 },
            value:
              addresses[0] === inMint.toBase58()
                ? [
                    account(TOKEN_PROGRAM_ID.toBase58(), Buffer.alloc(82)),
                    account(TOKEN_PROGRAM_ID.toBase58(), Buffer.alloc(82)),
                  ]
                : values(false),
          };
        } else if (r.method === "simulateTransaction") {
          const simulation = VersionedTransaction.deserialize(
            Buffer.from(z.string().parse(r.params[0]), "base64"),
          );
          expect(
            simulation.signatures.every((s) => s.every((byte) => byte === 0)),
          ).toBe(true);
          result = { value: { err: null, accounts: values(true) } };
        } else if (r.method === "sendTransaction") {
          broadcasts++;
          const raw = VersionedTransaction.deserialize(
            Buffer.from(z.string().parse(r.params[0]), "base64"),
          );
          expect(raw.signatures[0]?.some((byte) => byte !== 0)).toBe(true);
          signature = utils.bytes.bs58.encode(raw.signatures[0]!);
          expect(
            store
              .all()
              .some(
                (row) =>
                  row.transactionId === signature && row.state === "SUBMITTING",
              ),
          ).toBe(true);
          result = signature;
        } else if (r.method === "getTransaction") {
          result = {
            meta: {
              err: null,
              fee: 5000,
              preTokenBalances: [
                {
                  accountIndex: 1,
                  mint: inMint.toBase58(),
                  owner: wallet,
                  uiTokenAmount: { amount: "1000000" },
                },
              ],
              postTokenBalances: [
                {
                  accountIndex: 1,
                  mint: inMint.toBase58(),
                  owner: wallet,
                  uiTokenAmount: { amount: "0" },
                },
                {
                  accountIndex: 2,
                  mint: outMint.toBase58(),
                  owner: wallet,
                  uiTokenAmount: { amount: "1000000000" },
                },
              ],
            },
          };
        } else throw new Error("UNEXPECTED_FIXTURE_METHOD");
        return Response.json({ jsonrpc: "2.0", id: r.id, result });
      },
    });
    const executor = new SolanaLiveExecutor(
      rpc,
      wallets,
      store,
      {
        expectedGenesisHash: "fixture-genesis",
        allowedPrograms: [program.toBase58()],
        allowedAccountOwners: [],
        maxNetworkFeeLamports: 10000n,
        maxNativeDebitLamports: 100000n,
        liveAcknowledged: true,
      },
      (i) => authority.accepts(i),
    );
    return { rpc, executor, intent, provider, count: () => broadcasts };
  }
  it("dry-run chỉ thành công với balance delta đúng, không có broadcast", async () => {
    const h = await harness("LIVE_DRY_RUN");
    try {
      const record = await h.executor.execute(h.intent, h.provider);
      expect(record.state).toBe("DRY_RUN_SUCCEEDED");
      expect(record.simulation?.evidence).toBe("BALANCE_DELTA");
      expect(record.actualAmountOut).toBeUndefined();
      expect(h.count()).toBe(0);
    } finally {
      h.rpc.close();
    }
  });
  it("từ chối output thấp hơn minimum trước khi ký/gửi", async () => {
    const h = await harness("LIVE_DRY_RUN", true);
    try {
      expect((await h.executor.execute(h.intent, h.provider)).state).toBe(
        "FAILED",
      );
      expect(h.count()).toBe(0);
    } finally {
      h.rpc.close();
    }
  });
  it("ký thật trong fixture và chỉ CONFIRMED sau finalized receipt; không gửi lại", async () => {
    const h = await harness("LIVE");
    try {
      const record = await h.executor.execute(h.intent, h.provider);
      expect(record.state).toBe("CONFIRMED");
      expect(record.actualAmountOut).toBe("1000000000");
      await h.executor.execute(h.intent, h.provider);
      expect(h.count()).toBe(1);
    } finally {
      h.rpc.close();
    }
  });
});
