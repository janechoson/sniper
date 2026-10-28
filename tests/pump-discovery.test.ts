import { afterEach, describe, expect, it, vi } from "vitest";
import anchor, {
  BorshAccountsCoder,
  BorshInstructionCoder,
  BorshCoder,
  utils,
  type Idl,
} from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  AccountLayout,
  MintLayout,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  JsonRpcClient,
  PumpDiscoveryDecoder,
  PumpMarketReader,
  RollingMarketBook,
  SolanaProgramDiscovery,
  SolanaTransactionReader,
  curvePda,
  pumpPoolPda,
  WSOL,
  type PumpFamily,
  type SolanaTransaction,
} from "@sniper/chains";
import {
  defaultSettings,
  dexDeploymentSchema,
  loadEnv,
  chainsFromEnv,
  realConfigSchema,
} from "@sniper/config";
import { MemoryRepository } from "@sniper/storage";
import { TradingWallet } from "@sniper/wallet";
import { RealTradingEngine } from "@sniper/engine";
import {
  rugPolicySchema,
  type TokenDiscoveryEvent,
  type AIProvider,
} from "@sniper/core";
import { FeatureEngine, RugCheckEngine } from "@sniper/features";
import { loadVerifiedIdl } from "../packages/chains/src/real/idl";
import { analyzeObservation } from "../packages/engine/src/observation-analysis";
import { analyzeCandidate } from "../packages/engine/src/analyzer";
import {
  DiscoveryMonitor,
  hasRecordedTokenEntry,
} from "../packages/engine/src/discovery-monitor";
const clients: JsonRpcClient[] = [];
type IdlType = Idl["instructions"][number]["args"][number]["type"];
afterEach(() => {
  for (const rpc of clients.splice(0)) rpc.close();
  vi.restoreAllMocks();
});
let seed = 1;
const address = () =>
  Keypair.fromSeed(new Uint8Array(32).fill((seed++ % 250) + 1)).publicKey;
function zero(idl: Idl, type: IdlType): unknown {
  if (type === "pubkey") return PublicKey.default;
  if (type === "bool") return false;
  if (type === "string") return "";
  if (typeof type === "string")
    return /^(u|i)(64|128|256)$/.test(type) ? new anchor.BN(0) : 0;
  if ("array" in type)
    return Array.from({ length: Number(type.array[1]) }, () =>
      zero(idl, type.array[0]),
    );
  if ("vec" in type) return [];
  if ("option" in type) return null;
  if ("defined" in type) {
    const definition = idl.types!.find(
      (value) => value.name === type.defined.name,
    )!.type;
    if (definition.kind !== "struct")
      throw new Error("FIXTURE_TYPE_UNSUPPORTED");
    const fields = definition.fields ?? [];
    return fields.length && typeof fields[0] === "object" && "name" in fields[0]
      ? Object.fromEntries(
          fields.map((field) => {
            const f = field as { name: string; type: IdlType };
            return [f.name, zero(idl, f.type)];
          }),
        )
      : fields.map((field) => zero(idl, field as IdlType));
  }
  throw new Error("FIXTURE_TYPE_UNSUPPORTED");
}
function values(idl: Idl, name: string) {
  return zero(idl, { defined: { name } }) as Record<string, unknown>;
}
function creation(
  family: PumpFamily,
  instructionName = family === "pump-fun" ? "create_v2" : "create_pool",
  mint = address(),
) {
  const idl = loadVerifiedIdl(family).idl,
    definition = idl.instructions.find((ix) => ix.name === instructionName)!;
  const named = Object.fromEntries(
    definition.accounts.map((account) => [
      account.name,
      "address" in account && account.address
        ? new PublicKey(account.address)
        : address(),
    ]),
  );
  named.program = new PublicKey(idl.address);
  named.event_authority = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    new PublicKey(idl.address),
  )[0];
  const creator = address();
  const args = Object.fromEntries(
    definition.args.map((arg) => [arg.name, zero(idl, arg.type)]),
  );
  if (family === "pump-fun") {
    Object.assign(args, {
      name: "QA Pump",
      symbol: "QAP",
      uri: "https://example.invalid/qa",
      creator,
    });
    named.mint = mint;
    named.bonding_curve = new PublicKey(curvePda(mint.toBase58(), idl.address));
    named.associated_bonding_curve = getAssociatedTokenAddressSync(
      mint,
      named.bonding_curve!,
      true,
      named.token_program!,
    );
  } else {
    Object.assign(args, {
      index: 0,
      base_amount_in: new anchor.BN(1000),
      quote_amount_in: new anchor.BN(1000),
      coin_creator: creator,
    });
    named.base_mint = mint;
    named.quote_mint = new PublicKey(WSOL);
    named.base_token_program = TOKEN_2022_PROGRAM_ID;
    named.quote_token_program = TOKEN_PROGRAM_ID;
    named.pool = new PublicKey(
      pumpPoolPda(
        0,
        named.creator!.toBase58(),
        mint.toBase58(),
        WSOL,
        idl.address,
      ),
    );
    named.pool_base_token_account = getAssociatedTokenAddressSync(
      mint,
      named.pool,
      true,
      named.base_token_program,
    );
    named.pool_quote_token_account = getAssociatedTokenAddressSync(
      named.quote_mint,
      named.pool,
      true,
      named.quote_token_program,
    );
  }
  const keys = definition.accounts.map((account) =>
    named[account.name]!.toBase58(),
  );
  const encoded = new BorshInstructionCoder(idl).encode(instructionName, args);
  const ix = {
    programIdIndex: keys.length,
    accounts: keys.map((_, index) => index),
    data: utils.bytes.bs58.encode(encoded),
  };
  const tx: SolanaTransaction = {
    slot: 100,
    blockTime: Math.floor(Date.now() / 1000),
    version: 0,
    transaction: {
      message: { accountKeys: [...keys, idl.address], instructions: [ix] },
    },
    meta: { err: null, innerInstructions: [], logMessages: [] },
  };
  const decoder = new PumpDiscoveryDecoder(family, family, [
    { address: WSOL, symbol: "WSOL", decimals: 9 },
  ]);
  const event = decoder.decode(tx, "fixture-pump-signature")[0]!;
  return {
    family,
    idl,
    definition,
    named,
    args,
    mint,
    creator,
    tx,
    ix,
    event,
    decoder,
  };
}
function rpcFixture(
  handler: (method: string, params: unknown[]) => unknown | Promise<unknown>,
) {
  const rpc = new JsonRpcClient("fixture", "http://127.0.0.1/unused", {
    rps: 100000,
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: await handler(body.method, body.params),
      });
    },
  });
  clients.push(rpc);
  return rpc;
}
const account = (bytes: Buffer, owner: string) => ({
  data: [bytes.toString("base64"), "base64"],
  owner,
  executable: false,
  lamports: 1000000,
  rentEpoch: 0,
});
function mintBytes(initialized = true) {
  const bytes = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1000000000n,
      decimals: 6,
      isInitialized: initialized,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    bytes,
  );
  return bytes;
}
function vaultBytes(mint: PublicKey, owner: PublicKey, amount: bigint) {
  const bytes = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
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
    bytes,
  );
  return bytes;
}
async function marketFixture(
  family: PumpFamily,
  overrides: Record<string, unknown> = {},
  legacy = false,
) {
  const launch = creation(family),
    name = family === "pump-fun" ? "BondingCurve" : "Pool";
  const fields = values(launch.idl, name);
  if (family === "pump-fun")
    Object.assign(fields, {
      virtual_token_reserves: new anchor.BN(1000000000),
      virtual_quote_reserves: new anchor.BN(30000000000),
      real_token_reserves: new anchor.BN(500000000),
      real_quote_reserves: new anchor.BN(1000000000),
      token_total_supply: new anchor.BN(1000000000),
      creator: launch.creator,
    });
  else
    Object.assign(fields, {
      index: 0,
      creator: launch.named.creator,
      base_mint: launch.mint,
      quote_mint: new PublicKey(WSOL),
      pool_base_token_account: launch.named.pool_base_token_account,
      pool_quote_token_account: launch.named.pool_quote_token_account,
      lp_mint: launch.named.lp_mint,
      lp_supply: new anchor.BN(1000),
      virtual_quote_reserves: new anchor.BN(-200000000),
      protocol_fees: new anchor.BN(100000000),
      creator_fees: new anchor.BN(100000000),
    });
  Object.assign(fields, overrides);
  let encoded = await new BorshAccountsCoder(launch.idl).encode(name, fields);
  if (legacy) {
    const prefix = structuredClone(launch.idl),
      type = prefix.types!.find((type) => type.name === name)!;
    if (type.type.kind !== "struct" || !type.type.fields)
      throw new Error("FIXTURE_TYPE_UNSUPPORTED");
    const through = family === "pump-fun" ? "complete" : "lp_supply";
    const end = type.type.fields.findIndex(
      (field) =>
        typeof field === "object" && "name" in field && field.name === through,
    );
    type.type.fields = type.type.fields.slice(0, end + 1);
    encoded = encoded.subarray(0, new BorshAccountsCoder(prefix).size(name));
  }
  let requests = 0;
  const rpc = rpcFixture((_method, params) => {
    requests++;
    const addresses = params[0] as string[];
    return {
      context: { slot: 100 },
      value:
        addresses[0] === launch.event.poolAddress
          ? [
              account(encoded, launch.idl.address),
              account(
                mintBytes(),
                launch.named.token_program?.toBase58() ??
                  TOKEN_2022_PROGRAM_ID.toBase58(),
              ),
            ]
          : [
              account(
                vaultBytes(
                  launch.mint,
                  new PublicKey(launch.event.poolAddress),
                  1000000000n,
                ),
                TOKEN_2022_PROGRAM_ID.toBase58(),
              ),
              account(
                vaultBytes(
                  new PublicKey(WSOL),
                  new PublicKey(launch.event.poolAddress),
                  2000000000n,
                ),
                TOKEN_PROGRAM_ID.toBase58(),
              ),
            ],
    };
  });
  const book = new RollingMarketBook(20, 100);
  const reader = new PumpMarketReader(
    rpc,
    [
      {
        address: WSOL,
        symbol: "WSOL",
        decimals: 9,
        usdPrice: "100",
        priceSource: "FIXTURE_ONLY",
        priceVerifiedAt: Date.now(),
      },
    ],
    book,
  );
  const deployment = dexDeploymentSchema.parse({
    id: family,
    chainId: "solana",
    family,
    programId: launch.idl.address,
    verifiedSource: "https://github.com/pump-fun/pump-public-docs",
  });
  return { ...launch, reader, deployment, requests: () => requests };
}
describe("Pump discovery, fixture chỉ trong bộ nhớ", () => {
  it.each(["create", "create_v2"])(
    "Pump.fun %s giải mã IDL và nhận dạng curve, creator, quote",
    (name) => {
      const launch = creation("pump-fun", name);
      expect(launch.event).toMatchObject({
        dexId: "pump-fun",
        tokenAddress: launch.mint.toBase58(),
        quoteTokenAddress: WSOL,
        pairClassification: "TRUSTED_QUOTE",
        rawEvent: {
          creator: launch.creator.toBase58(),
          creatorRole: "TOKEN_CREATOR",
          slot: 100,
        },
      });
      expect(launch.event.poolAddress).toBe(
        curvePda(launch.event.tokenAddress, launch.idl.address),
      );
    },
  );
  it("PumpSwap có identity pool riêng, cùng mint và vault đúng", () => {
    const launch = creation("pump-swap");
    expect(launch.event.rawEvent).toMatchObject({
      lifecycle: "PUMPSWAP_POOL_CREATED",
      creatorRole: "POOL_CREATOR",
    });
    expect(launch.event.tokenAddress).toBe(launch.mint.toBase58());
  });
  it.each(["pump-fun", "pump-swap"] as const)(
    "%s từ chối account PDA bị sửa",
    (family) => {
      const launch = creation(family);
      const index = launch.definition.accounts.findIndex(
        (account) =>
          account.name === (family === "pump-fun" ? "bonding_curve" : "pool"),
      );
      launch.tx.transaction.message.accountKeys[index] = address().toBase58();
      expect(() => launch.decoder.decode(launch.tx, "bad")).toThrow(
        /IDENTITY_MISMATCH/,
      );
    },
  );
  it("không nhận event được gán cho program khác, không nhận transaction thất bại", () => {
    const launch = creation("pump-fun");
    launch.tx.meta!.err = { InstructionError: [0, "failure"] };
    expect(launch.decoder.decode(launch.tx, "failed")).toEqual([]);
    launch.tx.meta!.err = null;
    launch.tx.transaction.message.accountKeys[launch.ix.programIdIndex] =
      address().toBase58();
    expect(launch.decoder.decode(launch.tx, "other-program")).toEqual([]);
  });
  it("data tạo token thiếu bắt buộc không tạo candidate", () => {
    const launch = creation("pump-fun");
    launch.ix.data = utils.bytes.bs58.encode(
      Buffer.from(launch.definition.discriminator),
    );
    expect(() => launch.decoder.decode(launch.tx, "malformed")).toThrow();
  });
  it("quote chưa tin cậy vẫn được phát hiện nhưng guard dừng trước RPC", async () => {
    const launch = creation("pump-swap");
    const quoteIndex = launch.definition.accounts.findIndex(
      (account) => account.name === "quote_mint",
    );
    const quote = address();
    const creator = launch.named.creator!;
    const pool = new PublicKey(
      pumpPoolPda(
        0,
        creator.toBase58(),
        launch.mint.toBase58(),
        quote.toBase58(),
        launch.idl.address,
      ),
    );
    launch.tx.transaction.message.accountKeys[quoteIndex] = quote.toBase58();
    for (const [field, key] of [
      ["pool", pool],
      [
        "pool_base_token_account",
        getAssociatedTokenAddressSync(
          launch.mint,
          pool,
          true,
          TOKEN_2022_PROGRAM_ID,
        ),
      ],
      [
        "pool_quote_token_account",
        getAssociatedTokenAddressSync(quote, pool, true, TOKEN_PROGRAM_ID),
      ],
    ] as const)
      launch.tx.transaction.message.accountKeys[
        launch.definition.accounts.findIndex(
          (account) => account.name === field,
        )
      ] = key.toBase58();
    const event = launch.decoder.decode(launch.tx, "untrusted")[0]!;
    expect(event.pairClassification).toBe("UNKNOWN_PAIR");
    let requests = 0;
    const reader = new PumpMarketReader(
      rpcFixture(() => {
        requests++;
        return null;
      }),
      [],
      new RollingMarketBook(10, 10),
    );
    const guard = await reader.guard(
      event,
      dexDeploymentSchema.parse({
        id: "pump-swap",
        chainId: "solana",
        family: "pump-swap",
        programId: launch.idl.address,
        verifiedSource: "https://github.com/pump-fun/pump-public-docs",
      }),
    );
    expect(guard.reasons).toEqual(["UNTRUSTED_QUOTE"]);
    expect(requests).toBe(0);
  });
  it("outer/inner CPI cùng pool không tạo hai discovery trong cùng tx", () => {
    const launch = creation("pump-swap");
    launch.tx.meta!.innerInstructions = [
      { index: 0, instructions: [launch.ix] },
    ];
    expect(launch.decoder.decode(launch.tx, "duplicate")).toHaveLength(1);
  });
  it("transaction dùng chung không đọc RPC trùng khi nhiều watcher yêu cầu", async () => {
    let count = 0;
    const launch = creation("pump-fun");
    const rpc = rpcFixture(() => {
      count++;
      return launch.tx;
    });
    const reader = new SolanaTransactionReader(rpc);
    await Promise.all([reader.read("same"), reader.read("same")]);
    expect(count).toBe(1);
    expect(rpc.stats().requests).toBe(1);
  });
  it("WS init hint trùng được dedupe; burst được giới hạn, poll dự phòng vẫn chạy", async () => {
    const launch = creation("pump-fun");
    let txCalls = 0;
    const rpc = rpcFixture((method) =>
      method === "getSignaturesForAddress" ? [] : (txCalls++, launch.tx),
    );
    const scanner = new SolanaProgramDiscovery(
      "solana",
      rpc,
      dexDeploymentSchema.parse({
        id: "pump-fun",
        chainId: "solana",
        family: "pump-fun",
        programId: launch.idl.address,
        verifiedSource: "https://github.com/pump-fun/pump-public-docs",
      }),
      [{ address: WSOL, symbol: "WSOL", decimals: 9 }],
      { readCursor: async () => undefined, writeCursor: async () => {} },
      undefined,
      undefined,
      undefined,
      { observationOnly: true },
    );
    const hint = (signature: string) => ({
      value: {
        signature,
        err: null,
        logs: ["Program log: Instruction: CreateV2"],
      },
    });
    scanner.hint(hint("same"));
    scanner.hint(hint("same"));
    for (let i = 0; i < 300; i++) scanner.hint(hint("burst-" + i));
    expect(scanner.stats()).toMatchObject({
      pendingSignatures: 128,
      duplicates: 1,
    });
    expect(scanner.stats().droppedHints).toBeGreaterThan(0);
    let events = 0;
    await scanner.poll(async () => {
      events++;
    });
    expect(txCalls).toBe(10);
    expect(events).toBe(10);
    expect(scanner.stats().pendingSignatures).toBe(118);
    scanner.stop();
  });
  it("Pump.fun và PumpSwap cùng mint dùng một identity, giữ lịch sử nguồn riêng", () => {
    const monitor = new DiscoveryMonitor(2),
      mint = address();
    const pump = creation("pump-fun", "create_v2", mint).event,
      swap = creation("pump-swap", "create_pool", mint).event;
    monitor.observe(pump);
    monitor.observe(swap);
    monitor.observe({ ...swap, dexId: "raydium-cpmm" });
    expect(monitor.lifecycle(pump)?.sources).toEqual([
      "pump-fun",
      "pump-swap",
      "raydium-cpmm",
    ]);
    expect(monitor.summary().sources["pump-fun"]!.detected).toBe(1);
  });
  it("same mint nguồn mới không được coi là chưa có BUY khi entry đã ghi nhận", () => {
    const event = creation("pump-swap").event;
    expect(
      hasRecordedTokenEntry(
        event,
        [{ intentId: "previous-pump", state: "CONFIRMED" }],
        () => ({
          chainId: "solana",
          tokenOut: event.tokenAddress,
          side: "BUY",
        }),
      ),
    ).toBe(true);
    expect(
      hasRecordedTokenEntry(
        event,
        [{ intentId: "previous-pump", state: "FAILED" }],
        () => ({
          chainId: "solana",
          tokenOut: event.tokenAddress,
          side: "BUY",
        }),
      ),
    ).toBe(false);
  });
});
describe("Pump fallback và khôi phục", () => {
  it("backpressure không bị retry dồn theo từng WS wakeup", async () => {
    const launch = creation("pump-fun"),
      rpc = rpcFixture((method) =>
        method === "getSignaturesForAddress" ? [] : launch.tx,
      );
    const scanner = new SolanaProgramDiscovery(
      "solana",
      rpc,
      dexDeploymentSchema.parse({
        id: "pump-fun",
        chainId: "solana",
        family: "pump-fun",
        programId: launch.idl.address,
        verifiedSource: "https://github.com/pump-fun/pump-public-docs",
      }),
      [{ address: WSOL, symbol: "WSOL", decimals: 9 }],
      { readCursor: async () => undefined, writeCursor: async () => {} },
      undefined,
      undefined,
      undefined,
      { observationOnly: true },
    );
    scanner.hint({
      value: {
        signature: "pressure",
        err: null,
        logs: ["Program log: Instruction: CreateV2"],
      },
    });
    let attempts = 0;
    const accept = async () => {
      attempts++;
      if (attempts === 1) throw new Error("DISCOVERY_SOURCE_BACKPRESSURE");
    };
    await scanner.poll(accept);
    for (let i = 0; i < 100; i++) await scanner.poll(accept);
    expect(attempts).toBe(1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 1100);
    await scanner.poll(accept);
    expect(attempts).toBe(2);
    expect(scanner.stats().pendingSignatures).toBe(0);
    scanner.stop();
  });
  it.each(["pump-fun", "pump-swap"] as const)(
    "%s tái sử dụng trade log của transaction đã đọc, không thêm RPC",
    (family) => {
      const launch = creation(family),
        name = family === "pump-fun" ? "TradeEvent" : "BuyEvent";
      const data = values(launch.idl, name);
      if (family === "pump-fun")
        Object.assign(data, {
          mint: launch.mint,
          quote_mint: new PublicKey(WSOL),
          is_buy: true,
          token_amount: new anchor.BN(1000),
          quote_amount: new anchor.BN(20000),
        });
      else
        Object.assign(data, {
          pool: new PublicKey(launch.event.poolAddress),
          quote_amount_in: new anchor.BN(20000),
          base_amount_out: new anchor.BN(1000),
        });
      const discriminator = launch.idl.events!.find(
        (event) => event.name === name,
      )!.discriminator;
      const bytes = Buffer.concat([
        Buffer.from(discriminator),
        new BorshCoder(launch.idl).types.encode(name, data),
      ]);
      launch.tx.meta!.logMessages = [
        `Program ${launch.idl.address} invoke [1]`,
        `Program data: ${bytes.toString("base64")}`,
        `Program ${launch.idl.address} success`,
      ];
      const trades = launch.decoder.sampledTrades(launch.tx, "trade");
      expect(trades).toHaveLength(1);
      expect(trades[0]).toMatchObject({
        poolAddress: launch.event.poolAddress,
        amountIn: "20000",
        amountOut: "1000",
      });
    },
  );
  it.each([false, true])(
    "HTTP nhận launch không cần WS; cursor/dedupe, observation=%s",
    async (observationOnly) => {
      const launch = creation("pump-fun");
      let cursor: string | undefined;
      let writes = 0;
      const rpc = rpcFixture((method) =>
        method === "getSignaturesForAddress"
          ? [
              {
                signature: "fallback",
                slot: 100,
                err: null,
                blockTime: launch.tx.blockTime,
              },
            ]
          : method === "getSlot"
            ? 100
            : method === "getBlockTime"
              ? launch.tx.blockTime
              : launch.tx,
      );
      const scanner = new SolanaProgramDiscovery(
        "solana",
        rpc,
        dexDeploymentSchema.parse({
          id: "pump-fun",
          chainId: "solana",
          family: "pump-fun",
          programId: launch.idl.address,
          verifiedSource: "https://github.com/pump-fun/pump-public-docs",
        }),
        [{ address: WSOL, symbol: "WSOL", decimals: 9 }],
        {
          readCursor: async () => cursor,
          writeCursor: async (_key, value) => {
            cursor = value;
            writes++;
          },
        },
        undefined,
        undefined,
        undefined,
        { observationOnly },
      );
      const events: TokenDiscoveryEvent[] = [];
      await scanner.poll(async (event) => {
        events.push(event);
      });
      await scanner.poll(async (event) => {
        events.push(event);
      });
      expect(events).toHaveLength(1);
      expect(writes).toBe(observationOnly ? 0 : 1);
      scanner.stop();
      if (!observationOnly) {
        const restored = new SolanaProgramDiscovery(
          "solana",
          rpc,
          dexDeploymentSchema.parse({
            id: "pump-fun",
            chainId: "solana",
            family: "pump-fun",
            programId: launch.idl.address,
            verifiedSource: "https://github.com/pump-fun/pump-public-docs",
          }),
          [{ address: WSOL, symbol: "WSOL", decimals: 9 }],
          { readCursor: async () => cursor, writeCursor: async () => {} },
        );
        await restored.poll(async (event) => {
          events.push(event);
        });
        expect(events).toHaveLength(1);
        restored.stop();
      }
    },
  );
  it("LIVE history gap không nuốt launch WS; giữ cursor/coverage thiếu và không tuyên bố READY", async () => {
    const launch = creation("pump-fun");
    let writes = 0;
    const covered: boolean[] = [];
    const rpc = rpcFixture((method) =>
      method === "getSignaturesForAddress"
        ? Array.from({ length: 100 }, (_, i) => ({
            signature: `recent-${i}`,
            slot: 100,
            err: null,
            blockTime: launch.tx.blockTime,
          }))
        : method === "getSlot"
          ? 100
          : launch.tx,
    );
    const scanner = new SolanaProgramDiscovery(
      "solana",
      rpc,
      dexDeploymentSchema.parse({
        id: "pump-fun",
        chainId: "solana",
        family: "pump-fun",
        programId: launch.idl.address,
        verifiedSource: "https://github.com/pump-fun/pump-public-docs",
      }),
      [{ address: WSOL, symbol: "WSOL", decimals: 9 }],
      {
        readCursor: async () => "older-cursor",
        writeCursor: async () => {
          writes++;
        },
      },
      undefined,
      undefined,
      (_at, complete) => covered.push(complete),
      { observationOnly: false },
    );
    scanner.hint({
      value: {
        signature: "fresh-launch",
        err: null,
        logs: ["Program log: Instruction: Create"],
      },
    });
    const events: TokenDiscoveryEvent[] = [];
    try {
      await expect(
        scanner.poll(async (e) => {
          events.push(e);
        }),
      ).rejects.toThrow("SOLANA_DISCOVERY_GAP_REQUIRES_BACKFILL");
      expect(events).toHaveLength(1);
      expect(writes).toBe(0);
      expect(covered).toEqual([false]);
    } finally {
      scanner.stop();
      rpc.close();
    }
  });
  it("malformed init không chặn launch kế tiếp, không để poisoned signature chạy vô hạn", async () => {
    const good = creation("pump-fun"),
      bad = structuredClone(good.tx);
    bad.transaction.message.instructions[0]!.data = utils.bytes.bs58.encode(
      Buffer.from(good.definition.discriminator),
    );
    const rpc = rpcFixture((method, params) =>
      method === "getSignaturesForAddress"
        ? []
        : params[0] === "bad"
          ? bad
          : good.tx,
    );
    const scanner = new SolanaProgramDiscovery(
      "solana",
      rpc,
      dexDeploymentSchema.parse({
        id: "pump-fun",
        chainId: "solana",
        family: "pump-fun",
        programId: good.idl.address,
        verifiedSource: "https://github.com/pump-fun/pump-public-docs",
      }),
      [{ address: WSOL, symbol: "WSOL", decimals: 9 }],
      { readCursor: async () => undefined, writeCursor: async () => {} },
      undefined,
      undefined,
      undefined,
      { observationOnly: true },
    );
    for (const signature of ["bad", "good"])
      scanner.hint({
        value: {
          signature,
          err: null,
          logs: ["Program log: Instruction: CreateV2"],
        },
      });
    let found = 0;
    await scanner.poll(async () => {
      found++;
    });
    expect(found).toBe(1);
    expect(scanner.stats()).toMatchObject({
      pendingSignatures: 0,
      validationFailures: 1,
    });
    scanner.stop();
  });
  it("engine giới hạn hàng chờ Pump theo nguồn trước khi kích hoạt phân tích sâu", async () => {
    const env = loadEnv({
        DATA_MODE: "real",
        AI_PROVIDER: "jev",
        OBSERVATION_ONLY: "true",
      }),
      repository = new MemoryRepository();
    const engine = new RealTradingEngine({
      repository,
      chains: chainsFromEnv(env),
      env,
      config: realConfigSchema.parse({ version: 1, maxPools: 6 }),
      wallets: new TradingWallet(chainsFromEnv(env), {}),
      configurationLoaded: true,
    });
    try {
      await engine.initialize();
      const boundary = engine as unknown as {
        acceptDiscovery(event: TokenDiscoveryEvent): Promise<void>;
      };
      const launch = creation("pump-fun").event;
      const results = await Promise.allSettled(
        Array.from({ length: 100 }, (_, index) =>
          boundary.acceptDiscovery({
            ...launch,
            id: `fixture:${index}`,
            poolAddress: address().toBase58(),
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const snapshot = await engine.snapshot();
      expect(snapshot.discovery?.queueDepth).toBe(1);
      expect(snapshot.discovery?.backpressure).toBe(99);
      expect(snapshot.metrics.aiCalls).toBe(0);
      expect(snapshot.executions).toHaveLength(0);
    } finally {
      await engine.shutdown();
    }
  });
});
describe("Pump market và guard trước phân tích đắt", () => {
  it("account curve phiên bản cũ dùng default trailing fields theo tài liệu", async () => {
    const fixture = await marketFixture("pump-fun", {}, true);
    expect(
      (await fixture.reader.guard(fixture.event, fixture.deployment)).passed,
    ).toBe(true);
    expect(
      (await fixture.reader.protocol(fixture.event, fixture.deployment))
        .complete,
    ).toBe(false);
  });
  it("curve đọc reserves thật; không bịa volume/holder khi stream chưa đầy đủ", async () => {
    const fixture = await marketFixture("pump-fun");
    expect(
      (await fixture.reader.guard(fixture.event, fixture.deployment)).passed,
    ).toBe(true);
    const market = await fixture.reader.market(
      fixture.event,
      fixture.deployment,
    );
    expect(market.priceUsd).toBeCloseTo(3);
    expect(market.volume5s).toBeUndefined();
    expect(market.uniqueBuyers).toBeUndefined();
    expect(fixture.requests()).toBe(1);
  });
  it("curve complete không cho đi phân tích sâu", async () => {
    const fixture = await marketFixture("pump-fun", { complete: true });
    expect(
      (await fixture.reader.guard(fixture.event, fixture.deployment)).reasons,
    ).toEqual(["NO_TRADING_ROUTE"]);
  });
  it("PumpSwap xử lý virtual quote i128 âm và trừ phí khỏi inventory thật", async () => {
    const fixture = await marketFixture("pump-swap");
    const guard = await fixture.reader.guard(fixture.event, fixture.deployment);
    expect(guard.passed).toBe(true);
    const market = await fixture.reader.market(
      fixture.event,
      fixture.deployment,
    );
    expect(market.priceUsd).toBeCloseTo(0.18);
    expect(market.liquidityUsd).toBeCloseTo(360);
    const state = await fixture.reader.protocol(
      fixture.event,
      fixture.deployment,
    );
    expect(state.virtualQuoteReserves).toBe("-200000000");
    expect(state.realQuoteReserves).toBe("1800000000");
    expect(fixture.requests()).toBe(2);
  });
  it("effective reserve âm là dữ liệu lỗi, không đổi thành 0 hoặc SAFE", async () => {
    const fixture = await marketFixture("pump-swap", {
      virtual_quote_reserves: new anchor.BN(-3000000000),
    });
    const guard = await fixture.reader.guard(fixture.event, fixture.deployment);
    expect(guard.passed).toBe(false);
    expect(guard.reasons).toEqual(["PUMP_RESERVES_INVALID"]);
  });
  it("guard thất bại không gọi holder/features, Rug hoặc Jev ở cả hai pipeline", async () => {
    const event = creation("pump-fun").event;
    const features = new FeatureEngine([]),
      collect = vi.spyOn(features, "collect");
    const rug = { collect: vi.fn() } as unknown as RugCheckEngine;
    const classify = vi.fn();
    const ai = { id: "fixture", classify } as AIProvider;
    const guard = async () => ({
      passed: false,
      reasons: ["UNTRUSTED_QUOTE"],
      latencyMs: 1,
    });
    const record = await analyzeObservation(event, {
      features,
      ai,
      rug,
      settings: defaultSettings(),
      policy: rugPolicySchema.parse({}),
      aiTimeoutMs: 100,
      claimAiSlot: () => true,
      stage: () => {},
      discoveryGuard: guard,
    });
    expect(record.observation?.stage).toBe("CHEAP_REJECTED");
    await analyzeCandidate(
      event,
      features,
      ai,
      defaultSettings(),
      Date.now(),
      100,
      100,
      undefined,
      guard,
    );
    expect(collect).not.toHaveBeenCalled();
    expect(rug.collect).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });
});
