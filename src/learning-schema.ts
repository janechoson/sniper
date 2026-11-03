export const learningMigration = `
CREATE TABLE IF NOT EXISTS trade_learning_samples (
 id TEXT PRIMARY KEY, trade_id TEXT UNIQUE NOT NULL, position_id TEXT UNIQUE NOT NULL,
 mint TEXT NOT NULL, mode TEXT NOT NULL, entry_at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trade_observations (
 id TEXT PRIMARY KEY, sample_id TEXT NOT NULL REFERENCES trade_learning_samples(id),
 at INTEGER NOT NULL, phase TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS observation_sample ON trade_observations(sample_id,at);
CREATE TABLE IF NOT EXISTS trade_exit_snapshots (
 execution_id TEXT PRIMARY KEY, sample_id TEXT NOT NULL REFERENCES trade_learning_samples(id), at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trade_execution_evidence (
 execution_id TEXT PRIMARY KEY, sample_id TEXT NOT NULL REFERENCES trade_learning_samples(id), at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trade_execution_preflights (
 execution_id TEXT PRIMARY KEY, sample_id TEXT NOT NULL REFERENCES trade_learning_samples(id), at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trade_execution_failures (
 id TEXT PRIMARY KEY, sample_id TEXT, at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trade_outcomes (
 sample_id TEXT PRIMARY KEY REFERENCES trade_learning_samples(id), mode TEXT NOT NULL, available_at INTEGER NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS outcome_time ON trade_outcomes(mode,available_at);
CREATE TABLE IF NOT EXISTS learning_patterns (
 id TEXT PRIMARY KEY, mode TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS learning_versions (
 id INTEGER PRIMARY KEY, version INTEGER NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL);
${[
  "trade_learning_samples",
  "trade_observations",
  "trade_exit_snapshots",
  "trade_execution_evidence",
  "trade_execution_preflights",
  "trade_execution_failures",
]
  .map(
    (table) => `
CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable learning evidence'); END;
CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable learning evidence'); END;`,
  )
  .join("\n")}
INSERT OR IGNORE INTO migrations VALUES(4,unixepoch());
`;
