import type { SecurityEvidence } from "@sniper/core";
export function rpcEvidence(
  value: SecurityEvidence["value"],
  state: SecurityEvidence["state"] = "SAFE",
  reference?: string,
  reasonCodes: string[] = [],
): SecurityEvidence {
  return {
    value,
    state,
    source: "RPC",
    origin: "REAL_ONCHAIN",
    observedAt: new Date().toISOString(),
    reference,
    reasonCodes,
  };
}
