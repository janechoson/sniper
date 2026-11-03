import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { dashboardPositionCount } from "../src/dashboard-view.js";
import { positionViews } from "../src/position-view.js";
import type { Position } from "../src/domain.js";
import { position } from "./fixtures.js";

const attention: NonNullable<Position["attention"]> = {
  status: "UNKNOWN",
  issue: {
    code: "FIXTURE",
    scope: "POSITION",
    stage: "PRE_SELL",
    reasonCode: "FIXTURE",
    retryable: true,
    detectedAt: 1,
  },
  lastChecked: 1,
  nextCheckAt: 1,
  failureCount: 1,
  protectiveExit: "RECONCILING",
};
const cases: {
  name: string;
  patch?: Partial<Position>;
  state?: string;
  signature?: string;
  count: number;
}[] = [
  { name: "held OPEN", count: 1 },
  { name: "zero OPEN", patch: { quantity: "0" }, count: 0 },
  {
    name: "unsigned pending entry is not a holding",
    patch: { state: "PENDING_ENTRY", quantity: "0" },
    state: "CREATED",
    count: 0,
  },
  {
    name: "unsigned submitted zero entry",
    patch: { state: "PENDING_ENTRY", quantity: "0" },
    state: "SUBMITTED",
    count: 0,
  },
  ...["SUBMITTED", "PENDING_CONFIRMATION", "UNKNOWN", "AMBIGUOUS"].map(
    (state) => ({
      name: "signed unresolved " + state,
      patch: { state: "PENDING_ENTRY" as const, quantity: "0" },
      state,
      signature: "fixture-only-no-signing",
      count: 1,
    }),
  ),
  {
    name: "failed signed zero entry",
    patch: { state: "PENDING_ENTRY", quantity: "0" },
    state: "FAILED",
    signature: "fixture-only-no-signing",
    count: 0,
  },
  {
    name: "explicit UNKNOWN attention remains visible",
    patch: { quantity: "0", attention },
    count: 1,
  },
  {
    name: "dismissed holding",
    patch: {
      dismissal: {
        status: "MANUALLY_REMOVED",
        dismissedAt: 1,
        dismissedBy: "USER",
        reason: "USER_MANUAL",
      },
    },
    count: 0,
  },
  { name: "CLOSED", patch: { state: "CLOSED" }, count: 0 },
  { name: "FAILED", patch: { state: "FAILED" }, count: 0 },
  {
    name: "pending SELL with remaining quantity",
    patch: { state: "PENDING_EXIT" },
    count: 1,
  },
  {
    name: "quantity beyond SQLite signed int64",
    patch: { quantity: "999999999999999999999999999999" },
    count: 1,
  },
];
for (const c of cases)
  test("light badge matches visible Positions: " + c.name, () => {
    const store = new Store(":memory:");
    try {
      const p: Position = { ...position(), ...c.patch, mode: "paper" };
      store.savePosition(p);
      store.savePosition({ ...position(), id: "other-mode", mode: "live" });
      if (c.state) {
        const payload = {
          id: "fixture-exec",
          intent: {
            id: "fixture-intent",
            side: "BUY",
            mode: p.mode,
            positionId: p.id,
            amount: "1",
          },
          state: c.state,
          signature: c.signature,
          at: 1,
        };
        store.db
          .prepare("INSERT INTO executions VALUES(?,?,?,?,?)")
          .run(
            payload.id,
            payload.intent.id,
            payload.state,
            c.signature ?? null,
            JSON.stringify(payload),
          );
      }
      assert.deepEqual(dashboardPositionCount(store, "paper"), {
        count: c.count,
      });
      assert.equal(
        dashboardPositionCount(store, "paper").count,
        positionViews(store.positions("paper"), store.executions()).filter(
          (p) => p.relevant,
        ).length,
      );
      assert.deepEqual(dashboardPositionCount(store, "live"), { count: 1 });
    } finally {
      store.close();
    }
  });
