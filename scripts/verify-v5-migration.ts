import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { env } from "../src/config.js";
import { Store } from "../src/store.js";
import { hash } from "../src/util.js";
// Offline, source read-only. Operator must keep the real bot stopped.
const root = `data/backups/v5-copy-${Date.now()}`;
mkdirSync(root, { recursive: true });
const paths = [
  env.DATABASE_PATH,
  env.DATABASE_PATH + "-wal",
  env.DATABASE_PATH + "-shm",
].filter(existsSync);
const sourceHash = () =>
  hash(
    paths.map((path) => ({
      path,
      digest: hash(readFileSync(path).toString("base64")),
    })),
  );
const beforeFileHash = sourceHash(),
  copy = join(root, "bot.sqlite");
for (const path of paths)
  copyFileSync(path, copy + path.slice(env.DATABASE_PATH.length));
const tables = [
  "positions",
  "executions",
  "intents",
  "execution_fills",
  "trade_learning_samples",
  "records",
];
const measure = (s: Store) =>
  Object.fromEntries(
    tables.map((t) => [
      t,
      {
        count: s.db.prepare(`SELECT count(*) n FROM ${t}`).get()!.n,
        digest: hash(s.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),
      },
    ]),
  );
let db = new Store(copy, { readOnly: true });
const before = measure(db);
db.close();
db = new Store(copy);
const after = measure(db),
  versions = db.db
    .prepare("SELECT version FROM migrations ORDER BY version")
    .all();
db.close();
const result = {
  at: new Date().toISOString(),
  basis: "offline migration on copy; original DB never opened writable",
  copy: root,
  accountingAndHistoryUnchanged: hash(before) === hash(after),
  originalFilesUnchanged: beforeFileHash === sourceHash(),
  tables: before,
  versions,
  signatures: 0,
  submissions: 0,
};
if (!result.accountingAndHistoryUnchanged || !result.originalFilesUnchanged)
  throw Error("MIGRATION_CHANGED_EXISTING_EVIDENCE");
writeFileSync(
  "data/v5-migration-verification.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
