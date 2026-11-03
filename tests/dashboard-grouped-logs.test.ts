import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const moduleUrl = pathToFileURL(resolve("public/dashboard-logs.js")).href;
const { normalizeLogEvent: n, groupLogEntries: group } = await import(
  moduleUrl
);
const t = Date.UTC(2026, 10, 3, 3);
const a = "11111111-1111-4111-8111-111111111111",
  b = "22222222-2222-4222-8222-222222222222";
const event = (
  id: number,
  at: number,
  payload: Record<string, unknown>,
  mint = "mint",
) => n({ id, at, mint, payload: { mode: "live", ...payload } });
test("Logs group eight stages into one attempt and preserve chronological timeline", () => {
  const rows = Array.from({ length: 8 }, (_, i) =>
    event(i, t + i, {
      attemptId: a,
      stage: "SECURITY",
      status: i === 7 ? "FAIL" : "PASS",
      reason: i === 7 ? "holder missing" : "ok",
    }),
  );
  const groups = group(rows.reverse());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].events.length, 8);
  assert.equal(groups[0].latest.result, "FAIL");
  assert.deepEqual(
    groups[0].events.map((e: any) => e.at),
    Array.from({ length: 8 }, (_, i) => t + i),
  );
});
test("Logs never collapse separate fresh attempts or trading modes for same mint", () => {
  const rows = [
    event(1, t, { attemptId: a, type: "ATTEMPT_STARTED" }),
    event(2, t + 1, { attemptId: a, stage: "SECURITY", status: "FAIL" }),
    event(3, t + 20, { attemptId: b, type: "ATTEMPT_STARTED" }),
    event(4, t + 21, { attemptId: b, stage: "SECURITY", status: "PASS" }),
    n({
      id: 5,
      at: t + 22,
      mint: "mint",
      payload: {
        mode: "paper",
        attemptId: b,
        stage: "SECURITY",
        status: "PASS",
      },
    }),
  ];
  assert.equal(group(rows).length, 3);
});
test("Logs use actual ATTEMPT reason format, never a position UUID as attempt", () => {
  assert.equal(
    event(1, t, { type: "ATTEMPT_STARTED", reason: a }).attemptId,
    a,
  );
  assert.equal(
    event(2, t, {
      type: "ATTEMPT_REJECTED",
      reason: a + " · COMMON_RISK · liquidity",
    }).attemptId,
    a,
  );
  assert.equal(
    event(3, t, { type: "POSITION_OPENED", reason: a, positionId: a })
      .attemptId,
    "",
  );
});
test("Logs attach untagged stage only inside a known attempt interval; system stays standalone", () => {
  const rows = [
    event(1, t, { type: "ATTEMPT_STARTED", reason: a }),
    event(2, t + 1, { type: "SECURITY_PASS" }),
    event(3, t + 2, { type: "ATTEMPT_REJECTED", reason: a + " · RISK · DENY" }),
    event(4, t + 3, { type: "SECURITY_PASS" }),
    event(5, t + 1, { type: "SYSTEM_STARTED" }, ""),
  ];
  const g = group(rows);
  assert.equal(g.length, 3);
  assert.equal(g.find((v: any) => v.attemptId === a).events.length, 3);
  assert.equal(g.filter((v: any) => v.kind === "system").length, 1);
});
test("Logs preserve same-millisecond stage order, dedupe repeated polls, append live failure", () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    n(
      {
        at: t,
        stage: "SECURITY",
        status: i === 11 ? "FAIL" : "PASS",
        message: String(i),
      },
      "attempt",
      { attemptId: a, mint: "mint", index: i },
    ),
  );
  const g = group([...rows, ...rows]);
  assert.equal(g.length, 1);
  assert.equal(g[0].events.length, 12);
  assert.equal(g[0].latest.result, "FAIL");
});
test("Logs use explicit owner and BOUGHT outcome even after loser update", () => {
  const context = {
    attemptId: a,
    mint: "mint",
    mode: "live",
    owner: "KRONOS",
    attemptResult: "BOUGHT",
  };
  const g = group([
    n(
      { at: t, message: "KRONOS: BUY", stage: "BUY", status: "PASS" },
      "attempt",
      context,
    ),
    n(
      { at: t + 1, message: "STANDARD: REJECT", stage: "RISK", status: "FAIL" },
      "attempt",
      context,
    ),
  ]);
  assert.equal(g[0].owner, "KRONOS");
  assert.equal(g[0].result, "BOUGHT");
  assert.deepEqual(g[0].strategies, ["KRONOS", "STANDARD"]);
});
test("Logs keep position and execution lifecycle groups separate from candidate attempts", () => {
  const g = group([
    event(1, t, { type: "ATTEMPT_STARTED", reason: a }),
    event(2, t + 1, { type: "POSITION_OPENED", positionId: "position-1" }),
    event(3, t + 2, { type: "POSITION_QUOTE", positionId: "position-1" }),
    event(4, t + 3, { type: "BUY_SUBMITTED", executionId: "execution-1" }),
  ]);
  assert.equal(g.length, 3);
  assert.equal(g.find((v: any) => v.kind === "position").events.length, 2);
});
