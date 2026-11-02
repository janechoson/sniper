export type DiscoverySource = "TRENDING" | "SNIPER";

export interface DiscoveryEvidence {
  sources: DiscoverySource[];
  firstSeenAt: number;
  lastSeenAt: number;
  sniper?: { firstSeenAt: number; lastSeenAt: number };
  trending?: {
    firstSeenAt: number;
    lastSeenAt: number;
    sequenceStartedAt: number;
    sequenceOrigin?: "PROVIDER" | "LOCAL_SNAPSHOT";
    consecutiveObservations: number;
    rank?: number;
    basis: string;
    history: Array<{ at: number; rank: number }>;
    movement:
      | "RISING_FAST"
      | "RISING"
      | "STABLE"
      | "FALLING"
      | "FALLING_FAST"
      | "UNKNOWN";
  };
}
