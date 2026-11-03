import { Blocked, type Intent, type Position } from "./domain.js";
import { KRONOS } from "./kronos-domain.js";
import { validProtection } from "./exit-safety.js";

/** Main-custody guard, used by both atomic claim and immediate execution validation. */
export function assertStrategySell(i: Intent, p: Position, now = Date.now()) {
  if (i.positionId !== p.id || i.mint !== p.mint || i.mode !== p.mode)
    throw new Blocked("SELL_POSITION_OWNER_MISMATCH");
  const owner = p.strategy ?? "STANDARD";
  if ((i.strategy ?? "STANDARD") !== owner)
    throw new Blocked("SELL_STRATEGY_OWNER_MISMATCH");
  if (owner !== "KRONOS") {
    if (i.exitAuthority === "KRONOS" || i.decisionSource === "KRONOS")
      throw new Blocked("KRONOS_CANNOT_SELL_STANDARD");
    return;
  }
  if (i.exitAuthority === "MANUAL" && i.manualRequestId) return;
  if (i.exitAuthority === "SECURITY" || i.exitAuthority === "PROTECTIVE") {
    const proof = p.pendingExits?.find(
      (o) => o.id === i.exitOpportunityId,
    )?.protection;
    if (
      !validProtection(proof, p, now) ||
      !proof ||
      !["SECURITY_CRITICAL", "LIQUIDITY_COLLAPSE"].includes(proof.kind) ||
      i.amount !== p.quantity
    )
      throw new Blocked("KRONOS_GLOBAL_SAFETY_AUTHORITY_REQUIRED");
    return;
  }
  const d = p.kronosDecision;
  const opportunity = p.pendingExits?.find(
    (o) =>
      o.id === i.exitOpportunityId &&
      o.kind === "STRATEGIC" &&
      o.decisionSource === "KRONOS" &&
      o.decisionId === i.decisionId,
  );
  if (
    !opportunity ||
    i.exitAuthority !== "KRONOS" ||
    i.decisionSource !== "KRONOS" ||
    !d ||
    d.action !== "SELL" ||
    d.decisionId !== i.decisionId ||
    d.quantity !== p.quantity ||
    i.amount !== p.quantity ||
    !Number.isFinite(d.decisionAt) ||
    d.decisionAt > now ||
    now - d.decisionAt > KRONOS.priceMaxAgeMs
  )
    throw new Blocked("FRESH_FULL_KRONOS_SELL_REQUIRED");
}
