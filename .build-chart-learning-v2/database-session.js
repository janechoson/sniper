import { dirname, resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { env } from "./config.js";
import { DatabaseRegistry } from "./database-registry.js";
export const databaseDirectory = () => resolve(env.DATABASE_DIRECTORY ?? dirname(resolve(env.DATABASE_PATH)));
export function tradingDatabasePath(mode) {
    if (mode !== "demo" && mode !== "live")
        throw Error("EXPLICIT_TRADING_MODE_REQUIRED");
    const root = databaseDirectory();
    return existsSync(join(root, "database-split-manifest.json")) ||
        existsSync(join(root, mode + ".sqlite"))
        ? join(root, mode + ".sqlite")
        : resolve(env.DATABASE_PATH);
}
/** Maintenance/research commands share the canonical learning connection and
 * may not revive a legacy learning database after cutover. */
export function openResearchSession() {
    const root = databaseDirectory();
    if (existsSync(env.DATABASE_PATH) &&
        !existsSync(join(root, "database-split-manifest.json")))
        throw Error("RUN_OFFLINE_DATABASE_MIGRATION_FIRST");
    const registry = new DatabaseRegistry(root);
    return {
        registry,
        store: registry.demo,
        learning: registry.learning,
        close: () => registry.close(),
    };
}
