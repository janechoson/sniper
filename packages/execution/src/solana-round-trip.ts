import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
} from "@solana/spl-token";
import { z } from "zod";
import type {
  RoundTripResult,
  SwapProvider,
  UnsignedSwapTransaction,
} from "@sniper/core";
import {
  JsonRpcClient,
  solanaAccountSchema,
  accountInfo,
} from "@sniper/chains";
import { formatUnitsSafe, parseUnitsSafe, ratioToNumber } from "@sniper/shared";
export class SolanaRoundTripSimulator {
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly policy: {
      genesisHash: string;
      allowedPrograms: string[];
      allowedAccountOwners: string[];
      maxFeeLamports: bigint;
      maxNativeDebitLamports: bigint;
    },
  ) {}
  async simulate(
    trip: RoundTripResult,
    walletAddress: string,
    buyProvider: SwapProvider,
    sellProvider: SwapProvider,
    prices: { nativeUsd?: string; quoteUsd: string },
  ): Promise<RoundTripResult> {
    if (!trip.sell) return trip;
    try {
      const spendsNative = trip.buy.nativeInput === true;
      if (
        spendsNative &&
        (trip.buy.tokenIn !== "So11111111111111111111111111111111111111112" ||
          !trip.sell.nativeOutput)
      )
        throw new Error("NATIVE_ROUTE_MISMATCH");
      if (
        (await this.rpc.request("getGenesisHash", [], z.string())) !==
        this.policy.genesisHash
      )
        throw new Error("GENESIS_MISMATCH");
      const wallet = new PublicKey(walletAddress);
      const builds = await Promise.all([
        buyProvider.buildSwap(trip.buy, walletAddress),
        sellProvider.buildSwap(trip.sell, walletAddress),
      ]);
      if (builds.some((tx) => tx.family !== "solana"))
        throw new Error("WRONG_TRANSACTION_FAMILY");
      const unsigned = builds as Extract<
        UnsignedSwapTransaction,
        { family: "solana" }
      >[];
      const tables = new Map<string, AddressLookupTableAccount>();
      const transactions = unsigned.map((tx) =>
        VersionedTransaction.deserialize(
          Buffer.from(tx.transactionBase64, "base64"),
        ),
      );
      for (const tx of transactions) {
        if (
          tx.version !== 0 ||
          tx.message.staticAccountKeys[0]?.toBase58() !== walletAddress ||
          tx.message.header.numRequiredSignatures !== 1 ||
          tx.signatures.some((s) => s.some((byte) => byte !== 0))
        )
          throw new Error("AUTHORITY_MISMATCH");
        for (const lookup of tx.message.addressTableLookups) {
          const address = lookup.accountKey.toBase58();
          if (tables.has(address)) continue;
          const value = await this.rpc.request(
            "getAccountInfo",
            [address, { encoding: "base64", commitment: "confirmed" }],
            z.object({ value: solanaAccountSchema.nullable() }),
          );
          if (
            !value.value ||
            value.value.owner !== "AddressLookupTab1e1111111111111111111111111"
          )
            throw new Error("LOOKUP_TABLE_INVALID");
          tables.set(
            address,
            new AddressLookupTableAccount({
              key: lookup.accountKey,
              state: AddressLookupTableAccount.deserialize(
                Buffer.from(value.value.data[0], "base64"),
              ),
            }),
          );
        }
      }
      const decompiled = transactions.map((tx) =>
        TransactionMessage.decompile(tx.message, {
          addressLookupTableAccounts: [...tables.values()],
        }),
      );
      const instructions = decompiled
        .flatMap((tx) => tx.instructions)
        .filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
      const programs = new Set(this.policy.allowedPrograms);
      if (
        instructions.some(
          (ix) =>
            !programs.has(ix.programId.toBase58()) ||
            ix.keys.some((key) => key.isSigner && !key.pubkey.equals(wallet)),
        )
      )
        throw new Error("PROGRAM_NOT_ALLOWED");
      const blockhash = await this.rpc.request(
        "getLatestBlockhash",
        [{ commitment: "confirmed" }],
        z.object({
          value: z.object({
            blockhash: z.string(),
            lastValidBlockHeight: z.number().int(),
          }),
        }),
      );
      const message = new TransactionMessage({
        payerKey: wallet,
        recentBlockhash: blockhash.value.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0n }),
          ...instructions,
        ],
      }).compileToV0Message([...tables.values()]);
      const transaction = new VersionedTransaction(message);
      if (trip.buy.expiresAt <= Date.now() || trip.sell.expiresAt <= Date.now())
        throw new Error("STALE_QUOTE");
      const keys = message.getAccountKeys({
        addressLookupTableAccounts: [...tables.values()],
      });
      const writable: string[] = [];
      for (let i = 0; i < keys.length; i++)
        if (message.isAccountWritable(i))
          writable.push(keys.get(i)!.toBase58());
      if (writable.length > 100) throw new Error("SIMULATION_ACCOUNT_LIMIT");
      const response = z.object({
        context: z.object({ slot: z.number().int() }),
        value: z.array(solanaAccountSchema.nullable()).max(100),
      });
      const mint = await this.rpc.request(
        "getMultipleAccounts",
        [
          [trip.buy.tokenIn, trip.buy.tokenOut],
          { encoding: "base64", commitment: "confirmed" },
        ],
        response,
      );
      if (mint.value.length !== 2 || mint.value.some((v) => !v))
        throw new Error("MINT_UNAVAILABLE");
      const tokenPrograms = mint.value.map((v) => new PublicKey(v!.owner));
      if (
        tokenPrograms.some(
          (p) =>
            !p.equals(TOKEN_PROGRAM_ID) && !p.equals(TOKEN_2022_PROGRAM_ID),
        )
      )
        throw new Error("MINT_OWNER_INVALID");
      const source = getAssociatedTokenAddressSync(
          new PublicKey(trip.buy.tokenIn),
          wallet,
          false,
          tokenPrograms[0],
        ).toBase58(),
        destination = getAssociatedTokenAddressSync(
          new PublicKey(trip.buy.tokenOut),
          wallet,
          false,
          tokenPrograms[1],
        ).toBase58();
      const sourceIndex = writable.indexOf(source),
        destinationIndex = writable.indexOf(destination),
        walletIndex = writable.indexOf(walletAddress);
      if (sourceIndex < 0 || destinationIndex < 0 || walletIndex < 0)
        throw new Error("WRAPPED_NATIVE_OR_NONSTANDARD_ACCOUNT_UNSUPPORTED");
      const before = await this.rpc.request(
        "getMultipleAccounts",
        [writable, { encoding: "base64", commitment: "confirmed" }],
        response,
      );
      const allowedOwners = new Set([
        ...this.policy.allowedAccountOwners,
        TOKEN_PROGRAM_ID.toBase58(),
        TOKEN_2022_PROGRAM_ID.toBase58(),
        SystemProgram.programId.toBase58(),
      ]);
      for (let i = 0; i < writable.length; i++) {
        const value = before.value[i];
        if (value && !allowedOwners.has(value.owner))
          throw new Error(`UNRELATED_ACCOUNT_OWNER:${value.owner}`);
        if (
          value?.owner === SystemProgram.programId.toBase58() &&
          ![walletAddress, source, destination].includes(writable[i]!)
        )
          throw new Error("UNRELATED_NATIVE_ACCOUNT");
      }
      const decode = (values: typeof before.value, index: number) => {
        const value = values[index];
        if (
          !value ||
          ![
            TOKEN_PROGRAM_ID.toBase58(),
            TOKEN_2022_PROGRAM_ID.toBase58(),
          ].includes(value.owner)
        )
          return;
        return unpackAccount(
          new PublicKey(writable[index]!),
          accountInfo(value),
          new PublicKey(value.owner),
        );
      };
      const inputBefore = decode(before.value, sourceIndex),
        outputBefore = decode(before.value, destinationIndex);
      if (spendsNative && inputBefore && inputBefore.amount !== 0n)
        throw new Error("PREEXISTING_WRAPPED_BALANCE_UNSUPPORTED");
      if (
        (!spendsNative &&
          (!inputBefore || inputBefore.amount < BigInt(trip.buy.amountIn))) ||
        (outputBefore?.amount ?? 0n) !== 0n
      )
        throw new Error("SIMULATION_BALANCE_REQUIREMENTS_NOT_MET");
      const result = await this.rpc.request(
        "simulateTransaction",
        [
          Buffer.from(transaction.serialize()).toString("base64"),
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
        result.value.err !== null ||
        !result.value.accounts ||
        result.value.accounts.length !== writable.length
      )
        throw new Error("SEQUENTIAL_SIMULATION_FAILED");
      const after = result.value.accounts;
      for (let i = 0; i < writable.length; i++) {
        const old = decode(before.value, i);
        if (!old || !old.owner.equals(wallet)) continue;
        const next = decode(after, i);
        if (
          (!next &&
            !(
              spendsNative &&
              i === sourceIndex &&
              old.mint.toBase58() === trip.buy.tokenIn &&
              old.amount === 0n
            )) ||
          (next &&
            (!next.owner.equals(wallet) ||
              !next.mint.equals(old.mint) ||
              next.delegate?.toBase58() !== old.delegate?.toBase58() ||
              next.delegatedAmount !== old.delegatedAmount ||
              next.closeAuthority?.toBase58() !==
                old.closeAuthority?.toBase58() ||
              next.isFrozen !== old.isFrozen))
        )
          throw new Error("WALLET_TOKEN_AUTHORITY_CHANGED");
        if (
          i !== sourceIndex &&
          i !== destinationIndex &&
          next?.amount !== old.amount
        )
          throw new Error("UNRELATED_TOKEN_CHANGED");
      }
      const inputAfter = decode(after, sourceIndex);
      if (!spendsNative && !inputAfter) throw new Error("QUOTE_ACCOUNT_CLOSED");
      const combinedFee = await this.rpc.request(
        "getFeeForMessage",
        [
          Buffer.from(message.serialize()).toString("base64"),
          { commitment: "confirmed" },
        ],
        z.object({ value: z.number().int().nonnegative().nullable() }),
      );
      if (
        combinedFee.value === null ||
        BigInt(combinedFee.value) > this.policy.maxFeeLamports
      )
        throw new Error("FEE_BUDGET_EXCEEDED");
      let rentDelta = 0n;
      for (let i = 0; i < writable.length; i++) {
        const prior = decode(before.value, i),
          next = decode(after, i);
        if (next?.owner.equals(wallet))
          rentDelta +=
            BigInt(after[i]!.lamports) -
            (prior?.owner.equals(wallet)
              ? BigInt(before.value[i]!.lamports)
              : 0n);
        else if (prior?.owner.equals(wallet))
          rentDelta -= BigInt(before.value[i]!.lamports);
      }
      const returned = spendsNative
        ? BigInt(trip.buy.amountIn) -
          BigInt(before.value[walletIndex]!.lamports) +
          BigInt(after[walletIndex]!.lamports) +
          BigInt(combinedFee.value) +
          rentDelta
        : inputAfter!.amount - inputBefore!.amount + BigInt(trip.buy.amountIn);
      if (returned < BigInt(trip.sell.minimumAmountOut))
        throw new Error("ROUND_TRIP_OUTPUT_TOO_LOW");
      const nativeBefore = before.value[walletIndex],
        nativeAfter = after[walletIndex];
      if (
        !nativeBefore ||
        !nativeAfter ||
        nativeAfter.owner !== SystemProgram.programId.toBase58() ||
        nativeAfter.data[0] !== ""
      )
        throw new Error("WALLET_ACCOUNT_CHANGED");
      const debit =
        BigInt(nativeBefore.lamports) - BigInt(nativeAfter.lamports);
      if (debit > this.policy.maxNativeDebitLamports * 2n)
        throw new Error("NATIVE_BUDGET_EXCEEDED");
      const feeResponse = z.object({
        value: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .nullable(),
      });
      const fees = await Promise.all(
        transactions.map((tx) =>
          this.rpc.request(
            "getFeeForMessage",
            [
              Buffer.from(tx.message.serialize()).toString("base64"),
              { commitment: "confirmed" },
            ],
            feeResponse,
          ),
        ),
      );
      if (
        fees.some(
          (f) =>
            f.value === null || BigInt(f.value) > this.policy.maxFeeLamports,
        )
      )
        throw new Error("FEE_BUDGET_EXCEEDED");
      const buyNative =
          BigInt(fees[0]!.value!) +
          (spendsNative
            ? rentDelta > 0n
              ? rentDelta
              : 0n
            : debit > 0n
              ? debit
              : 0n),
        sellNative = BigInt(fees[1]!.value!);
      const nativeUsd = prices.nativeUsd
        ? parseUnitsSafe(prices.nativeUsd, 18)
        : undefined;
      const usd = (amount: bigint) =>
        nativeUsd === undefined
          ? undefined
          : formatUnitsSafe(
              (amount * nativeUsd + 10n ** 9n - 1n) / 10n ** 9n,
              18,
            );
      const inputUsd =
          (BigInt(trip.buy.amountIn) * parseUnitsSafe(prices.quoteUsd, 18)) /
          10n ** BigInt(trip.buy.decimalsIn),
        outputUsd =
          (BigInt(trip.sell.minimumAmountOut) *
            parseUnitsSafe(prices.quoteUsd, 18)) /
          10n ** BigInt(trip.buy.decimalsIn);
      const loss =
        nativeUsd === undefined
          ? undefined
          : ratioToNumber(
              (inputUsd -
                outputUsd +
                ((buyNative + sellNative) * nativeUsd) / 10n ** 9n) *
                100n,
              inputUsd,
            );
      return {
        ...trip,
        buy: { ...trip.buy, estimatedNetworkFeeUsd: usd(buyNative) },
        sell: { ...trip.sell, estimatedNetworkFeeUsd: usd(sellNative) },
        sellability: "SELLABLE",
        evidence: "TRANSACTION_SIMULATION",
        roundTripLossPct: loss === undefined ? undefined : Math.max(0, loss),
        reasons:
          nativeUsd === undefined
            ? ["NATIVE_USD_PRICE_UNKNOWN"]
            : [
                "COMBINED_SIMULATION_NO_BROADCAST",
                "NATIVE_COST_CONSERVATIVE_INCLUDES_RENT",
              ],
      };
    } catch (error) {
      const reason =
        error instanceof Error &&
        /^[A-Z_]+(?::[1-9A-HJ-NP-Za-km-z]{32,44})?$/.test(error.message)
          ? error.message
          : "SOLANA_ROUND_TRIP_SIMULATION_UNAVAILABLE";
      return {
        ...trip,
        sellability: "UNKNOWN",
        evidence: "QUOTE_ONLY",
        reasons: [reason],
      };
    }
  }
}
