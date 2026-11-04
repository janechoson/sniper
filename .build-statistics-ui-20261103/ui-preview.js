// Explicit UI preview: these process flags override any live values in .env.
Object.assign(process.env, {
    TRADING_MODE: "paper",
    LIVE_TRADING_ACK: "false",
    NEW_ENTRIES_ENABLED: "false",
    SCANNER_ENABLED: "false",
});
const { startServer } = await import("./server.js");
await startServer();
export {};
