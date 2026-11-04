import { startServer } from "./server.js";
import { log, safeError } from "./util.js";
void startServer({ normalLive: true }).catch((error) => {
    log("normal_live_startup_failed", { reason: safeError(error) });
    process.exitCode = 1;
});
