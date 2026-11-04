import { existsSync, readFileSync } from "node:fs";
const metadata = new URL("./build-info.json", import.meta.url);
const build = existsSync(metadata)
    ? JSON.parse(readFileSync(metadata, "utf8"))
    : { id: "dev", builtAt: null };
// Captured on module load: an old process cannot claim a newly written build's identity.
export const runtimeInfo = {
    policy: "TRENDING_FINAL_STRUCTURE_V1",
    pid: process.pid,
    loadedAt: new Date().toISOString(),
    node: process.versions.node,
    buildId: build.id,
    builtAt: build.builtAt,
};
