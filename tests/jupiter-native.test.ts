import { it, expect } from "vitest";
import { Keypair, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { JsonRpcClient } from "@sniper/chains";
import { JupiterSwapProvider } from "@sniper/dex";
const mint = "So11111111111111111111111111111111111111112",
  usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
it.each(["BUY", "SELL"])(
  "Jupiter %s native dùng cùng build engine và wrap/unwrap, không submit",
  async (side) => {
    const wallet = Keypair.generate().publicKey;
    const calls: URL[] = [];
    const rpc = new JsonRpcClient("jup-fixture", "http://fixture.invalid", {
      readOnly: true,
      fetcher: async () => {
        throw Error("UNEXPECTED_RPC");
      },
    });
    const p = new JupiterSwapProvider(rpc, {
      apiKey: "fixture",
      allowedPrograms: [
        SystemProgram.programId.toBase58(),
        "ComputeBudget111111111111111111111111111111",
      ],
      fetcher: async (input) => {
        const u = new URL(String(input));
        calls.push(u);
        expect(u.pathname).toBe("/swap/v2/build");
        expect(u.searchParams.get("wrapAndUnwrapSol")).toBe("true");
        const amount = BigInt(u.searchParams.get("amount")!);
        const ix = SystemProgram.transfer({
          fromPubkey: wallet,
          toPubkey: wallet,
          lamports: 0,
        });
        return Response.json({
          inputMint: u.searchParams.get("inputMint"),
          outputMint: u.searchParams.get("outputMint"),
          inAmount: String(amount),
          outAmount: String(amount * 2n),
          otherAmountThreshold: String((amount * 2n * 99n) / 100n),
          swapMode: "ExactIn",
          slippageBps: 100,
          computeBudgetInstructions: [],
          setupInstructions: [],
          otherInstructions: [],
          cleanupInstruction: null,
          tipInstruction: null,
          addressesByLookupTableAddress: null,
          swapInstruction: {
            programId: ix.programId.toBase58(),
            accounts: ix.keys.map((k) => ({
              pubkey: k.pubkey.toBase58(),
              isSigner: k.isSigner,
              isWritable: k.isWritable,
            })),
            data: ix.data.toString("base64"),
          },
          blockhashWithMetadata: {
            blockhash: Array.from(Keypair.generate().publicKey.toBytes()),
            lastValidBlockHeight: 10000,
          },
        });
      },
    });
    try {
      const q = await p.getQuote({
        chainId: "solana",
        tokenIn: side === "BUY" ? mint : usdc,
        tokenOut: side === "BUY" ? usdc : mint,
        amountIn: "1000000",
        decimalsIn: 9,
        decimalsOut: 6,
        slippageBps: 100,
        walletAddress: wallet.toBase58(),
        nativeInput: side === "BUY",
        nativeOutput: side === "SELL",
      });
      const n = calls.length,
        tx = await p.buildSwap(q, wallet.toBase58());
      expect(calls.length).toBe(n);
      expect(tx.family).toBe("solana");
      if (tx.family !== "solana") throw Error();
      const unsigned = VersionedTransaction.deserialize(
        Buffer.from(tx.transactionBase64, "base64"),
      );
      expect(unsigned.signatures.every((s) => s.every((b) => b === 0))).toBe(
        true,
      );
      await expect(
        p.getQuote({
          chainId: "solana",
          tokenIn: usdc,
          tokenOut: mint,
          amountIn: "1",
          decimalsIn: 6,
          decimalsOut: 9,
          slippageBps: 100,
          nativeInput: true,
        }),
      ).rejects.toThrow("NATIVE_ROUTE_MISMATCH");
    } finally {
      p.close();
      rpc.close();
    }
  },
);
