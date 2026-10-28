import {
  VersionedTransaction,
  PublicKey,
  AddressLookupTableAccount,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { utils } from "@coral-xyz/anchor";
import { z } from "zod";
import type {
  ApprovedTradeIntent,
  ExecutionRecord,
  SwapProvider,
} from "@sniper/core";
import {
  JsonRpcClient,
  solanaAccountSchema,
  accountInfo,
} from "@sniper/chains";
import { LocalWalletManager, LocalSolanaSigner } from "@sniper/wallet";
import { KeyedLock } from "@sniper/shared";
import { DurableExecutionStore } from "./durable";
import { solanaNativeReceiptDelta } from "./solana-native";
const accountResponse = z.object({
  context: z.object({ slot: z.number().int() }),
  value: z.array(solanaAccountSchema.nullable()).max(100),
});
export interface SolanaExecutionPolicy {
  expectedGenesisHash: string;
  allowedPrograms: string[];
  allowedAccountOwners: string[];
  maxNetworkFeeLamports: bigint;
  maxNativeDebitLamports: bigint;
  liveAcknowledged: boolean;
  receiptTimeoutMs?: number;
}
export class SolanaLiveExecutor {
  private readonly walletLocks = new KeyedLock();
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly wallets: LocalWalletManager,
    private readonly store: DurableExecutionStore,
    private readonly policy: SolanaExecutionPolicy,
    private readonly authorized: (intent: ApprovedTradeIntent) => boolean,
  ) {}
  async execute(
    intent: ApprovedTradeIntent,
    provider: SwapProvider,
  ): Promise<ExecutionRecord> {
    return this.store.lock.run(intent.idempotencyKey, () =>
      this.walletLocks.run("solana", async () => {
        const previous = this.store.get(intent.idempotencyKey);
        if (
          previous &&
          (previous.state !== "APPROVED" || previous.intentId !== intent.id)
        )
          return previous;
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
          intent.mode === "PAPER" ||
          intent.chainId !== "solana" ||
          !this.authorized(intent) ||
          (intent.mode === "LIVE" && !this.policy.liveAcknowledged)
        )
          throw new Error("SOLANA_INTENT_NOT_APPROVED");
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
          if (
            (await this.rpc.request("getGenesisHash", [], z.string())) !==
            this.policy.expectedGenesisHash
          )
            throw new Error("SOLANA_GENESIS_MISMATCH");
          const signer = await this.wallets.signer(intent.walletId, "solana");
          if (!(signer instanceof LocalSolanaSigner))
            throw new Error("SIGNER_FAMILY_MISMATCH");
          const wallet = signer.address();
          const nativeInput = intent.route.quote.nativeInput === true;
          const nativeOutput = intent.route.quote.nativeOutput === true;
          if (
            (nativeInput &&
              intent.tokenIn !==
                "So11111111111111111111111111111111111111112") ||
            (nativeOutput &&
              intent.tokenOut !== "So11111111111111111111111111111111111111112")
          )
            throw new Error("NATIVE_ROUTE_MISMATCH");
          if (intent.walletAddress !== wallet)
            throw new Error("INTENT_WALLET_ADDRESS_MISMATCH");
          const unsigned = await provider.buildSwap(intent.route.quote, wallet);
          if (
            unsigned.family !== "solana" ||
            unsigned.chainId !== intent.chainId ||
            unsigned.providerId !== intent.route.providerId ||
            unsigned.quoteId !== intent.route.quote.id ||
            unsigned.walletAddress !== wallet ||
            unsigned.validUntil > intent.expiresAt
          )
            throw new Error("SOLANA_BUILD_INTENT_MISMATCH");
          const transaction = VersionedTransaction.deserialize(
            Buffer.from(unsigned.transactionBase64, "base64"),
          );
          if (
            transaction.version !== 0 ||
            transaction.message.header.numRequiredSignatures !== 1 ||
            transaction.message.staticAccountKeys[0]?.toBase58() !== wallet ||
            transaction.signatures.some((signature) =>
              signature.some((byte) => byte !== 0),
            )
          )
            throw new Error("SOLANA_TRANSACTION_AUTHORITY_MISMATCH");
          const lookupTables: AddressLookupTableAccount[] = [];
          for (const lookup of transaction.message.addressTableLookups) {
            const response = await this.rpc.request(
              "getAccountInfo",
              [
                lookup.accountKey.toBase58(),
                { encoding: "base64", commitment: "confirmed" },
              ],
              z.object({ value: solanaAccountSchema.nullable() }),
            );
            if (
              !response.value ||
              response.value.owner !==
                "AddressLookupTab1e1111111111111111111111111"
            )
              throw new Error("LOOKUP_TABLE_INVALID");
            lookupTables.push(
              new AddressLookupTableAccount({
                key: lookup.accountKey,
                state: AddressLookupTableAccount.deserialize(
                  Buffer.from(response.value.data[0], "base64"),
                ),
              }),
            );
          }
          const keys = transaction.message.getAccountKeys({
            addressLookupTableAccounts: lookupTables,
          });
          const programs = new Set(this.policy.allowedPrograms);
          for (const ix of transaction.message.compiledInstructions) {
            const address = keys.get(ix.programIdIndex)?.toBase58();
            if (!address || !programs.has(address))
              throw new Error("SOLANA_PROGRAM_NOT_ALLOWED");
          }
          const writable: string[] = [];
          for (let i = 0; i < keys.length; i++)
            if (transaction.message.isAccountWritable(i)) {
              const key = keys.get(i);
              if (!key) throw new Error("SOLANA_ACCOUNT_KEYS_INVALID");
              writable.push(key.toBase58());
            }
          if (writable.length > 100)
            throw new Error("SOLANA_TOO_MANY_WRITABLE_ACCOUNTS");
          const mintInfo = await this.rpc.request(
            "getMultipleAccounts",
            [
              [intent.tokenIn, intent.tokenOut],
              { encoding: "base64", commitment: "confirmed" },
            ],
            accountResponse,
          );
          if (mintInfo.value.length !== 2 || mintInfo.value.some((v) => !v))
            throw new Error("SOLANA_MINT_UNAVAILABLE");
          const tokenPrograms = mintInfo.value.map(
            (v) => new PublicKey(v!.owner),
          );
          if (
            tokenPrograms.some(
              (p) =>
                !p.equals(TOKEN_PROGRAM_ID) && !p.equals(TOKEN_2022_PROGRAM_ID),
            )
          )
            throw new Error("SOLANA_MINT_PROGRAM_INVALID");
          const source = getAssociatedTokenAddressSync(
              new PublicKey(intent.tokenIn),
              new PublicKey(wallet),
              false,
              tokenPrograms[0],
            ).toBase58(),
            destination = getAssociatedTokenAddressSync(
              new PublicKey(intent.tokenOut),
              new PublicKey(wallet),
              false,
              tokenPrograms[1],
            ).toBase58();
          if (
            !writable.includes(source) ||
            !writable.includes(destination) ||
            !writable.includes(wallet)
          )
            throw new Error("SOLANA_TOKEN_ACCOUNTS_NOT_BOUND");
          const before = await this.rpc.request(
            "getMultipleAccounts",
            [writable, { encoding: "base64", commitment: "confirmed" }],
            accountResponse,
          );
          if (before.value.length !== writable.length)
            throw new Error("SOLANA_ACCOUNTS_INVALID");
          const allowedOwners = new Set([
            ...this.policy.allowedAccountOwners,
            TOKEN_PROGRAM_ID.toBase58(),
            TOKEN_2022_PROGRAM_ID.toBase58(),
            SystemProgram.programId.toBase58(),
          ]);
          for (let i = 0; i < writable.length; i++) {
            const value = before.value[i];
            if (value && !allowedOwners.has(value.owner))
              throw new Error("SOLANA_WRITABLE_OWNER_NOT_ALLOWED");
            if (
              value?.owner === SystemProgram.programId.toBase58() &&
              writable[i] !== wallet &&
              writable[i] !== source &&
              writable[i] !== destination
            )
              throw new Error("SOLANA_UNRELATED_SYSTEM_ACCOUNT");
          }
          await update("SIMULATING");
          const fee = await this.rpc.request(
            "getFeeForMessage",
            [
              Buffer.from(transaction.message.serialize()).toString("base64"),
              { commitment: "confirmed" },
            ],
            z.object({
              value: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER)
                .nullable(),
            }),
          );
          if (
            fee.value === null ||
            BigInt(fee.value) > this.policy.maxNetworkFeeLamports
          )
            throw new Error("SOLANA_FEE_BUDGET_EXCEEDED");
          const currentHeight = await this.rpc.request(
            "getBlockHeight",
            [{ commitment: "confirmed" }],
            z.number().int(),
          );
          if (currentHeight >= unsigned.lastValidBlockHeight)
            throw new Error("SOLANA_BLOCKHASH_EXPIRED");
          const simulation = await this.rpc.request(
            "simulateTransaction",
            [
              unsigned.transactionBase64,
              {
                encoding: "base64",
                commitment: "confirmed",
                sigVerify: false,
                replaceRecentBlockhash: true,
                minContextSlot: before.context.slot,
                accounts: { encoding: "base64", addresses: writable },
              },
            ],
            z.object({
              value: z.object({
                err: z.unknown().nullable(),
                accounts: z.array(solanaAccountSchema.nullable()).nullable(),
              }),
            }),
          );
          if (
            simulation.value.err !== null ||
            !simulation.value.accounts ||
            simulation.value.accounts.length !== writable.length
          )
            throw new Error("SOLANA_SIMULATION_FAILED");
          const after = simulation.value.accounts;
          const decode = (index: number, values: typeof before.value) => {
            const value = values[index];
            if (!value) return undefined;
            if (
              value.owner !== TOKEN_PROGRAM_ID.toBase58() &&
              value.owner !== TOKEN_2022_PROGRAM_ID.toBase58()
            )
              return undefined;
            return unpackAccount(
              new PublicKey(writable[index]!),
              accountInfo(value),
              new PublicKey(value.owner),
            );
          };
          for (let i = 0; i < writable.length; i++) {
            const old = decode(i, before.value);
            if (!old || old.owner.toBase58() !== wallet) continue;
            const next = decode(i, after);
            if (
              (!next &&
                !(
                  (nativeInput || nativeOutput) &&
                  old.mint.toBase58() ===
                    "So11111111111111111111111111111111111111112" &&
                  old.amount === 0n
                )) ||
              (next &&
                (next.owner.toBase58() !== wallet ||
                  !next.mint.equals(old.mint) ||
                  next.delegate?.toBase58() !== old.delegate?.toBase58() ||
                  next.delegatedAmount !== old.delegatedAmount ||
                  next.closeAuthority?.toBase58() !==
                    old.closeAuthority?.toBase58() ||
                  next.isFrozen !== old.isFrozen))
            )
              throw new Error("SOLANA_TOKEN_AUTHORITY_CHANGED");
            if (
              writable[i] !== source &&
              writable[i] !== destination &&
              next?.amount !== old.amount
            )
              throw new Error("SOLANA_UNRELATED_TOKEN_CHANGED");
          }
          const sourceIndex = writable.indexOf(source),
            destinationIndex = writable.indexOf(destination),
            walletIndex = writable.indexOf(wallet);
          const preInput = decode(sourceIndex, before.value),
            postInput = decode(sourceIndex, after),
            preOutput = decode(destinationIndex, before.value),
            postOutput = decode(destinationIndex, after);
          if (
            (nativeInput || nativeOutput) &&
            [preInput, preOutput].some(
              (a) =>
                a?.mint.toBase58() ===
                  "So11111111111111111111111111111111111111112" &&
                a.amount !== 0n,
            )
          )
            throw new Error("PREEXISTING_WRAPPED_BALANCE_UNSUPPORTED");
          if (
            (!nativeInput && (!preInput || !postInput)) ||
            (!nativeOutput &&
              (!postOutput ||
                postOutput.owner.toBase58() !== wallet ||
                postOutput.mint.toBase58() !== intent.tokenOut))
          )
            throw new Error("SOLANA_BALANCE_PROOF_UNAVAILABLE");
          const nativeDebit =
            BigInt(before.value[walletIndex]!.lamports) -
            BigInt(after[walletIndex]!.lamports);
          let rentDelta = 0n;
          for (let i = 0; i < writable.length; i++) {
            const old = decode(i, before.value),
              next = decode(i, after);
            const rent = (a: typeof old, values: typeof before.value) =>
              a?.owner.toBase58() === wallet
                ? BigInt(values[i]!.lamports) -
                  (a.mint.toBase58() ===
                  "So11111111111111111111111111111111111111112"
                    ? a.amount
                    : 0n)
                : 0n;
            rentDelta += rent(next, after) - rent(old, before.value);
          }
          const nativeEconomicDelta =
            nativeDebit - BigInt(fee.value) - rentDelta;
          const spent = nativeInput
              ? nativeEconomicDelta
              : preInput!.amount - postInput!.amount,
            received = nativeOutput
              ? -nativeEconomicDelta
              : postOutput!.amount - (preOutput?.amount ?? 0n);
          if (
            spent !== BigInt(intent.amountIn) ||
            received < BigInt(intent.route.quote.minimumAmountOut)
          )
            throw new Error("SOLANA_BALANCE_DELTA_MISMATCH");
          const nativeBefore = before.value[walletIndex],
            nativeAfter = after[walletIndex];
          if (
            !nativeBefore ||
            !nativeAfter ||
            nativeAfter.owner !== SystemProgram.programId.toBase58() ||
            nativeAfter.data[0] !== "" ||
            BigInt(nativeBefore.lamports) - BigInt(nativeAfter.lamports) >
              this.policy.maxNativeDebitLamports +
                (nativeInput ? BigInt(intent.amountIn) : 0n)
          )
            throw new Error("SOLANA_NATIVE_DEBIT_EXCEEDED");
          if (!this.authorized(intent) || Date.now() >= unsigned.validUntil)
            throw new Error("STALE_OR_REVOKED_INTENT");
          if (intent.mode === "LIVE_DRY_RUN")
            return update("DRY_RUN_SUCCEEDED", ["NO_BROADCAST"], {
              simulation: {
                amountIn: spent.toString(),
                amountOut: received.toString(),
                evidence: "BALANCE_DELTA",
              },
              networkFee: String(fee.value),
            });
          const raw = signer.sign(transaction);
          const signature = utils.bytes.bs58.encode(transaction.signatures[0]!);
          await update("SUBMITTING", [], { transactionId: signature });
          try {
            const sent = await this.rpc.request(
              "sendTransaction",
              [
                Buffer.from(raw).toString("base64"),
                {
                  encoding: "base64",
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                  maxRetries: 0,
                },
              ],
              z.string(),
            );
            if (sent !== signature) throw new Error();
            await update("PENDING");
          } catch {
            return update("UNKNOWN", [
              "SUBMISSION_RESULT_UNKNOWN_DO_NOT_RESEND",
            ]);
          }
          return this.confirm(record, intent, wallet);
        } catch (error) {
          return update(
            record.state === "SUBMITTING" || record.state === "PENDING"
              ? "UNKNOWN"
              : "FAILED",
            [
              error instanceof Error && /^[A-Z_]+$/.test(error.message)
                ? error.message
                : "SOLANA_EXECUTION_FAILED",
            ],
          );
        }
      }),
    );
  }
  async confirm(
    record: ExecutionRecord,
    intent: ApprovedTradeIntent,
    wallet: string,
    wait = true,
  ): Promise<ExecutionRecord> {
    if (
      (await this.rpc.request("getGenesisHash", [], z.string())) !==
      this.policy.expectedGenesisHash
    )
      throw new Error("SOLANA_GENESIS_MISMATCH");
    const tokenBalance = z.object({
      accountIndex: z.number().int(),
      mint: z.string(),
      owner: z.string().optional(),
      uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
    });
    const end = Date.now() + (this.policy.receiptTimeoutMs ?? 45000);
    while (Date.now() < end) {
      const response = await this.rpc.request(
        "getTransaction",
        [
          record.transactionId,
          {
            encoding: "json",
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          },
        ],
        z
          .object({
            transaction: z
              .object({
                signatures: z.array(z.string()),
                message: z.object({ accountKeys: z.array(z.string()) }),
              })
              .optional(),
            meta: z
              .object({
                err: z.unknown().nullable(),
                fee: z
                  .number()
                  .int()
                  .nonnegative()
                  .max(Number.MAX_SAFE_INTEGER),
                preTokenBalances: z.array(tokenBalance),
                postTokenBalances: z.array(tokenBalance),
                preBalances: z
                  .array(
                    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
                  )
                  .optional(),
                postBalances: z
                  .array(
                    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
                  )
                  .optional(),
                loadedAddresses: z
                  .object({
                    writable: z.array(z.string()),
                    readonly: z.array(z.string()),
                  })
                  .optional(),
              })
              .nullable(),
          })
          .nullable(),
      );
      if (response?.meta) {
        const meta = response.meta;
        if (meta.err !== null)
          return this.store.put({
            ...record,
            state: "FAILED",
            reasons: ["TRANSACTION_REVERTED"],
            networkFee: String(meta.fee),
            updatedAt: Date.now(),
          });
        const balance = (rows: z.infer<typeof tokenBalance>[], mint: string) =>
          rows
            .filter((row) => row.mint === mint && row.owner === wallet)
            .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n);
        let spent =
            balance(meta.preTokenBalances, intent.tokenIn) -
            balance(meta.postTokenBalances, intent.tokenIn),
          received =
            balance(meta.postTokenBalances, intent.tokenOut) -
            balance(meta.preTokenBalances, intent.tokenOut);
        if (intent.route.quote.nativeInput || intent.route.quote.nativeOutput) {
          try {
            const delta = solanaNativeReceiptDelta(
              response,
              wallet,
              record.transactionId!,
            );
            if (intent.route.quote.nativeInput) spent = -delta;
            if (intent.route.quote.nativeOutput) received = delta;
          } catch {
            return this.store.put({
              ...record,
              state: "UNKNOWN",
              reasons: ["NATIVE_RECEIPT_REQUIRES_RECONCILIATION"],
              networkFee: String(meta.fee),
              updatedAt: Date.now(),
            });
          }
        }
        if (
          spent !== BigInt(intent.amountIn) ||
          received < BigInt(intent.route.quote.minimumAmountOut)
        )
          return this.store.put({
            ...record,
            state: "UNKNOWN",
            reasons: ["RECEIPT_FILL_REQUIRES_RECONCILIATION"],
            updatedAt: Date.now(),
          });
        return this.store.put({
          ...record,
          state: "CONFIRMED",
          actualAmountIn: spent.toString(),
          actualAmountOut: received.toString(),
          networkFee: String(meta.fee),
          reasons: [],
          updatedAt: Date.now(),
        });
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
