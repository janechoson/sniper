import { env } from "../src/config.js";
import { databaseDirectory } from "../src/database-session.js";
import { migrateDatabases } from "../src/database-migration.js";
console.log(
  JSON.stringify(
    await migrateDatabases(env.DATABASE_PATH, databaseDirectory()),
    null,
    2,
  ),
);
