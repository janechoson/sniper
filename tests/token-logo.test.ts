import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTokenLogo,
  tokenLogo,
  TOKEN_IMAGE_CSP,
} from "../src/token-metadata.js";
import { parseTrending, parseDiscovery } from "../src/gmgn.js";
import { mergeDiscovery } from "../src/discovery.js";
import { Store } from "../src/store.js";
import { KronosStore } from "../src/kronos-store.js";
import { KronosLab } from "../src/kronos-lab.js";
import { positionViews } from "../src/position-view.js";
import { candidate, position, MINT } from "./fixtures.js";
const LOGO = "https://gmgn.ai/external-res/test.webp",
  NEW = "https://gmgn.ai/external-res/new.webp";
test("GMGN logo survives Trending and legacy listing parsers, with a nullable canonical field", () => {
  const t = parseTrending({
    rank: [{ address: MINT, symbol: "TEST", logo: LOGO }],
  })[0]!;
  assert.equal(t.logo, LOGO);
  assert.equal(t.listing?.logo, LOGO);
  assert.equal(
    parseDiscovery({
      new_creation: [{ address: MINT, logo: LOGO }],
      pump: [],
      completed: [],
    })[0]?.logo,
    LOGO,
  );
  assert.equal(parseTrending({ rank: [{ address: MINT }] })[0]!.logo, null);
});
test("metadata URL policy accepts observed GMGN and Pinata image paths, rejects unsafe schemes/origins/credentials/path escapes", () => {
  for (const v of [
    null,
    undefined,
    "",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "http://gmgn.ai/external-res/a.webp",
    "https://gmgn.ai.evil.test/external-res/a.webp",
    "https://gmgn.ai/other/a.webp",
    "https://a:b@gmgn.ai/external-res/a.webp",
    "https://gmgn.ai/external-res/../private",
    "/from-mint.webp",
  ])
    assert.equal(normalizeTokenLogo(v), null);
  assert.equal(normalizeTokenLogo(LOGO), LOGO);
  assert.equal(
    normalizeTokenLogo("https://pump.mypinata.cloud/ipfs/real-content-id"),
    "https://pump.mypinata.cloud/ipfs/real-content-id",
  );
  assert(!TOKEN_IMAGE_CSP.includes("*"));
  assert(!TOKEN_IMAGE_CSP.includes("data:"));
  assert(TOKEN_IMAGE_CSP.includes("https://gmgn.ai/external-res/"));
});
test("existing candidate payload hydrates listing.logo without DB migration; new valid metadata refreshes while missing/invalid does not erase it", () => {
  const db = new Store(":memory:");
  try {
    const c = { ...candidate(), listing: { logo: LOGO } };
    db.db
      .prepare("INSERT INTO tokens(mint,payload,at) VALUES(?,?,?)")
      .run(c.mint, JSON.stringify(c), Date.now());
    assert.equal(db.token(MINT)?.logo, LOGO);
    assert.equal(db.tokens()[0]?.logo, LOGO);
    const merged = mergeDiscovery(db.token(MINT), {
      ...c,
      logo: NEW,
      listing: { logo: NEW },
    });
    assert.equal(merged.logo, NEW);
    assert.equal(
      mergeDiscovery(merged, { ...c, logo: null, listing: {} }).logo,
      NEW,
    );
    assert.equal(tokenLogo({ listing: { logo: LOGO } }), LOGO);
    db.set("nonMetadata", { balance: "42" });
    assert.deepEqual(
      db.get("nonMetadata"),
      { balance: "42" },
      "generic Store settings are untouched",
    );
  } finally {
    db.close();
  }
});
test("Positions/History display projection joins public logo without mutating accounting or source Position", () => {
  const p = position(),
    plain = positionViews([p], [])[0]!,
    rich = positionViews([p], [], () => ({
      ...candidate(),
      name: "Real name",
      logo: LOGO,
    }))[0]!;
  assert.equal(rich.logo, LOGO);
  assert.equal(rich.name, "Real name");
  assert.deepEqual(rich.accounting, plain.accounting);
  assert.equal(p.logo, undefined);
  assert.equal(p.quantity, rich.quantity);
});
test("Kronos discovery persists logo and same API projection returns it; metadata refresh does not create trials or alter decisions", async () => {
  const store = new KronosStore(":memory:");
  const c = { ...candidate(), logo: LOGO };
  const lab = new KronosLab(
    store,
    {
      discover: async () => [c],
      prepare: async () => {
        throw Error("NOT_CALLED");
      },
      history: async () => {
        throw Error("NOT_CALLED");
      },
      price: async () => {
        throw Error("NOT_CALLED");
      },
    },
    {
      forecast: async () => {
        throw Error("MODEL_MUST_NOT_PROCESS_LOGO");
      },
      stop: () => {},
      status: () => ({}),
    },
  );
  try {
    await lab.discover();
    let t = store.trials()[0]!;
    assert.equal(t.logo, LOGO);
    const raw = store.db
      .prepare("SELECT payload FROM lab_trials WHERE id=?")
      .get(t.id) as { payload: string };
    assert.equal(JSON.parse(raw.payload).logo, LOGO);
    const api = JSON.parse(JSON.stringify(lab.status()));
    assert.equal(api.records[0].logo, LOGO);
    c.logo = NEW;
    await lab.discover();
    t = store.trials()[0]!;
    assert.equal(t.logo, NEW);
    assert.equal(store.trials().length, 1);
    assert.equal(t.decisionCount, 0);
    assert.equal(t.entry, undefined);
  } finally {
    store.close();
  }
});
