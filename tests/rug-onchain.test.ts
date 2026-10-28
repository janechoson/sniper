import { it, expect } from "vitest";
import { MintLayout, AccountLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  JsonRpcClient,
  SolanaTokenAnalyzer,
  RpcHolderDataProvider,
  OnChainHolderSecurityProvider,
} from "@sniper/chains";
it("freeze authority active không tự chứng minh transfer đang bị chặn", async () => {
  const mint = Keypair.fromSeed(new Uint8Array(32).fill(31)).publicKey,
    freeze = Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey,
    buffer = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: SystemProgram.programId,
      supply: 100n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 1,
      freezeAuthority: freeze,
    },
    buffer,
  );
  const rpc = new JsonRpcClient("fixture", "http://127.0.0.1/unused", {
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          context: { slot: 100 },
          value: {
            owner: TOKEN_PROGRAM_ID.toBase58(),
            lamports: 1,
            executable: false,
            data: [buffer.toString("base64"), "base64"],
          },
        },
      });
    },
  });
  try {
    const result = await new SolanaTokenAnalyzer(rpc).analyze(mint.toBase58());
    expect(result.security.freezeRisk).toBe(true);
    expect(
      result.security.onChainFindings?.find(
        (f) => f.field === "freezeAuthority",
      )?.evidence.value,
    ).toBe("ACTIVE");
    expect(
      result.security.onChainFindings?.find(
        (f) => f.field === "transferRestriction",
      )?.evidence.value,
    ).toBe(false);
  } finally {
    rpc.close();
  }
});
it("holder raw/adjusted dùng owner aggregate và mint cùng slot, giữ exclusions audit", async () => {
  const key = (n: number) =>
    Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
  const mint = key(40),
    ownerA = key(41),
    ownerPool = key(42),
    accountA = key(43),
    accountPool = key(44);
  const mintBuffer = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: SystemProgram.programId,
      supply: 100n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: SystemProgram.programId,
    },
    mintBuffer,
  );
  const account = (owner: typeof ownerA, amount: bigint) => {
    const b = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint,
        owner,
        amount,
        delegateOption: 0,
        delegate: SystemProgram.programId,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: SystemProgram.programId,
      },
      b,
    );
    return {
      owner: TOKEN_PROGRAM_ID.toBase58(),
      lamports: 1,
      executable: false,
      data: [b.toString("base64"), "base64"],
    };
  };
  const mintInfo = {
    owner: TOKEN_PROGRAM_ID.toBase58(),
    lamports: 1,
    executable: false,
    data: [mintBuffer.toString("base64"), "base64"],
  };
  let slot = 100;
  const rpc = new JsonRpcClient("fixture", "http://127.0.0.1/unused", {
    rps: 1000,
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const result =
        body.method === "getAccountInfo"
          ? { context: { slot: 100 }, value: mintInfo }
          : body.method === "getTokenLargestAccounts"
            ? {
                context: { slot: 100 },
                value: [
                  {
                    address: accountPool.toBase58(),
                    amount: "80",
                    decimals: 6,
                  },
                  { address: accountA.toBase58(), amount: "20", decimals: 6 },
                ],
              }
            : {
                context: { slot },
                value: [
                  mintInfo,
                  account(ownerPool, 80n),
                  account(ownerA, 20n),
                ],
              };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  try {
    const analyzer = new SolanaTokenAnalyzer(rpc),
      holders = new RpcHolderDataProvider(
        new Map([["solana", { type: "solana", rpc, solana: analyzer }]]),
      );
    const provider = new OnChainHolderSecurityProvider(holders, [
      {
        chainId: "solana",
        address: ownerPool.toBase58(),
        kind: "POOL",
        verifiedSource: "https://example.test/fixture-verified-pool",
      },
    ]);
    const result = await provider.analyze({
      chainId: "solana",
      tokenAddress: mint.toBase58(),
    });
    expect(
      result.findings.find((f) => f.field === "top1Pct")?.evidence.value,
    ).toBe(80);
    expect(
      result.findings.find((f) => f.field === "adjustedTop1Pct")?.evidence
        .value,
    ).toBe(100);
    expect(
      result.findings.find((f) => f.field === "excludedSupplyPct")?.evidence
        .value,
    ).toBe(80);
    slot = 101;
    expect(
      (
        await provider.analyze({
          chainId: "solana",
          tokenAddress: mint.toBase58(),
        })
      ).findings,
    ).toEqual([]);
  } finally {
    rpc.close();
  }
});
