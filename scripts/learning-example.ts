import { Store } from "../src/store.js";
import { featureVector } from "../src/learning.js";
import { TradingMemory } from "../src/trading-memory.js";
import {
  completedFixture,
  typedJevFixture,
} from "../tests/learning-fixtures.js";
import { snapshot, settings } from "../tests/fixtures.js";
import { Jev } from "../src/jev.js";
import { RiskEngine } from "../src/risk.js";
import { env } from "../src/config.js";
import { json } from "../src/util.js";
const store = new Store(":memory:"),
  memory = new TradingMemory(store),
  oldKey = env.TYPESAFE_API_KEY;
try {
  const base = Date.now() - 3600000;
  for (let i = 0; i < 30; i++)
    completedFixture(memory, {
      base,
      netPercent: i < 18 ? 20 : -10,
      observations: i < 18 ? [5, 35] : [2, -15],
    });
  const current = snapshot(),
    history = memory.retrieve(current, "paper");
  const input = memory.jevContext(
    {
      market: current.market,
      security: current.security,
      holders: current.intelligence.holders,
      creator: { holdPercent: current.intelligence.creator.holdPercent },
      tokenAgeSeconds: 60,
    },
    history,
  );
  const jev = new Jev();
  env.TYPESAFE_API_KEY = "isolated-test-fixture";
  jev.http.request = async () => typedJevFixture();
  current.jev = await jev.decide(input);
  const risk = new RiskEngine().evaluate(current, settings, {
    balance: 1000000000n,
    pending: 0n,
    positions: 0,
    duplicate: false,
    entriesEnabled: true,
  });
  process.stdout.write(
    json({
      label:
        "TEST FIXTURES ONLY — in-memory SQLite, no real history, no network, no orders",
      currentCandidate: {
        mint: current.candidate.mint,
        features: featureVector(current),
      },
      similarHistoricalTrades: {
        count: history.similarTrades,
        wins: history.wins,
        losses: history.losses,
      },
      aggregatedExperience: history,
      jevInput: input,
      jevOutput: current.jev,
      riskEngineFinalDecision: risk,
      productionDatabaseTouched: false,
    }) + "\n",
  );
} finally {
  env.TYPESAFE_API_KEY = oldKey;
  store.close();
}
