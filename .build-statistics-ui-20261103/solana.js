import { Connection, PublicKey, } from "@solana/web3.js";
import { env } from "./config.js";
import { Blocked, ProviderFailure } from "./domain.js";
import { Http } from "./util.js";
import { inspectMint } from "./token-program.js";
export class Solana {
    http = new Http("RPC", 400);
    connection;
    constructor() {
        this.connection = new Connection(env.SOLANA_RPC_HTTP ?? env.SOLANA_RPC_URL, {
            commitment: "confirmed",
            wsEndpoint: env.SOLANA_RPC_WS,
            disableRetryOnRateLimit: true,
            fetch: async (url, init) => {
                const data = await this.http.request(String(url), init);
                if (data && typeof data === "object" && "error" in data) {
                    this.http.health = {
                        state: "BLOCKED",
                        at: Date.now(),
                        reason: "RPC_RESPONSE_ERROR",
                    };
                    throw new ProviderFailure("RPC_RESPONSE_ERROR", "RPC");
                }
                return new Response(JSON.stringify(data), {
                    headers: { "Content-Type": "application/json" },
                });
            },
        });
    }
    async balance(wallet) {
        return BigInt(await this.connection.getBalance(new PublicKey(wallet), "confirmed"));
    }
    async inspectMint(mint) {
        return inspectMint(mint, await this.connection.getAccountInfo(new PublicKey(mint), "confirmed"));
    }
    async tokenBalance(wallet, mint) {
        const response = await this.connection.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(mint) }, "confirmed");
        return response.value.reduce((n, r) => n + BigInt(r.account.data.parsed.info.tokenAmount.amount), 0n);
    }
    async receipt(signature) {
        return this.connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });
    }
    async investigate(signature, validity) {
        const results = await Promise.allSettled([
            this.connection.getSignatureStatuses([signature], {
                searchTransactionHistory: true,
            }),
            this.connection.getBlockHeight("finalized"),
            validity?.blockhash
                ? this.connection.isBlockhashValid(validity.blockhash, {
                    commitment: "finalized",
                })
                : Promise.resolve(undefined),
        ]);
        const status = results[0]?.status === "fulfilled" ? results[0].value.value[0] : null;
        return {
            signatureStatus: status
                ? status.err
                    ? "FAILED"
                    : (status.confirmationStatus ?? "PROCESSED")
                : "NOT_ESTABLISHED",
            currentBlockHeight: results[1]?.status === "fulfilled" ? results[1].value : undefined,
            blockhashValid: results[2]?.status === "fulfilled"
                ? results[2].value?.value
                : undefined,
        };
    }
    deltas(receipt, wallet, mint) {
        const meta = receipt.meta;
        if (!meta || meta.err)
            throw new Blocked("Transaction failed or receipt metadata is unavailable");
        const keys = receipt.transaction.message.getAccountKeys({
            accountKeysFromLookups: meta.loadedAddresses,
        });
        let index = -1;
        for (let i = 0; i < keys.length; i++)
            if (keys.get(i)?.toBase58() === wallet)
                index = i;
        if (index < 0)
            throw new Blocked("Configured wallet is absent from the Solana receipt");
        if (index !== 0 ||
            receipt.transaction.message.header.numRequiredSignatures < 1 ||
            !meta.preTokenBalances ||
            !meta.postTokenBalances ||
            !Number.isSafeInteger(meta.preBalances[index]) ||
            !Number.isSafeInteger(meta.postBalances[index]) ||
            meta.preBalances[index] < 0 ||
            meta.postBalances[index] < 0)
            throw new Blocked("RECEIPT_WALLET_OR_BALANCE_EVIDENCE_INVALID");
        const tokens = (rows) => rows
            ?.filter((r) => r.owner === wallet && r.mint === mint)
            .reduce((n, r) => {
            if (!/^\d+$/.test(r.uiTokenAmount.amount) ||
                !Number.isSafeInteger(r.accountIndex) ||
                r.accountIndex < 0 ||
                r.accountIndex >= keys.length)
                throw new Blocked("RECEIPT_TOKEN_BALANCE_EVIDENCE_INVALID");
            return n + BigInt(r.uiTokenAmount.amount);
        }, 0n) ?? 0n;
        const beforeSol = BigInt(meta.preBalances[index]), afterSol = BigInt(meta.postBalances[index]);
        const beforeTokens = tokens(meta.preTokenBalances), afterTokens = tokens(meta.postTokenBalances);
        return {
            sol: afterSol - beforeSol,
            tokens: afterTokens - beforeTokens,
            beforeSol,
            afterSol,
            beforeTokens,
            afterTokens,
        };
    }
}
