import {
  AccountState,
  DefaultAccountStateLayout,
  ExtensionType,
  getTypeLen,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { CandidateRejected } from "../src/domain.js";
import { RiskEngine } from "../src/risk.js";
import {
  inspectMint,
  requireCompatibleToken,
  tokenAccountAddress,
} from "../src/token-program.js";
import { MINT, settings, snapshot, WALLET } from "./fixtures.js";
import { metadataFixture, mintFixture } from "./token-program-fixtures.js";
test("program owner determines legacy SPL and Token-2022 independently of mint length", () => {
  assert.equal(
    inspectMint(MINT, mintFixture(TOKEN_PROGRAM_ID)).tokenProgram,
    "LEGACY_SPL",
  );
  const compact = inspectMint(MINT, mintFixture());
  assert.equal(compact.tokenProgram, "TOKEN_2022");
  assert.equal(compact.decimals, 6);
  assert.equal(compact.decision, "ALLOW");
  const metadata = inspectMint(MINT, metadataFixture());
  assert.equal(metadata.tokenProgram, "TOKEN_2022");
  assert.equal(metadata.decision, "ALLOW");
  assert.deepEqual(
    metadata.extensions.map((e) => e.type),
    ["MetadataPointer", "TokenMetadata"],
  );
  assert.throws(
    () =>
      inspectMint(MINT, {
        ...mintFixture(),
        owner: Keypair.generate().publicKey,
      }),
    (error) =>
      error instanceof CandidateRejected &&
      error.code === "UNSUPPORTED_TOKEN_PROGRAM",
  );
});
test("unsupported and unknown extensions fail closed for the candidate with exact extension IDs", () => {
  const unknown = inspectMint(
    MINT,
    mintFixture(TOKEN_2022_PROGRAM_ID, [
      { type: 65500, data: Buffer.alloc(1) },
    ]),
  );
  assert.equal(unknown.decision, "SKIP");
  assert.equal(unknown.extensions[0]!.typeId, 65500);
  assert.throws(
    () => requireCompatibleToken(unknown),
    (error) =>
      error instanceof CandidateRejected &&
      error.code === "UNSUPPORTED_TOKEN_EXTENSION",
  );
  for (const type of [
    ExtensionType.TransferFeeConfig,
    ExtensionType.TransferHook,
    ExtensionType.ConfidentialTransferMint,
  ]) {
    const r = inspectMint(
      MINT,
      mintFixture(TOKEN_2022_PROGRAM_ID, [
        { type, data: Buffer.alloc(getTypeLen(type)) },
      ]),
    );
    assert.equal(r.decision, "SKIP");
    assert.equal(r.extensions[0]!.policy, "UNSUPPORTED");
  }
});
test("frozen default state and active delegation/control extensions are critical", () => {
  const frozen = Buffer.alloc(getTypeLen(ExtensionType.DefaultAccountState));
  DefaultAccountStateLayout.encode({ state: AccountState.Frozen }, frozen);
  const r = inspectMint(
    MINT,
    mintFixture(TOKEN_2022_PROGRAM_ID, [
      { type: ExtensionType.DefaultAccountState, data: frozen },
    ]),
  );
  assert.equal(r.extensionRisk, "CRITICAL");
  assert.throws(
    () => requireCompatibleToken(r),
    (error) =>
      error instanceof CandidateRejected &&
      error.code === "CRITICAL_TOKEN_EXTENSION",
  );
  for (const type of [
    ExtensionType.PermanentDelegate,
    ExtensionType.MintCloseAuthority,
  ]) {
    const active = Keypair.generate().publicKey.toBuffer();
    assert.equal(
      inspectMint(
        MINT,
        mintFixture(TOKEN_2022_PROGRAM_ID, [{ type, data: active }]),
      ).decision,
      "SKIP",
    );
  }
  const safe = Buffer.alloc(getTypeLen(ExtensionType.DefaultAccountState));
  DefaultAccountStateLayout.encode({ state: AccountState.Initialized }, safe);
  assert.equal(
    inspectMint(
      MINT,
      mintFixture(TOKEN_2022_PROGRAM_ID, [
        { type: ExtensionType.DefaultAccountState, data: safe },
      ]),
    ).decision,
    "ALLOW",
  );
});
test("malformed or duplicate extensions and uninitialized mint never pass parsing", () => {
  assert.throws(
    () => inspectMint(MINT, { ...mintFixture(), data: Buffer.alloc(397) }),
    /INVALID_MINT_LAYOUT/,
  );
  const e = { type: ExtensionType.MetadataPointer, data: Buffer.alloc(64) };
  assert.throws(
    () => inspectMint(MINT, mintFixture(TOKEN_2022_PROGRAM_ID, [e, e])),
    /INVALID_MINT_LAYOUT/,
  );
  assert.throws(
    () =>
      inspectMint(
        MINT,
        mintFixture(TOKEN_2022_PROGRAM_ID, [
          { type: ExtensionType.MetadataPointer, data: Buffer.alloc(2) },
        ]),
      ),
    /INVALID_MINT_LAYOUT/,
  );
});
test("Token-2022 uses its own ATA derivation and KRONOS BUY cannot override rejected extension", () => {
  const wallet = new PublicKey(WALLET),
    mint = new PublicKey(MINT);
  assert.notEqual(
    tokenAccountAddress(wallet, mint, TOKEN_PROGRAM_ID).toBase58(),
    tokenAccountAddress(wallet, mint, TOKEN_2022_PROGRAM_ID).toBase58(),
  );
  const snap = snapshot();
  snap.tokenExecution = inspectMint(
    MINT,
    mintFixture(TOKEN_2022_PROGRAM_ID, [
      {
        type: ExtensionType.TransferHook,
        data: Buffer.alloc(getTypeLen(ExtensionType.TransferHook)),
      },
    ]),
  );
  assert.equal(snap.kronos!.action, "BUY");
  assert.equal(
    new RiskEngine().evaluate(snap, settings, {
      balance: 1000000000n,
      pending: 0n,
      positions: 0,
      duplicate: false,
      entriesEnabled: true,
    }).allowed,
    false,
  );
});
test("SPL dependency uses patched pure-JS bigint conversion for wide buffers", () => {
  const require = createRequire(import.meta.url),
    spl = createRequire(require.resolve("@solana/spl-token")),
    layout = createRequire(spl.resolve("@solana/buffer-layout-utils"));
  const bigint = layout("bigint-buffer") as {
    toBigIntLE(buffer: Buffer): bigint;
    toBufferLE(value: bigint, width: number): Buffer;
  };
  assert.equal(
    bigint.toBigIntLE(Buffer.alloc(64, 1)),
    BigInt("0x" + "01".repeat(64)),
  );
  assert.equal(bigint.toBigIntLE(bigint.toBufferLE(123456789n, 8)), 123456789n);
});
