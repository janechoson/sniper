import type { Settings } from "./config.js";
import type { Snapshot } from "./domain.js";
import {
  hasEntryWatchEligibility,
  hasEligibleStructurePass,
  ENTRY_WATCH_POLICY,
  type StructureWatch,
} from "./sniper-structure.js";

/** The single development switch. Unknown/unset values fail closed. */
export const recoveryGuardConfig = {
  get TEMP_BYPASS_RECOVERY_GUARD() {
    return process.env.TEMP_BYPASS_RECOVERY_GUARD === "true";
  },
};
export interface RecoveryBypassMetadata {
  kind: "TEMP_RECOVERY_BYPASS";
  promotedAt: number;
  watchStartedAt: number;
  watchExpiresAt: number;
  authorityRevision: number;
}
/** Does not mutate evidence, extend TTL, or replace Watch admission/freshness. */
export function canBypassRecovery(
  r: StructureWatch | undefined,
  s: Settings,
  now = Date.now(),
) {
  return (
    !!r &&
    recoveryGuardConfig.TEMP_BYPASS_RECOVERY_GUARD &&
    hasEntryWatchEligibility(r) &&
    r.status === "ACTIVE" &&
    r.structureWatchStartedAt <= now &&
    now <
      Math.min(
        r.structureWatchExpiresAt,
        r.structureWatchStartedAt + s.structureWatchTtlMs,
      ) &&
    r.quality === "FRESH" &&
    r.lastObservedAt !== undefined &&
    r.lastObservedAt >= r.structureWatchStartedAt &&
    r.lastObservedAt <= now &&
    now - r.lastObservedAt <= s.structureMaxGapMs
  );
}
export function recoveryBypassMetadata(
  r: StructureWatch,
  revision: number,
  now = Date.now(),
): RecoveryBypassMetadata {
  return {
    kind: "TEMP_RECOVERY_BYPASS",
    promotedAt: now,
    watchStartedAt: r.structureWatchStartedAt,
    watchExpiresAt: r.structureWatchExpiresAt,
    authorityRevision: revision,
  };
}
export function validRecoveryBypass(
  r: StructureWatch | undefined,
  s: Settings,
  authority: Snapshot["entryAuthority"],
  now = Date.now(),
) {
  const meta = authority?.recoveryBypass;
  return (
    !!meta &&
    !!r &&
    authority?.path === "TRENDING" &&
    authority.policy === ENTRY_WATCH_POLICY &&
    meta.kind === "TEMP_RECOVERY_BYPASS" &&
    meta.authorityRevision === authority.revision &&
    r.eligibility?.authorityRevision === authority.revision &&
    meta.watchStartedAt === r.structureWatchStartedAt &&
    meta.watchExpiresAt === r.structureWatchExpiresAt &&
    meta.promotedAt >= r.structureWatchStartedAt &&
    meta.promotedAt <= now &&
    meta.promotedAt < r.structureWatchExpiresAt &&
    canBypassRecovery(r, s, now)
  );
}
export function recoveryExecutionAllowed(
  r: StructureWatch | undefined,
  s: Settings,
  authority: Snapshot["entryAuthority"],
  now = Date.now(),
) {
  return (
    hasEligibleStructurePass(r, now) ||
    validRecoveryBypass(r, s, authority, now)
  );
}
