import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  JupiterExecutionProvider,
  type ExecutionQuote,
} from "../src/execution-provider.js";
import { tokenAccountAddress } from "../src/token-program.js";
import { liveConfig, SOL } from "../src/live-config.js";
import type { Solana } from "../src/solana.js";
import { MINT } from "./fixtures.js";
import {
  receiptRentDelta,
  makeFillAccounting,
} from "../src/fill-accounting.js";
import type { LiveExecution } from "../src/live-types.js";

function providerFixture(issue = "") {
  const signer = Keypair.generate(),
    wallet = signer.publicKey,
    mint = new PublicKey(MINT),
    amount = 1000000n;
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1000000000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    mintData,
  );
  const account = (n: bigint) => {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint,
        owner: wallet,
        amount: n,
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
    return data;
  };
  const info = (
    data: Buffer,
    lamports = 2039280,
    owner = TOKEN_PROGRAM_ID,
  ) => ({ data, lamports, owner, executable: false, rentEpoch: 0 });
  const wrapped = tokenAccountAddress(
    wallet,
    new PublicKey(SOL),
    TOKEN_PROGRAM_ID,
  );
  const instructions = [
    SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: issue === "recipient" ? mint : wrapped,
      lamports: Number(amount),
    }),
  ];
  if (issue === "program")
    instructions.push(
      new TransactionInstruction({
        programId: mint,
        keys: [],
        data: Buffer.alloc(0),
      }),
    );
  if (issue === "token-authority")
    instructions.push(
      new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [],
        data: Buffer.from([6]),
      }),
    );
  const message = new TransactionMessage({
    payerKey: issue === "signer" ? mint : wallet,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const q: ExecutionQuote = {
    provider: "JUPITER",
    chain: "solana",
    wallet: wallet.toBase58(),
    mint: MINT,
    side: "BUY",
    amount: String(amount),
    at: Date.now(),
    maxSlippageBps: 100,
    order: {
      inputMint: SOL,
      outputMint: MINT,
      inAmount: String(amount),
      outAmount: "1000000",
      otherAmountThreshold: "990000",
      swapMode: "ExactIn",
      slippageBps: 100,
      taker: wallet.toBase58(),
      router: "metis",
      transaction: Buffer.from(tx.serialize()).toString("base64"),
      requestId: "fixture",
      signatureFeeLamports: 10000,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
      signatureFeePayer: wallet.toBase58(),
      priceImpactPct: 0.1,
      routePlan: [
        { swapInfo: { label: "fixture", inputMint: SOL, outputMint: MINT } },
      ],
    },
  };
  let simulated = 0;
  const rpc = {
    connection: {
      getAccountInfo: async () => info(mintData, 2039280),
      getMultipleAccountsInfo: async () => [
        info(Buffer.alloc(0), 1000000000, SystemProgram.programId),
        info(account(0n)),
      ],
      simulateTransaction: async () => {
        simulated++;
        return {
          value: {
            err: issue === "simulation" ? { Custom: 1 } : null,
            accounts: [
              {
                ...info(
                  Buffer.alloc(0),
                  issue === "debit" ? 900000000 : 998990000,
                  SystemProgram.programId,
                ),
                owner: SystemProgram.programId.toBase58(),
                data: ["", "base64"],
              },
              {
                ...info(account(issue === "minimum" ? 1n : 1000000n)),
                owner: TOKEN_PROGRAM_ID.toBase58(),
                data: [
                  account(issue === "minimum" ? 1n : 1000000n).toString(
                    "base64",
                  ),
                  "base64",
                ],
              },
            ],
          },
        };
      },
    },
  } as unknown as Solana;
  const config = {
    ...liveConfig({}),
    WALLET_PUBLIC_KEY: wallet.toBase58(),
    SOLANA_PRIVATE_KEY: JSON.stringify([...signer.secretKey]),
  };
  const provider = new JupiterExecutionProvider(rpc, config);
  return { provider, q, simulations: () => simulated };
}
for (const issue of [
  "signer",
  "recipient",
  "program",
  "token-authority",
  "simulation",
  "debit",
  "minimum",
])
  test(`ported real transaction/simulation validator rejects ${issue} before signing`, async () => {
    const f = providerFixture(issue);
    await assert.rejects(f.provider.simulate(f.q));
    await assert.rejects(
      f.provider.execute(f.q, () => assert.fail("no submit")),
      /UNSIMULATED/,
    );
  });
test("validated unsigned transaction reaches immediate authority callback; callback abort prevents ANY sign or submit", async () => {
  const f = providerFixture();
  await f.provider.simulate(f.q);
  assert.equal(f.simulations(), 1);
  let boundary = 0;
  await assert.rejects(
    f.provider.execute(
      f.q,
      () => assert.fail("broadcast forbidden"),
      () => {
        boundary++;
        throw Error("REVOKED_BEFORE_SIGN");
      },
    ),
    /REVOKED_BEFORE_SIGN/,
  );
  assert.equal(boundary, 1);
});
test("receipt accounting leaves unknown rent/extra debit unclassified; no fee/slippage/priority double-count", () => {
  const e = {
    id: "fixture",
    intent: { mode: "live", side: "BUY", amount: "1000000" },
  } as LiveExecution;
  const a = makeFillAccounting(
    e,
    -1040000n,
    1000000n,
    10000n,
    null,
    6,
    null,
    Date.now(),
    "RECONCILIATION_TIME",
  );
  assert.equal(a.tradingLamports, "1000000");
  assert.equal(a.networkFeeLamports, "10000");
  assert.equal(a.recoverableRentDeltaLamports, null);
  assert.equal(a.unclassifiedDebitLamports, null);
  assert.equal(a.priorityFeeLamports, null);
  assert.equal(a.priceUsd, null);
  const b = makeFillAccounting(
    e,
    -1040000n,
    1000000n,
    10000n,
    30000n,
    6,
    null,
    Date.now(),
    "RECONCILIATION_TIME",
  );
  assert.equal(b.unclassifiedDebitLamports, "0");
  assert.equal(b.recoverableRentDeltaLamports, "30000");
  assert.equal(
    receiptRentDelta({} as Parameters<typeof receiptRentDelta>[0], "wallet"),
    null,
  );
});
