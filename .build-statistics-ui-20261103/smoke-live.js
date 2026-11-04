import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { env } from "./config.js";
import { Blocked } from "./domain.js";
import { acquireLock } from "./server.js";
import { JupiterExecutionProvider, localWallet, validateQuote, } from "./execution-provider.js";
import { Solana } from "./solana.js";
import { json, safeError, sleep } from "./util.js";
import { SMOKE_MAX_LAMPORTS, SMOKE_MAINNET_GENESIS, SMOKE_USDC, SMOKE_SLIPPAGE_BPS, SMOKE_FEE_RESERVE, smokeAmount, acquiredOnly, } from "./smoke-policy.js";
export function newSmokeRecord() {
    return {
        provider: "JUPITER",
        id: "live-smoke-" + Date.now(),
        startedAt: new Date().toISOString(),
        status: "FAIL",
        symbol: "USDC",
        mint: SMOKE_USDC,
        buy: { submitted: false, state: "CREATED" },
        sell: { submitted: false, state: "CREATED" },
    };
}
function durableWrite(file, text, exclusive = false) {
    const fd = openSync(file, exclusive ? "wx" : "w", 0o600);
    try {
        writeFileSync(fd, text);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
export function smokeJournal(file) {
    const target = resolve(file), marker = target + ".once";
    mkdirSync(dirname(target), { recursive: true });
    return {
        consumed: () => existsSync(marker),
        previous: () => existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : undefined,
        save(value) {
            durableWrite(target + ".tmp", json(value) + "\n");
            renameSync(target + ".tmp", target);
        },
        consumeOnce() {
            durableWrite(marker, json({ startedAt: new Date().toISOString(), pid: process.pid }) + "\n", true);
        },
    };
}
export async function executeSmoke(options, d, run = newSmokeRecord()) {
    const balance = async () => ({
        sol: (await d.rpc.balance(options.wallet)).toString(),
        tokens: (await d.rpc.tokenBalance(options.wallet, SMOKE_USDC)).toString(),
    });
    const check = (q, side, amount, routeOnly = false) => validateQuote(q, {
        mint: SMOKE_USDC,
        side,
        amount,
        wallet: options.wallet,
        slippageBps: SMOKE_SLIPPAGE_BPS,
        routeOnly,
    });
    async function leg(side, q) {
        const l = side === "BUY" ? run.buy : run.sell;
        if (l.submitted || (side === "SELL" && !run.buy.evidence))
            throw new Blocked("SMOKE_DUPLICATE_OR_UNCONFIRMED_BUY");
        check(q, side, BigInt(l.amount));
        await d.provider.simulate(q);
        l.before = await balance();
        const expected = side === "BUY" ? run.initial : run.buy.after;
        if (l.before.sol !== expected.sol || l.before.tokens !== expected.tokens)
            throw new Blocked("SMOKE_CONCURRENT_WALLET_CHANGE");
        // Reserving the test before signing also protects a crash before the signature is persisted.
        if (side === "BUY")
            d.consumeOnce();
        try {
            await d.provider.execute(q, (signature) => {
                l.signature = signature;
                l.submitted = true;
                l.state = "SUBMITTED";
                d.save(run);
            });
        }
        catch (error) {
            l.error = safeError(error);
            if (!l.signature)
                throw error;
        }
        if (!l.signature)
            throw new Blocked("SMOKE_MISSING_SIGNATURE");
        l.state = "PENDING_CONFIRMATION";
        d.save(run);
        const status = await d.provider.confirm(l.signature);
        if (status !== "CONFIRMED") {
            l.state = status === "FAILED" ? "FAILED" : "UNKNOWN";
            throw new Blocked("SMOKE_" + side + "_" + status + "_NO_RETRY");
        }
        let tx = await d.rpc.receipt(l.signature);
        for (let n = 0; !tx && n < 4; n++) {
            await sleep(1500);
            tx = await d.rpc.receipt(l.signature);
        }
        if (!tx?.meta ||
            tx.meta.err ||
            tx.transaction.signatures[0] !== l.signature)
            throw new Blocked("SMOKE_RECEIPT_UNAVAILABLE_OR_FAILED");
        const delta = d.rpc.deltas(tx, options.wallet, SMOKE_USDC);
        l.after = await balance();
        if (BigInt(l.after.sol) - BigInt(l.before.sol) !== delta.sol ||
            BigInt(l.after.tokens) - BigInt(l.before.tokens) !== delta.tokens)
            throw new Blocked("SMOKE_BALANCES_DO_NOT_MATCH_RECEIPT");
        if (side === "BUY"
            ? delta.tokens <= 0n ||
                delta.sol >= 0n ||
                -delta.sol > options.principal + SMOKE_FEE_RESERVE
            : delta.tokens !== -BigInt(l.amount) || delta.sol <= 0n)
            throw new Blocked("SMOKE_RECEIPT_DIRECTION_OR_AMOUNT_MISMATCH");
        l.state = "CONFIRMED";
        l.evidence = {
            signature: l.signature,
            status: "confirmed",
            slot: tx.slot,
            solDelta: delta.sol.toString(),
            tokenDelta: delta.tokens.toString(),
            networkFeeLamports: String(tx.meta.fee),
        };
        d.save(run);
    }
    try {
        if (!options.ack)
            throw new Blocked("LIVE_SMOKE_TEST_ACK_REQUIRED");
        if (!options.live)
            throw new Blocked("LIVE_TRADING_ACK_REQUIRED");
        if (options.principal <= 0n || options.principal > SMOKE_MAX_LAMPORTS)
            throw new Blocked("MINIMUM_AMOUNT_EXCEEDS_SMOKE_CAP");
        run.wallet = new PublicKey(options.wallet).toBase58();
        run.principalLamports = options.principal.toString();
        if ((await d.rpc.connection.getGenesisHash()) !== SMOKE_MAINNET_GENESIS)
            throw new Blocked("SMOKE_NOT_SOLANA_MAINNET");
        const mint = await d.rpc.connection.getParsedAccountInfo(new PublicKey(SMOKE_USDC), "confirmed");
        const data = mint.value?.data;
        if (!data ||
            !("parsed" in data) ||
            data.program !== "spl-token" ||
            data.parsed.type !== "mint" ||
            data.parsed.info.decimals !== 6 ||
            data.parsed.info.isInitialized !== true)
            throw new Blocked("SMOKE_USDC_MINT_MISMATCH");
        run.initial = await balance();
        d.save(run);
        if (BigInt(run.initial.sol) < options.principal + SMOKE_FEE_RESERVE)
            throw new Blocked("SMOKE_INSUFFICIENT_SOL_WITH_FEE_RESERVE");
        const buy = await d.provider.quoteBuy(SMOKE_USDC, options.principal, SMOKE_SLIPPAGE_BPS);
        check(buy, "BUY", options.principal);
        // An unfunded reverse order still proves route availability; simulation of SELL occurs after BUY.
        const reverse = await d.provider.quoteSell(SMOKE_USDC, BigInt(buy.order.outAmount), SMOKE_SLIPPAGE_BPS, true);
        check(reverse, "SELL", BigInt(buy.order.outAmount), true);
        d.emit("SMOKE_PREFLIGHT", {
            provider: "JUPITER",
            symbol: "USDC",
            mint: SMOKE_USDC,
            wallet: run.wallet,
            amountLamports: options.principal.toString(),
            slippageBps: buy.order.slippageBps,
            route: buy.order.routePlan,
            reverseRoute: reverse.order.routePlan,
            fees: {
                signature: buy.order.signatureFeeLamports,
                priority: buy.order.prioritizationFeeLamports,
                rent: buy.order.rentFeeLamports,
            },
        });
        run.buy.amount = options.principal.toString();
        await leg("BUY", buy);
        const acquired = acquiredOnly(BigInt(run.initial.tokens), BigInt(run.buy.after.tokens));
        if (acquired !== BigInt(run.buy.evidence.tokenDelta))
            throw new Blocked("SMOKE_ACQUIRED_AMOUNT_MISMATCH");
        run.remainingTestTokens = acquired.toString();
        run.status = "PARTIAL";
        d.save(run);
        const sell = await d.provider.quoteSell(SMOKE_USDC, acquired, SMOKE_SLIPPAGE_BPS);
        check(sell, "SELL", acquired);
        run.sell.amount = acquired.toString();
        await leg("SELL", sell);
        run.final = run.sell.after;
        run.remainingTestTokens = (BigInt(run.final.tokens) - BigInt(run.initial.tokens)).toString();
        if (run.remainingTestTokens !== "0")
            throw new Blocked("SMOKE_TOKEN_ISOLATION_FAILED");
        run.roundTripDifferenceLamports = (BigInt(run.final.sol) - BigInt(run.initial.sol)).toString();
        run.observedNetworkFeesLamports = (BigInt(run.buy.evidence.networkFeeLamports) +
            BigInt(run.sell.evidence.networkFeeLamports)).toString();
        run.status = "PASS";
    }
    catch (error) {
        run.reason = safeError(error);
        const leg = run.sell.submitted ? run.sell : run.buy;
        if (leg.submitted && leg.state !== "FAILED" && leg.state !== "CONFIRMED")
            leg.state = "UNKNOWN";
        if (run.buy.evidence) {
            run.status = "PARTIAL";
            try {
                run.final = await balance();
                run.remainingTestTokens = (BigInt(run.final.tokens) - BigInt(run.initial.tokens)).toString();
            }
            catch {
                /* Preserve confirmed receipt evidence if RPC is unavailable. */
            }
            d.emit(run.remainingTestTokens === "0"
                ? "ROUND_TRIP_REQUIRES_RECONCILIATION"
                : "REAL POSITION REMAINS OPEN", {
                mint: SMOKE_USDC,
                remainingAmount: run.remainingTestTokens,
                buySignature: run.buy.signature,
                sellError: run.reason,
                currentTokenBalance: run.final?.tokens ?? null,
            });
        }
        else if (run.buy.submitted)
            d.emit("REAL POSITION MAY REMAIN OPEN", {
                mint: SMOKE_USDC,
                signature: run.buy.signature,
                reason: run.reason,
            });
    }
    run.finishedAt = new Date().toISOString();
    d.save(run);
    d.emit(run.status === "PASS"
        ? "REAL SOLANA BUY → SELL VERIFIED"
        : "SMOKE_BLOCKED_OR_INCOMPLETE", run);
    return run;
}
export async function smokeLive() {
    const journal = smokeJournal(resolve(dirname(env.DATABASE_PATH), "live-smoke-test.json"));
    const emit = (event, value) => process.stdout.write(json({ event, data: value }) + "\n");
    let release;
    const run = newSmokeRecord();
    try {
        release = acquireLock(env.DATABASE_PATH);
        if (journal.consumed())
            throw new Blocked("SMOKE_ALREADY_SUBMITTED_NO_REPLAY_REVIEW_EXISTING_JOURNAL");
        const principal = smokeAmount(process.env.LIVE_SMOKE_TEST_SOL);
        if (process.env.LIVE_SMOKE_TEST_ACK !== "true")
            throw new Blocked("LIVE_SMOKE_TEST_ACK_REQUIRED");
        if (env.TRADING_MODE !== "live" || !env.LIVE_TRADING_ACK)
            throw new Blocked("LIVE_TRADING_ACK_REQUIRED");
        const signer = localWallet();
        signer.secretKey.fill(0);
        const rpc = new Solana(), provider = new JupiterExecutionProvider(rpc);
        const result = await executeSmoke({ ack: true, live: true, wallet: env.WALLET_PUBLIC_KEY, principal }, {
            provider,
            rpc,
            save: journal.save,
            consumeOnce: journal.consumeOnce,
            emit,
        }, run);
        if (result.status !== "PASS")
            process.exitCode = 2;
    }
    catch (error) {
        run.reason = safeError(error);
        run.finishedAt = new Date().toISOString();
        // Keep any prior submission record intact. Preflight failures get a separate report.
        const file = resolve(dirname(env.DATABASE_PATH), "live-smoke-preflight.json");
        mkdirSync(dirname(file), { recursive: true });
        durableWrite(file, json(run) + "\n");
        emit(run.buy.submitted
            ? "SMOKE_FATAL_AFTER_SUBMISSION_REQUIRES_REVIEW"
            : "SMOKE_BLOCKED_BEFORE_SIGNING", {
            reason: run.reason,
            buySubmissions: Number(run.buy.submitted),
            sellSubmissions: Number(run.sell.submitted),
            buySignature: run.buy.signature,
            sellSignature: run.sell.signature,
        });
        if (run.buy.submitted && !run.sell.evidence)
            emit("REAL POSITION MAY REMAIN OPEN", {
                mint: SMOKE_USDC,
                buySignature: run.buy.signature,
                remainingAmount: run.remainingTestTokens ?? "UNKNOWN",
                error: run.reason,
            });
        process.exitCode = 2;
    }
    finally {
        release?.();
        emit("BOT STOPPED", {});
    }
}
if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    void smokeLive().catch(() => {
        process.stdout.write("SMOKE_FATAL_STOP\n");
        process.exitCode = 2;
    });
