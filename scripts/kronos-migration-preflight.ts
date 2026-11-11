import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { kronosMigrationPreflight } from "../src/kronos-migration-preflight.js";

const args = process.argv.slice(2);
if (args.length !== 1)
  throw new Error(
    "Usage: tsx scripts/kronos-migration-preflight.ts <database-path>",
  );
const db = new DatabaseSync(resolve(args[0]!), { readOnly: true });
try {
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;");
  const result = kronosMigrationPreflight(db);
  db.exec("COMMIT");
  console.log(
    result.eligible
      ? "Persisted position/recovery checks: PASS"
      : "Persisted position/recovery checks: BLOCKED",
  );
  for (const b of result.blockers)
    console.log(`${b.code} ${b.id ?? ""}: ${b.reason}`);
  console.log(
    "Read-only checkpoint only. Deployment also requires approved source baseline and fresh revalidation on the authoritative DB.",
  );
  if (!result.eligible) process.exitCode = 1;
} finally {
  db.close();
}
