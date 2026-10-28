export type SecurityFlag =
  | "mintRisk"
  | "freezeRisk"
  | "blacklistRisk"
  | "upgradeRisk"
  | "pauseRisk"
  | "transferRestrictionRisk"
  | "sellRestrictionRisk";
export interface SecurityPolicy {
  requiredFlags: readonly SecurityFlag[];
  requireTaxes: boolean;
}
const evm: SecurityPolicy = {
  requiredFlags: [
    "mintRisk",
    "blacklistRisk",
    "upgradeRisk",
    "pauseRisk",
    "transferRestrictionRisk",
    "sellRestrictionRisk",
  ],
  requireTaxes: true,
};
export const chainSecurityPolicies: Record<string, SecurityPolicy> = {
  solana: {
    requiredFlags: [
      "mintRisk",
      "freezeRisk",
      "transferRestrictionRisk",
      "sellRestrictionRisk",
    ],
    requireTaxes: false,
  },
  bnb: evm,
  robinhood: evm,
};
