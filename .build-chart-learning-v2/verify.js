import { JupiterExecutionProvider, localWallet } from "./execution-provider.js";
import { SMOKE_USDC, smokeAmount } from "./smoke-policy.js";
import { env } from "./config.js";
import { Gmgn, normalizeMarket, SOL } from "./gmgn.js";
import { Solana } from "./solana.js";
import { Blocked } from "./domain.js";
import { json, safeError } from "./util.js";
export async function verify(target) {
    if (target === "execution") {
        const rpc = new Solana(), provider = new JupiterExecutionProvider(rpc);
        const configuration = {
            smokeAck: process.env.LIVE_SMOKE_TEST_ACK === "true",
            configuredSmokeSol: process.env.LIVE_SMOKE_TEST_SOL ?? "0.005",
            signer: "UNVERIFIED",
            principal: "UNVERIFIED",
        };
        try {
            const signer = localWallet();
            signer.secretKey.fill(0);
            configuration.signer = "MATCHED";
        }
        catch (error) {
            configuration.signer = safeError(error);
        }
        try {
            configuration.principal = smokeAmount(process.env.LIVE_SMOKE_TEST_SOL).toString();
        }
        catch (error) {
            configuration.principal = safeError(error);
        }
        try {
            const buy = await provider.quoteBuy(SMOKE_USDC, 5000000n, 100);
            const reverse = await provider.quoteSell(SMOKE_USDC, BigInt(buy.order.outAmount), 100, true);
            await provider.simulate(buy);
            return {
                configuration,
                provider: provider.health,
                quotePrincipalLamports: buy.amount,
                quoteExpectedTokens: buy.order.outAmount,
                buyRoute: buy.order.routePlan,
                reverseRoute: reverse.order.routePlan,
                simulation: "PASSED_NOT_A_TRADE",
                blocked: configuration.signer !== "MATCHED"
                    ? configuration.signer
                    : configuration.principal !== "5000000"
                        ? configuration.principal
                        : undefined,
                broadcasts: 0,
            };
        }
        catch (error) {
            return {
                configuration,
                provider: provider.health,
                blocked: safeError(error),
                broadcasts: 0,
            };
        }
    }
    if (target === "wallet") {
        if (!env.WALLET_PUBLIC_KEY)
            throw new Blocked("MISSING_WALLET_PUBLIC_KEY");
        const rpc = new Solana();
        return {
            wallet: env.WALLET_PUBLIC_KEY,
            balanceLamports: (await rpc.balance(env.WALLET_PUBLIC_KEY)).toString(),
            rpcVersion: await rpc.connection.getVersion(),
            broadcasts: 0,
        };
    }
    if (target === "gmgn") {
        const g = new Gmgn(), candidates = await g.discover();
        if (!candidates[0])
            throw new Blocked("GMGN discovery returned no current tokens");
        const info = await g.info(candidates[0].mint);
        const engineSettings = (await import("./config.js")).defaultSettings();
        const security = await g.security(candidates[0], engineSettings), intelligence = await g.intelligence(candidates[0], info, security, engineSettings);
        return {
            discovered: candidates.length,
            sample: candidates[0],
            market: normalizeMarket(info),
            security,
            intelligence,
            solPrice: normalizeMarket(await g.info(SOL)).price,
            broadcasts: 0,
        };
    }
    throw new Blocked("Unknown verification command");
}
const target = process.argv[2];
if (target)
    verify(target)
        .then((result) => {
        const blocked = "blocked" in result && !!result.blocked;
        process.stdout.write(json({
            target,
            status: blocked ? "BLOCKED" : "PASSED",
            result,
            broadcasts: 0,
        }) + "\n");
        if (blocked)
            process.exitCode = 2;
    })
        .catch((error) => {
        process.stdout.write(json({
            target,
            status: "BLOCKED",
            reason: safeError(error),
            broadcasts: 0,
        }) + "\n");
        process.exitCode = 2;
    });
