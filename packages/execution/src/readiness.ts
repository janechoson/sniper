export type Capability =
  | "CONFIG_READY"
  | "RPC_READY"
  | "WALLET_READY"
  | "SIGNER_READY"
  | "BALANCE_READY"
  | "FEE_RESERVE_READY"
  | "PRICE_READY"
  | "SIZING_READY"
  | "NATIVE_ROUTE_READY"
  | "QUOTE_READY"
  | "REVERSE_QUOTE_READY"
  | "ROUND_TRIP_READY"
  | "SECURITY_READY"
  | "JEV_READY"
  | "RISK_READY"
  | "BUILD_TX_READY"
  | "SIMULATION_READY"
  | "SIGNING_READY";
export function deriveReadiness(proof: Partial<Record<Capability, boolean>>) {
  const technical: Capability[] = [
    "CONFIG_READY",
    "RPC_READY",
    "WALLET_READY",
    "SIGNER_READY",
    "BALANCE_READY",
    "FEE_RESERVE_READY",
    "PRICE_READY",
    "SIZING_READY",
    "NATIVE_ROUTE_READY",
    "QUOTE_READY",
    "REVERSE_QUOTE_READY",
    "ROUND_TRIP_READY",
    "BUILD_TX_READY",
    "SIMULATION_READY",
    "SIGNING_READY",
  ];
  const executionPreflightReady = technical.every((k) => proof[k] === true);
  return {
    executionPreflightReady,
    liveDryRunReady:
      executionPreflightReady &&
      proof.SECURITY_READY === true &&
      proof.JEV_READY === true &&
      proof.RISK_READY === true,
    liveReady: false,
    broadcastReady: false,
    confirmationReady: false,
    confirmation: "CANARY_REQUIRED",
    broadcast: "LOCKED",
    missing: technical
      .concat(["SECURITY_READY", "JEV_READY", "RISK_READY"])
      .filter((k) => proof[k] !== true),
  };
}
