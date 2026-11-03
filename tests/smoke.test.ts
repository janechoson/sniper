import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeSmoke,
  newSmokeRecord,
  smokeJournal,
  type SmokeRecord,
} from "../src/smoke-live.js";
import {
  smokeAmount,
  acquiredOnly,
  SMOKE_MAX_LAMPORTS,
  SMOKE_MAINNET_GENESIS,
  SMOKE_USDC,
} from "../src/smoke-policy.js";
import type {
  ExecutionQuote,
  SolanaExecutionProvider,
} from "../src/execution-provider.js";
import { Solana } from "../src/solana.js";
import { WALLET, quote } from "./fixtures.js";
import { Blocked } from "../src/domain.js";
function harness() {
  const rpc = new Solana(),
    events: string[] = [],
    saves: SmokeRecord[] = [];
  let sol = 1_000_000_000n,
    tokens = 1234n,
    buys = 0,
    sells = 0,
    consumed = 0,
    failure = false,
    ambiguous = false,
    mutation = false,
    last: ExecutionQuote;
  rpc.balance = async () => sol;
  rpc.tokenBalance = async () => tokens;
  rpc.connection.getGenesisHash = async () => SMOKE_MAINNET_GENESIS;
  rpc.connection.getParsedAccountInfo = async () =>
    ({
      value: {
        data: {
          program: "spl-token",
          parsed: { type: "mint", info: { decimals: 6, isInitialized: true } },
        },
      },
    }) as never;
  rpc.receipt = async (signature) =>
    ({
      slot: 123,
      meta: { err: null, fee: 5000 },
      transaction: { signatures: [signature] },
    }) as never;
  rpc.deltas = () => ({
    sol: last.side === "BUY" ? -5005000n : 4990000n,
    tokens: last.side === "BUY" ? 1_000_000n : -1_000_000n,
  });
  const provider: SolanaExecutionProvider = {
    health: { state: "READY", at: Date.now() },
    getWalletBalance: async () => sol,
    quoteBuy: async (_m, amount) => {
      const q = quote("BUY", amount);
      if (mutation) q.order.inAmount = "50000000";
      return q;
    },
    quoteSell: async (_m, amount, _s, routeOnly) => {
      if (failure && buys) throw new Blocked("JUPITER_SELL_UNAVAILABLE");
      return quote("SELL", amount, WALLET, routeOnly);
    },
    simulate: async () => {},
    execute: async (q, before) => {
      last = q;
      if (q.side === "BUY") {
        buys++;
        assert.equal(consumed, 1);
        assert.equal(q.amount, "5000000");
      } else {
        sells++;
        assert.equal(q.amount, "1000000");
      }
      const sig = "fixture-" + q.side;
      before(sig);
      if (ambiguous) throw new Blocked("JUPITER_TIMEOUT");
      sol += q.side === "BUY" ? -5005000n : 4990000n;
      tokens += q.side === "BUY" ? 1_000_000n : -1_000_000n;
      return sig;
    },
    confirm: async () => (ambiguous ? "UNKNOWN" : "CONFIRMED"),
  };
  return {
    options: { ack: true, live: true, wallet: WALLET, principal: 5_000_000n },
    deps: {
      rpc,
      provider,
      consumeOnce() {
        consumed++;
      },
      save(v: SmokeRecord) {
        saves.push(structuredClone(v));
      },
      emit(e: string) {
        events.push(e);
      },
    },
    events,
    saves,
    buys: () => buys,
    sells: () => sells,
    failSell: () => {
      failure = true;
    },
    ambiguous: () => {
      ambiguous = true;
    },
    wrongAmount: () => {
      mutation = true;
    },
  };
}
test("smoke cap is precisely 5,000,000 lamports; 0.05 value and float/exponent inputs fail", () => {
  assert.equal(SMOKE_MAX_LAMPORTS, 5_000_000n);
  assert.equal(smokeAmount(), 5_000_000n);
  assert.equal(smokeAmount("0.005"), 5_000_000n);
  for (const v of ["0.005000001", "0.05", "0.5", "5e-4", "-0.0005", "0", "NaN"])
    assert.throws(() => smokeAmount(v));
  assert.equal(acquiredOnly(10n, 20n), 10n);
  assert.throws(() => acquiredOnly(20n, 10n));
});
test("isolated fixture round trip sells only acquired amount and retains pre-existing holdings", async () => {
  const h = harness(),
    r = await executeSmoke(h.options, h.deps);
  assert.equal(r.status, "PASS");
  assert.equal(r.initial?.tokens, "1234");
  assert.equal(r.final?.tokens, "1234");
  assert.equal(r.remainingTestTokens, "0");
  assert.equal(r.buy.evidence?.solDelta, "-5005000");
  assert.equal(r.sell.amount, "1000000");
  assert.equal(h.buys(), 1);
  assert.equal(h.sells(), 1);
  assert.ok(h.events.includes("REAL SOLANA BUY → SELL VERIFIED"));
  assert.ok(
    h.saves.some((s) => s.buy.state === "SUBMITTED" && s.buy.signature),
  );
});
test("missing smoke/live ACK and oversized principal block before broadcast", async () => {
  for (const options of [
    { ack: false },
    { live: false },
    { principal: 5_000_001n },
  ]) {
    const h = harness(),
      r = await executeSmoke({ ...h.options, ...options }, h.deps);
    assert.equal(r.status, "FAIL");
    assert.equal(h.buys(), 0);
  }
});
test("provider returning larger principal is rejected before signing", async () => {
  const h = harness();
  h.wrongAmount();
  const r = await executeSmoke(h.options, h.deps);
  assert.equal(r.status, "FAIL");
  assert.equal(h.buys(), 0);
});
test("successful BUY plus failed SELL prominently reports remaining real position; no retries", async () => {
  const h = harness();
  h.failSell();
  const r = await executeSmoke(h.options, h.deps);
  assert.equal(r.status, "PARTIAL");
  assert.equal(r.remainingTestTokens, "1000000");
  assert.ok(h.events.includes("REAL POSITION REMAINS OPEN"));
  assert.equal(h.buys(), 1);
  assert.equal(h.sells(), 0);
  assert.ok(!h.events.includes("REAL SOLANA BUY → SELL VERIFIED"));
});
test("ambiguous BUY is UNKNOWN, never retried and never followed by SELL", async () => {
  const h = harness();
  h.ambiguous();
  const r = await executeSmoke(h.options, h.deps);
  assert.equal(r.buy.state, "UNKNOWN");
  assert.equal(h.buys(), 1);
  assert.equal(h.sells(), 0);
  assert.ok(!h.events.includes("REAL SOLANA BUY → SELL VERIFIED"));
});
test("durable one-shot marker survives restart and cannot be consumed twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "solana-smoke-"));
  try {
    const file = join(dir, "journal.json"),
      j = smokeJournal(file);
    j.save(newSmokeRecord());
    j.consumeOnce();
    assert.equal(smokeJournal(file).consumed(), true);
    assert.throws(() => smokeJournal(file).consumeOnce());
    assert.equal((j.previous() as SmokeRecord).mint, SMOKE_USDC);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
