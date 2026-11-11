import type { DatabaseSync } from "node:sqlite";

export interface MigrationBlocker {
  code: string;
  id?: string;
  reason: string;
}

/** Read-only inspection. Never constructs Store, loads credentials or migrates data. */
export function kronosMigrationPreflight(db: DatabaseSync) {
  const blockers: MigrationBlocker[] = [];
  const required = [
    "positions",
    "executions",
    "manual_exits",
    "buy_ownership_claims",
  ];
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String(r.name)),
  );
  for (const table of required)
    if (!tables.has(table))
      blockers.push({
        code: "SCHEMA_REVIEW_REQUIRED",
        reason: `Missing table: ${table}`,
      });
  if (blockers.length) return { eligible: false, blockers };

  for (const row of db
    .prepare("SELECT id,mode,state,payload FROM positions")
    .all()) {
    const id = String(row.id);
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(String(row.payload));
    } catch {
      blockers.push({
        code: "POSITION_EVIDENCE_INVALID",
        id,
        reason: "Invalid position JSON",
      });
      continue;
    }
    if (
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      p.mode !== row.mode ||
      p.state !== row.state ||
      p.id !== row.id
    ) {
      blockers.push({
        code: "POSITION_EVIDENCE_INVALID",
        id,
        reason: "Position columns and payload disagree",
      });
      continue;
    }
    if (row.mode !== "live" && row.mode !== "paper" && row.mode !== "demo") {
      blockers.push({
        code: "MODE_REVIEW_REQUIRED",
        id,
        reason: "Unknown persisted position mode",
      });
      continue;
    }
    const quantityValid =
      typeof p.quantity === "string" && /^\d+$/.test(p.quantity);
    if (!quantityValid) {
      blockers.push({
        code: "POSITION_EVIDENCE_INVALID",
        id,
        reason: "Missing or invalid atomic quantity",
      });
      continue;
    }
    const terminal = ["CLOSED", "FAILED"].includes(String(row.state));
    const held = BigInt(p.quantity as string) > 0n;
    if (row.mode === "paper" && (!terminal || held)) {
      blockers.push({
        code: "LEGACY_PAPER_REQUIRES_ISOLATION",
        id,
        reason:
          "Existing PAPER holdings must not be reinterpreted as a new DEMO account",
      });
    }
    if (row.mode !== "live") continue;
    if (terminal && held) {
      blockers.push({
        code: "LIVE_TERMINAL_HOLDINGS_REQUIRE_REVIEW",
        id,
        reason:
          "Terminal LIVE position has nonzero quantity; dismissal does not prove settlement",
      });
    }
    if (!terminal && (p.strategy ?? "STANDARD") !== "KRONOS") {
      blockers.push({
        code: "LIVE_STANDARD_POSITION_REQUIRES_RESOLUTION",
        id,
        reason:
          "Legacy LIVE owner must retain monitoring until explicit resolution",
      });
    }
    if (!terminal && p.strategy === "KRONOS" && row.state !== "OPEN") {
      blockers.push({
        code: "LIVE_POSITION_RECOVERY_REQUIRED",
        id,
        reason: `LIVE position remains ${String(row.state)}`,
      });
    }
  }

  for (const row of db
    .prepare("SELECT id,state,signature,payload FROM executions")
    .all()) {
    const id = String(row.id);
    let e: {
      state?: string;
      signature?: string;
      intent?: { mode?: string; strategy?: string };
    };
    try {
      e = JSON.parse(String(row.payload));
    } catch {
      blockers.push({
        code: "EXECUTION_EVIDENCE_INVALID",
        id,
        reason: "Invalid execution JSON",
      });
      continue;
    }
    if (
      !e ||
      e.state !== row.state ||
      !["live", "paper", "demo"].includes(e.intent?.mode ?? "") ||
      (e.signature ?? null) !== row.signature
    ) {
      blockers.push({
        code: "EXECUTION_EVIDENCE_INVALID",
        id,
        reason: "Missing or contradictory execution evidence",
      });
      continue;
    }
    if (!["CONFIRMED", "FAILED"].includes(String(row.state))) {
      if (e.intent!.mode === "live" && e.intent!.strategy !== "KRONOS")
        blockers.push({
          code: "LIVE_LEGACY_EXECUTION_REQUIRES_RESOLUTION",
          id,
          reason:
            "Unresolved legacy execution must retain its original recovery owner",
        });
      blockers.push({
        code: "EXECUTION_RECOVERY_REQUIRED",
        id,
        reason: `${e.intent!.mode} execution remains ${String(row.state)}; never replay automatically`,
      });
    }
  }
  for (const row of db.prepare("SELECT id,mode,state FROM manual_exits").all())
    if (!["CONFIRMED", "CANCELLED", "FAILED"].includes(String(row.state)))
      blockers.push({
        code: "MANUAL_EXIT_REVIEW_REQUIRED",
        id: String(row.id),
        reason: `${String(row.mode)} manual exit remains ${String(row.state)}`,
      });

  for (const row of db
    .prepare(
      "SELECT id,mode,active,payload FROM buy_ownership_claims WHERE active=1",
    )
    .all()) {
    let claim: { strategy?: string };
    try {
      claim = JSON.parse(String(row.payload));
    } catch {
      claim = {};
    }
    if (!claim || claim.strategy !== "KRONOS")
      blockers.push({
        code: "LEGACY_ACTIVE_BUY_CLAIM_REQUIRES_REVIEW",
        id: String(row.id),
        reason: "Do not release or transfer a legacy atomic ownership claim",
      });
  }
  return { eligible: blockers.length === 0, blockers };
}
