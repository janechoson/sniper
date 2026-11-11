import {
  AccountLayout,
  AccountState,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../src/config.js";
import { Blocked, CandidateRejected } from "../src/domain.js";
import { JupiterExecutionProvider } from "../src/execution-provider.js";
import { SOL } from "../src/gmgn.js";
import { Solana } from "../src/solana.js";
import { Store } from "../src/store.js";
import { json, safeError } from "../src/util.js";
import { MINT, quote, WALLET } from "./fixtures.js";
import { metadataFixture } from "./token-program-fixtures.js";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
test("Jupiter optional impact sentinel -1/null/missing stays UNKNOWN without invalidating the critical quote contract", async () => {
  const old = env.WALLET_PUBLIC_KEY;
  env.WALLET_PUBLIC_KEY = WALLET;
  try {
    const p = new JupiterExecutionProvider(new Solana());
    for (const impact of ["-1", null, "", undefined, "not supplied"]) {
      p.http.request = async () => ({
        ...quote("BUY", 500000n).order,
        priceImpactPct: impact,
      });
      const q = await p.quoteBuy(MINT, 500000n, 100);
      assert.equal(q.order.priceImpactPct, undefined);
    }
    p.http.request = async () => ({
      ...quote("BUY", 500000n).order,
      priceImpactPct: "0.5",
    });
    assert.equal(
      (await p.quoteBuy(MINT, 500000n, 100)).order.priceImpactPct,
      0.5,
    );
  } finally {
    env.WALLET_PUBLIC_KEY = old;
  }
});
function harness(
  principal = 500_000n,
  recipient?: PublicKey,
  tokenProgram = TOKEN,
) {
  const rpc = new Solana(),
    provider = new JupiterExecutionProvider(rpc),
    q = quote("BUY", 500_000n),
    wallet = new PublicKey(WALLET);
  const wrapped = PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), TOKEN.toBuffer(), new PublicKey(SOL).toBuffer()],
    ATA,
  )[0];
  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: recipient ?? wrapped,
        lamports: principal,
      }),
    ],
  }).compileToV0Message();
  q.order.transaction = Buffer.from(
    new VersionedTransaction(message).serialize(),
  ).toString("base64");
  const data = Buffer.alloc(82);
  data[45] = 1;
  rpc.connection.getAccountInfo = async () =>
    ({ owner: tokenProgram, data }) as never;
  rpc.connection.getMultipleAccountsInfo = async () =>
    [{ lamports: 1_000_000_000 }, null] as never;
  let simulationCalls = 0;
  rpc.connection.simulateTransaction = (async () => {
    simulationCalls++;
    const tokens = Buffer.alloc(165);
    AccountLayout.encode(
      {
        mint: new PublicKey(MINT),
        owner: wallet,
        amount: 1_000_000n,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: AccountState.Initialized,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      tokens,
    );
    return {
      value: {
        err: null,
        accounts: [
          { lamports: 999495000, data: ["", "base64"] },
          {
            lamports: 0,
            owner: tokenProgram.toBase58(),
            executable: false,
            rentEpoch: 0,
            data: [tokens.toString("base64"), "base64"],
          },
        ],
      },
    };
  }) as never;
  return { rpc, provider, q, calls: () => simulationCalls };
}
test("unsigned real transaction structure is inspected and simulated without a wallet secret", async () => {
  const old = env.WALLET_PUBLIC_KEY;
  env.WALLET_PUBLIC_KEY = WALLET;
  try {
    const h = harness();
    await h.provider.simulate(h.q);
    assert.equal(h.calls(), 1);
  } finally {
    env.WALLET_PUBLIC_KEY = old;
  }
});
test("serialized transaction cannot hide a tenfold principal behind a valid quote", async () => {
  const old = env.WALLET_PUBLIC_KEY;
  env.WALLET_PUBLIC_KEY = WALLET;
  try {
    const h = harness(5_000_000n);
    await assert.rejects(() => h.provider.simulate(h.q), /PRINCIPAL_MISMATCH/);
    assert.equal(h.calls(), 0);
  } finally {
    env.WALLET_PUBLIC_KEY = old;
  }
});
test("serialized transaction cannot transfer SOL to an arbitrary recipient", async () => {
  const old = env.WALLET_PUBLIC_KEY;
  env.WALLET_PUBLIC_KEY = WALLET;
  try {
    const h = harness(500_000n, Keypair.generate().publicKey);
    await assert.rejects(
      () => h.provider.simulate(h.q),
      /UNEXPECTED_SOL_TRANSFER/,
    );
  } finally {
    env.WALLET_PUBLIC_KEY = old;
  }
});
test("simulation balance mismatch blocks signing even if transaction and quote agree", async () => {
  const old = env.WALLET_PUBLIC_KEY;
  env.WALLET_PUBLIC_KEY = WALLET;
  try {
    const h = harness();
    h.rpc.connection.simulateTransaction = (async () => ({
      value: { err: null, accounts: [{ lamports: 999495000 }, null] },
    })) as never;
    await assert.rejects(
      () => h.provider.simulate(h.q),
      (error: unknown) =>
        error instanceof CandidateRejected &&
        error.code === "TOKEN_SAFETY_FAILED" &&
        error.details.reason === "SIMULATED_BALANCE_MISMATCH",
    );
  } finally {
    env.WALLET_PUBLIC_KEY = old;
  }
});
test("logs, SQLite JSON and safe errors never expose secret fields or configured values", () => {
  const before = process.env.SOLANA_PRIVATE_KEY,
    secret = "fixture-wallet-secret-never-log";
  process.env.SOLANA_PRIVATE_KEY = secret;
  const store = new Store(":memory:");
  try {
    const payload = {
      privateKey: secret,
      mnemonic: "fixture seed",
      nested: { api_key: "fixture-api" },
      error: "prefix " + secret,
      publicWallet: WALLET,
    };
    const output = json(payload);
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes("fixture seed"));
    assert.ok(!output.includes("fixture-api"));
    assert.ok(output.includes(WALLET));
    store.record("audit", MINT, payload);
    assert.ok(!JSON.stringify(store.recent("audit")).includes(secret));
    assert.equal(safeError(new Error(secret)), "OPERATION_FAILED");
  } finally {
    store.close();
    if (before === undefined) delete process.env.SOLANA_PRIVATE_KEY;
    else process.env.SOLANA_PRIVATE_KEY = before;
  }
});
test("malformed Token-2022 mint is rejected before signing or simulation", async () => {
  const old = env.WALLET_PUBLIC_KEY;
  env.WALLET_PUBLIC_KEY = WALLET;
  try {
    const h = harness();
    h.rpc.connection.getAccountInfo = async () =>
      ({
        owner: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
        data: Buffer.alloc(397),
      }) as never;
    await assert.rejects(
      () => h.provider.simulate(h.q),
      (error: unknown) =>
        error instanceof Blocked &&
        error.code === "INVALID_MINT_LAYOUT" &&
        error.classification === "CANDIDATE_REJECTED",
    );
    assert.equal(h.calls(), 0);
  } finally {
    env.WALLET_PUBLIC_KEY = old;
  }
});
test("metadata-only Token-2022 reaches simulation with the Token-2022 ATA", async () => {
  const old = env.WALLET_PUBLIC_KEY;
  env.WALLET_PUBLIC_KEY = WALLET;
  try {
    const h = harness(500_000n, undefined, TOKEN_2022_PROGRAM_ID);
    h.rpc.connection.getAccountInfo = async () => metadataFixture();
    await h.provider.simulate(h.q);
    assert.equal(h.calls(), 1);
  } finally {
    env.WALLET_PUBLIC_KEY = old;
  }
});
test("token-specific simulation error is a candidate rejection, RPC failure remains systemic", async () => {
  const old = env.WALLET_PUBLIC_KEY;
  env.WALLET_PUBLIC_KEY = WALLET;
  try {
    const h = harness();
    h.rpc.connection.simulateTransaction = (async () => ({
      value: {
        err: { InstructionError: [2, { Custom: 6001 }] },
        logs: ["Program failed: fixture simulation diagnostic"],
        accounts: null,
      },
    })) as never;
    await assert.rejects(
      () => h.provider.simulate(h.q),
      (e) =>
        e instanceof CandidateRejected &&
        e.code === "TOKEN_SIMULATION_FAILED" &&
        JSON.stringify(e.details.simulationError) ===
          JSON.stringify({ InstructionError: [2, { Custom: 6001 }] }) &&
        JSON.stringify(e.details.logs) ===
          JSON.stringify(["Program failed: fixture simulation diagnostic"]),
    );
    h.rpc.connection.getAccountInfo = async () => {
      throw new Blocked("RPC_TIMEOUT");
    };
    await assert.rejects(
      () => h.provider.simulate(h.q),
      (e) =>
        e instanceof Blocked &&
        !(e instanceof CandidateRejected) &&
        e.code === "RPC_TIMEOUT",
    );
  } finally {
    env.WALLET_PUBLIC_KEY = old;
  }
});
test("unavailable BUY/SELL routes are typed candidate failures; provider authentication/server failures stay systemic", async () => {
  const old = env.WALLET_PUBLIC_KEY;
  env.WALLET_PUBLIC_KEY = WALLET;
  try {
    const h = harness();
    h.provider.http.request = async () => {
      throw new Blocked("JUPITER_HTTP_400");
    };
    await assert.rejects(
      () => h.provider.quoteBuy(MINT, 500000n, 100),
      (e) => e instanceof CandidateRejected && e.code === "NO_BUY_ROUTE",
    );
    await assert.rejects(
      () => h.provider.quoteSell(MINT, 500000n, 100, true),
      (e) => e instanceof CandidateRejected && e.code === "NO_SELL_ROUTE",
    );
    h.provider.http.request = async () => {
      throw new Blocked("JUPITER_HTTP_503");
    };
    await assert.rejects(
      () => h.provider.quoteBuy(MINT, 500000n, 100),
      (e) => e instanceof Blocked && !(e instanceof CandidateRejected),
    );
  } finally {
    env.WALLET_PUBLIC_KEY = old;
  }
});
