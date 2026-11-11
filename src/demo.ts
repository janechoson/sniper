// Explicit DEMO entry point. Existing mode blockers still require LIVE holdings
// to be resolved; this command never starts LIVE recovery or grants a signer.
import { env } from "./config.js";
import { startServer } from "./server.js";
env.TRADING_MODE = "demo";
env.LIVE_TRADING_ACK = false;
await startServer({ demoOnly: true });
