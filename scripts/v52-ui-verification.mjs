import { chromium } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
const directory = mkdtempSync(join(tmpdir(), "bot-v52-ui-"));
const port = 41000 + Math.floor(Math.random() * 10000),
  base = `http://127.0.0.1:${port}`;
Object.assign(process.env, {
  TRADING_MODE: "paper",
  LIVE_TRADING_ACK: "false",
  SCANNER_ENABLED: "false",
  PORT: String(port),
  DATABASE_PATH: join(directory, "bot.sqlite"),
  WALLET_PUBLIC_KEY: "",
  GMGN_API_KEY: "",
  GMGN_PRIVATE_KEY: "",
  GMGN_PRIVATE_KEY_PATH: "",
  TYPESAFE_API_KEY: "",
  JUPITER_API_KEY: "",
});
const { startServer } = await import("../dist/server.js");
const app = await startServer();
// Keep the actual local HTTP handlers, while disabling runtime/provider workers.
await app.engine.stop();
const db = app.engine.store,
  e = app.engine,
  mutations = [];
app.server.on("request", (req) => {
  if (req.method === "POST") mutations.push(req.url);
});
let browser;
try {
  const now = Date.now(),
    phases = [
      "INITIAL_EXPANSION",
      "WAITING_FOR_SELLING",
      "SEARCHING_FOR_SUPPORT",
      "SUPPORT_FORMING",
      "RECOVERY_ATTEMPT",
      "SUPPORT_CONFIRMED",
      "SUPPORT_FAILED",
      "RECOVERY_FAILED",
    ];
  const mints = [];
  for (let i = 0; i < 30; i++) {
    const mint = new PublicKey(new Uint8Array(32).fill(i + 1)).toBase58();
    mints.push(mint);
    const c = {
      mint,
      symbol: `TOKEN${i}`,
      source: "TRENDING",
      discovery: { sources: ["TRENDING"], firstSeenAt: now, lastSeenAt: now },
      discoveredAt: now,
    };
    db.discover(c);
    e.candidates.refill([c]);
    const row = e.structure.admit(
      c,
      { authorityRevision: 0, snapshotHash: "ui-fixture" },
      now - (i % 8) * 60000,
    );
    Object.assign(row, {
      phase: phases[i % phases.length],
      lastObservedAt:
        i % 3 === 0 ? undefined : now - (i % 3 === 1 ? 6000 : 102000),
      quality: i % 3 === 0 ? "UNKNOWN" : i % 3 === 1 ? "FRESH" : "STALE",
      sellingSeen: i % 8 >= 2,
      sellingCount: i % 8 >= 2 ? 2 : 0,
      absorptionCount: [4, 5, 7].includes(i % 8) ? 2 : i % 8 === 3 ? 1 : 0,
      absorptionDetected: [4, 5, 7].includes(i % 8),
      supportCount: [4, 5, 7].includes(i % 8) ? 2 : i % 8 === 3 ? 1 : 0,
      supportConfirmed: [4, 5, 7].includes(i % 8),
      recoveryCount: i % 8 === 4 ? 1 : 0,
    });
    db.db
      .prepare("UPDATE entry_structure_watch SET payload=? WHERE mint=?")
      .run(JSON.stringify(row), mint);
    e.candidates.structureWait(mint, row.structureWatchExpiresAt);
  }
  const id = randomUUID(),
    position = {
      id,
      provider: "JUPITER",
      mint: new PublicKey(new Uint8Array(32).fill(89)).toBase58(),
      symbol: "DUST",
      mode: "paper",
      state: "OPEN",
      quantity: "1234567",
      originalQuantity: "1234567",
      decimals: 6,
      costLamports: "2000000",
      remainingCostLamports: "2000000",
      realizedLamports: "0",
      entryAt: now - 3600000,
      highWaterLamports: "2000000",
      takenProfits: [],
      lastValueLamports: "100",
      lastQuoteAt: now,
    };
  db.savePosition(position);
  const csrf = (await (await fetch(base + "/api/status")).json()).csrf;
  const headers = {
    Origin: base,
    "x-csrf-token": csrf,
    "Content-Type": "application/json",
  };
  const post = async (path, body) =>
    fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(
    (
      await fetch(base + "/api/watch/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mint: mints[0] }),
      })
    ).status,
    403,
  );
  await post("/api/settings", e.settings);
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => typeof statusData !== "undefined");
  await page.evaluate(() => stream.close());
  await page.locator('[data-view="watchlist"]').click();
  assert.equal(
    await page.locator("#structureWatchRows .structure-watch-row").count(),
    30,
  );
  const first = page
    .locator("#structureWatchRows .structure-watch-row")
    .first();
  const height = await first.evaluate(
    (row) => row.getBoundingClientRect().height,
  );
  assert(height >= 65 && height <= 80, `desktop row height ${height}`);
  assert.match(await first.innerText(), /10:00/);
  assert.doesNotMatch(
    await page.locator("#structureWatchRows").innerText(),
    /không phải thời gian chờ bắt buộc/,
  );
  assert(
    await page
      .locator("#structureWatchRows")
      .evaluate((row) => row.scrollHeight > row.clientHeight),
  );
  assert(
    !(await first.evaluate((row) =>
      getComputedStyle(row).borderColor.includes("200, 57, 43"),
    )),
  );
  const beforePosts = mutations.filter(
    (p) => p === "/api/watch/dismiss",
  ).length;
  await first.locator("summary").click();
  await first.getByRole("button", { name: "Bỏ theo dõi", exact: true }).click();
  await page
    .locator("#removeConfirm")
    .getByRole("button", { name: "Hủy", exact: true })
    .click();
  assert.equal(
    mutations.filter((p) => p === "/api/watch/dismiss").length,
    beforePosts,
  );
  await first.locator("summary").click();
  await first.getByRole("button", { name: "Bỏ theo dõi", exact: true }).click();
  await page
    .locator("#removeConfirm")
    .getByRole("button", { name: "Bỏ theo dõi", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#structureWatchRows .structure-watch-row")
        .length === 29,
  );
  const removed = db.positions("paper");
  assert.equal(removed.length, 1);
  const target = e.structure.list().find((r) => r.status === "USER_REMOVED");
  assert(target);
  const revision = db.candidateAuthority(target.mint, "paper").revision;
  assert.equal(
    (await post("/api/watch/dismiss", { mint: target.mint })).status,
    200,
  );
  assert.equal(db.candidateAuthority(target.mint, "paper").revision, revision);
  // Mutation failure must leave the authoritative row visible.
  await page.route("**/api/watch/dismiss", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Không thể bỏ theo dõi trong kiểm thử" }),
    }),
  );
  const remaining = page
    .locator("#structureWatchRows .structure-watch-row")
    .first();
  await remaining.locator("summary").click();
  await remaining
    .getByRole("button", { name: "Bỏ theo dõi", exact: true })
    .click();
  await page
    .locator("#removeConfirm")
    .getByRole("button", { name: "Bỏ theo dõi", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .getElementById("notice")
      .textContent.includes("Không thể bỏ theo dõi"),
  );
  assert.equal(
    await page.locator("#structureWatchRows .structure-watch-row").count(),
    29,
  );
  await page.unroute("**/api/watch/dismiss");
  await page.locator('[data-view="positions"]').click();
  const card = page.locator("#positionRows .position-card").first();
  await card.locator("summary").filter({ hasText: "⋮" }).click();
  await card
    .getByRole("button", { name: "Xóa khỏi Position", exact: true })
    .click();
  assert.match(
    await page.locator("#removeConfirm").innerText(),
    /KHÔNG bán token.*blockchain/,
  );
  assert.match(await page.locator("#removeConfirm").innerText(), /DUST/);
  await page
    .locator("#removeConfirm")
    .getByRole("button", { name: "Xóa khỏi Position", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#positionRows .position-card").length === 0,
  );
  assert.equal(db.positions("paper")[0].quantity, "1234567");
  assert.equal(db.positions("paper")[0].state, "OPEN");
  assert(db.positions("paper")[0].dismissal);
  assert.equal(
    (await post("/api/positions/dismiss", { positionId: id })).status,
    200,
  );
  await page.reload();
  await page.waitForFunction(() => typeof statusData !== "undefined");
  await page.evaluate(() => stream.close());
  await page.locator('[data-view="positions"]').click();
  assert.equal(await page.locator("#positionRows .position-card").count(), 0);
  await page.locator('[data-view="watchlist"]').click();
  assert.equal(
    await page.locator("#structureWatchRows .structure-watch-row").count(),
    29,
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 2,
      ),
      false,
    );
    await page.screenshot({
      path: `data/trending-final-gate-watch-${width}.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  assert.equal(db.executions().length, 0);
  const eligible = await page.evaluate(() => {
    const sample = {
      mint: "fixture-eligible",
      evidenceCurrent: true,
      phase: "RECOVERY_CONFIRMED",
      status: "PASSED",
      structureWatchStartedAt: Date.now() - 120000,
      structureWatchExpiresAt: Date.now() + 480000,
      lastObservedAt: Date.now(),
      quality: "FRESH",
      sellingSeen: true,
      absorptionDetected: true,
      supportConfirmed: true,
      recoveryCount: 3,
    };
    const a = window.BOTStructurePanel(sample, "TRENDING"),
      b = window.BOTStructurePanel(
        { ...sample, structureWatchStartedAt: Date.now() - 300000 },
        "TRENDING",
      );
    return {
      text: a.textContent,
      sameProgress:
        a.querySelector(".structure-evidence-rail i").style.width ===
        b.querySelector(".structure-evidence-rail i").style.width,
    };
  });
  assert.match(eligible.text, /ĐỦ CẤU TRÚC/);
  assert.equal(eligible.sameProgress, true);
  const variants = await page.evaluate(() => {
    const host = document.createElement("div");
    document.body.append(host);
    const phases = [
      "INITIAL_EXPANSION",
      "WAITING_FOR_SELLING",
      "SEARCHING_FOR_SUPPORT",
      "SUPPORT_FORMING",
      "RECOVERY_ATTEMPT",
      "RECOVERY_CONFIRMED",
    ];
    const quality = ["FRESH", "STALE_USABLE", "STALE", "UNKNOWN", "DEGRADED"];
    const rows = phases.map((phase) =>
      window.BOTStructurePanel(
        {
          mint: "GHiwGXLongMintForEllipsisVerification999999pump",
          evidenceCurrent: true,
          phase,
          status: phase === "RECOVERY_CONFIRMED" ? "PASSED" : "ACTIVE",
          structureWatchStartedAt: Date.now() - 100000,
          structureWatchExpiresAt: Date.now() + 500000,
          lastObservedAt: Date.now() - 6000,
          quality: "FRESH",
        },
        "TRENDING",
      ),
    );
    const freshness = quality.map((q) =>
      window.BOTStructurePanel(
        {
          mint: "quality-fixture",
          phase: "WAITING_FOR_SELLING",
          status: "ACTIVE",
          structureWatchStartedAt: Date.now() - 100000,
          structureWatchExpiresAt: Date.now() + 500000,
          lastObservedAt: q === "UNKNOWN" ? undefined : Date.now() - 6000,
          quality: q,
        },
        "TRENDING",
      ),
    );
    host.append(...rows, ...freshness);
    window.BOTWatchTick();
    const result = {
      phases: rows.map(
        (row) => row.querySelector(".structure-row-phase").textContent,
      ),
      quality: freshness.map(
        (row) => row.querySelector(".structure-freshness").textContent,
      ),
      compactMint: rows[0].querySelector("b").textContent.includes("…"),
      tones: rows.map((row) => row.dataset.tone),
    };
    host.remove();
    return result;
  });
  assert.equal(variants.phases.length, 6);
  assert(variants.phases.every((text) => !text.includes("Chưa xác định")));
  assert.match(variants.quality[0], /● 6s/);
  assert.match(variants.quality[1], /Cũ/);
  assert.match(variants.quality[2], /Cũ/);
  assert.match(variants.quality[3], /Chưa có dữ liệu/);
  assert.match(variants.quality[4], /Cũ/);
  assert(variants.compactMint);
  assert(variants.tones.every((tone) => tone !== "danger"));
  const pendingId = randomUUID(),
    pendingPosition = {
      ...position,
      id: pendingId,
      mint: new PublicKey(new Uint8Array(32).fill(90)).toBase58(),
    };
  db.savePosition(pendingPosition);
  const pending = db.claim({
    id: randomUUID(),
    key: "ui-pending-removal",
    provider: "JUPITER",
    mint: pendingPosition.mint,
    side: "SELL",
    mode: "paper",
    amount: "1",
    positionId: pendingId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10000,
    snapshotHash: "fixture",
    reason: "pending fixture",
  });
  assert.equal(
    (await post("/api/positions/dismiss", { positionId: pendingId })).status,
    409,
  );
  assert.equal(db.pending()[0].id, pending.id);
  const report = {
    at: new Date().toISOString(),
    desktopRowHeight: height,
    rows: 30,
    remainingWatchRows: 29,
    positionQuantityAfterRemoval: "1234567",
    reloadPersists: true,
    csrfRejection: true,
    cancelNoMutation: true,
    failureKeepsRow: true,
    pendingRemovalBlocked: true,
    progressIndependentOfElapsedTime: true,
    eligibleBadge: true,
    renderingVariants: variants,
    viewportWidths: [1440, 1024, 390],
    browserErrors: errors,
    signatures: 0,
    submissions: 0,
    liveEnabled: false,
  };
  writeFileSync(
    "data/trending-final-gate-ui-verification.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  await app.stop();
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith("bot-v52-ui-")
  )
    throw Error("Unsafe temp directory cleanup");
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
