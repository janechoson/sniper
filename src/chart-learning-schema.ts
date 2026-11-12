/** Additive, transactional migration; does not alter existing learning evidence. */
export const chartLearningMigration = `
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS chart_candles (
 id TEXT PRIMARY KEY, mint TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL,
 available_at INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(mint,source,at));
CREATE INDEX IF NOT EXISTS chart_candles_time ON chart_candles(mint,at);
CREATE TABLE IF NOT EXISTS chart_events (
 id TEXT PRIMARY KEY, mint TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
 available_at INTEGER NOT NULL, candle_id TEXT NOT NULL REFERENCES chart_candles(id), payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chart_events_time ON chart_events(mint,at);
CREATE TABLE IF NOT EXISTS chart_snapshots (
 id TEXT PRIMARY KEY, mint TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chart_decisions (
 id TEXT PRIMARY KEY, mode TEXT NOT NULL, account_id TEXT NOT NULL, mint TEXT NOT NULL,
 position_id TEXT, at INTEGER NOT NULL, action TEXT NOT NULL,
 snapshot_id TEXT NOT NULL REFERENCES chart_snapshots(id), payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chart_decisions_scope ON chart_decisions(mode,account_id,at);
CREATE TABLE IF NOT EXISTS chart_rule_versions (
 id TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL,
 payload TEXT NOT NULL, PRIMARY KEY(id,version));
CREATE TABLE IF NOT EXISTS chart_rule_evidence (
 rule_id TEXT NOT NULL, version INTEGER NOT NULL, event_id TEXT NOT NULL REFERENCES chart_events(id),
 stance TEXT NOT NULL CHECK(stance IN ('SUPPORT','CONTRADICT')),
 PRIMARY KEY(rule_id,version,event_id),
 FOREIGN KEY(rule_id,version) REFERENCES chart_rule_versions(id,version));
CREATE TABLE IF NOT EXISTS chart_observation_queue (
 mode TEXT NOT NULL, account_id TEXT NOT NULL, mint TEXT NOT NULL,
 priority INTEGER NOT NULL, due INTEGER NOT NULL, until_at INTEGER NOT NULL,
 reason TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(mode,account_id,mint));
CREATE TABLE IF NOT EXISTS chart_followups (
 decision_id TEXT NOT NULL REFERENCES chart_decisions(id), horizon INTEGER NOT NULL,
 at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(decision_id,horizon));
CREATE TABLE IF NOT EXISTS chart_event_outcomes (
 event_id TEXT NOT NULL REFERENCES chart_events(id), horizon INTEGER NOT NULL,
 at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(event_id,horizon));
CREATE TABLE IF NOT EXISTS chart_replays (
 position_id TEXT PRIMARY KEY, mode TEXT NOT NULL, account_id TEXT NOT NULL,
 at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chart_jobs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL, account_id TEXT NOT NULL,
 at INTEGER NOT NULL, due INTEGER NOT NULL, state TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, result TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS chart_jobs_due ON chart_jobs(state,due);
CREATE TABLE IF NOT EXISTS chart_validations (
 id TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chart_learning_cases (
 position_id TEXT PRIMARY KEY, mint TEXT NOT NULL, mode TEXT NOT NULL,
 account_id TEXT NOT NULL, buy_confirmed_at INTEGER NOT NULL,
 learning_started_at INTEGER NOT NULL, entry_price_usd REAL, entry_quantity TEXT,
 status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED')),
 entry_snapshot_id TEXT, exit_snapshot_id TEXT, realized_pnl_lamports TEXT,
 realized_pnl_pct REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chart_learning_cases_mode_status ON chart_learning_cases(mode,status,learning_started_at);
CREATE INDEX IF NOT EXISTS chart_learning_cases_mint ON chart_learning_cases(mint,learning_started_at);
CREATE TABLE IF NOT EXISTS chart_case_evidence (
 case_id TEXT NOT NULL REFERENCES chart_learning_cases(position_id),
 evidence_id TEXT NOT NULL, evidence_type TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('PRE_BUY_CONTEXT','POST_BUY_OBSERVATION','EXECUTION','OUTCOME')),
 available_at INTEGER NOT NULL,
 PRIMARY KEY(case_id,evidence_id,evidence_type));
CREATE INDEX IF NOT EXISTS chart_case_evidence_evidence ON chart_case_evidence(evidence_id,evidence_type,available_at);
CREATE TABLE IF NOT EXISTS chart_case_collection (
 case_id TEXT PRIMARY KEY REFERENCES chart_learning_cases(position_id),
 status TEXT NOT NULL CHECK(status IN ('COLLECTING','POSITION_CLOSED','POST_SELL_COLLECTING','READY_FOR_ANALYSIS','INCOMPLETE')),
 last_collected_at INTEGER, last_candle_at INTEGER, data_quality TEXT NOT NULL DEFAULT 'UNKNOWN',
 updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chart_case_followups (
 case_id TEXT NOT NULL REFERENCES chart_learning_cases(position_id),
 horizon INTEGER NOT NULL CHECK(horizon IN (5,15,30,60)), due_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','COLLECTED','FAILED','EXPIRED')),
 attempts INTEGER NOT NULL DEFAULT 0, collected_at INTEGER, payload TEXT, error TEXT,
 PRIMARY KEY(case_id,horizon));
CREATE INDEX IF NOT EXISTS chart_case_followups_due ON chart_case_followups(state,due_at);
CREATE TABLE IF NOT EXISTS chart_analysis_jobs (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES chart_learning_cases(position_id),
 requested_by TEXT NOT NULL, requested_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
 started_at INTEGER, completed_at INTEGER, analysis_version TEXT NOT NULL,
 runtime_model TEXT, error TEXT, retry_count INTEGER NOT NULL DEFAULT 0, result TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS chart_analysis_jobs_one_active_case ON chart_analysis_jobs(case_id) WHERE state IN ('PENDING','RUNNING');
CREATE INDEX IF NOT EXISTS chart_analysis_jobs_state ON chart_analysis_jobs(state,requested_at);
CREATE TABLE IF NOT EXISTS chart_case_analyses (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES chart_learning_cases(position_id),
 job_id TEXT NOT NULL UNIQUE REFERENCES chart_analysis_jobs(id), analyzed_at INTEGER NOT NULL,
 analysis_version TEXT NOT NULL, runtime_model TEXT, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chart_case_decisions (
 position_id TEXT NOT NULL REFERENCES chart_learning_cases(position_id),
 decision_id TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL,
 action TEXT NOT NULL, simulated INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(position_id,decision_id));
CREATE INDEX IF NOT EXISTS chart_case_decisions_time ON chart_case_decisions(position_id,at);
CREATE TABLE IF NOT EXISTS chart_knowledge_versions (
 id TEXT NOT NULL, version INTEGER NOT NULL, category TEXT NOT NULL,
 applicable_stage TEXT NOT NULL CHECK(applicable_stage IN ('PRE_BUY','POST_BUY')),
 status TEXT NOT NULL CHECK(status IN ('DRAFT','VALIDATED','REJECTED')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(id,version));
CREATE INDEX IF NOT EXISTS chart_knowledge_stage_status ON chart_knowledge_versions(applicable_stage,status,updated_at);
CREATE TABLE IF NOT EXISTS chart_knowledge_validations (
 id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL, knowledge_version INTEGER NOT NULL,
 at INTEGER NOT NULL, training_case_ids TEXT NOT NULL, validation_case_ids TEXT NOT NULL,
 metrics TEXT NOT NULL, payload TEXT NOT NULL,
 FOREIGN KEY(knowledge_id,knowledge_version) REFERENCES chart_knowledge_versions(id,version));
CREATE TABLE IF NOT EXISTS chart_ai_guard_decisions (
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, mint TEXT NOT NULL, mode TEXT NOT NULL,
 at INTEGER NOT NULL, action TEXT NOT NULL, duration_ms INTEGER NOT NULL,
 queue_wait_ms INTEGER NOT NULL, runtime_outcome TEXT NOT NULL,
 model TEXT, prompt_version TEXT NOT NULL, knowledge_revision INTEGER NOT NULL,
 input_hash TEXT NOT NULL, output_hash TEXT, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chart_ai_guard_decisions_recent ON chart_ai_guard_decisions(at DESC);
CREATE TABLE IF NOT EXISTS chart_auto_learning_jobs (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES chart_learning_cases(position_id),
 analysis_version TEXT NOT NULL, requested_at INTEGER NOT NULL, eligible_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','RETRY_WAIT','COMPLETED','DEAD_LETTER','CANCELLED')),
 attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, started_at INTEGER,
 completed_at INTEGER, analysis_job_id TEXT, last_error TEXT,
 UNIQUE(case_id,analysis_version));
CREATE INDEX IF NOT EXISTS chart_auto_learning_due ON chart_auto_learning_jobs(state,next_attempt_at,eligible_at);
CREATE TABLE IF NOT EXISTS chart_validation_jobs (
 id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL, knowledge_version INTEGER NOT NULL,
 draft_payload TEXT NOT NULL, dataset_case_ids TEXT NOT NULL, dataset_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','COMPLETED','FAILED','DEAD_LETTER')),
 requested_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
 attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
 human_approved INTEGER NOT NULL DEFAULT 0, error TEXT, report TEXT,
 UNIQUE(knowledge_id,knowledge_version,dataset_hash));
CREATE INDEX IF NOT EXISTS chart_validation_jobs_due ON chart_validation_jobs(state,next_attempt_at);
CREATE TABLE IF NOT EXISTS chart_knowledge_control_events (
 id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL, knowledge_version INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('DISABLE','REJECT','DELETE','RESTORE','SUSPEND')),
 actor TEXT NOT NULL CHECK(actor IN ('USER','SYSTEM')), reason TEXT NOT NULL,
 fingerprint TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chart_knowledge_control_lookup ON chart_knowledge_control_events(knowledge_id,at DESC);
CREATE INDEX IF NOT EXISTS chart_knowledge_suppression_lookup ON chart_knowledge_control_events(fingerprint,at DESC);
CREATE TABLE IF NOT EXISTS chart_knowledge_drift_cases (
 knowledge_id TEXT NOT NULL, knowledge_version INTEGER NOT NULL, case_id TEXT NOT NULL,
 decision_id TEXT NOT NULL, dangerous INTEGER NOT NULL CHECK(dangerous IN (0,1)),
 observed_at INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(knowledge_id,knowledge_version,case_id));
CREATE INDEX IF NOT EXISTS chart_knowledge_drift_recent ON chart_knowledge_drift_cases(knowledge_id,knowledge_version,observed_at DESC);
${[
  "chart_candles",
  "chart_events",
  "chart_snapshots",
  "chart_decisions",
  "chart_rule_versions",
  "chart_rule_evidence",
  "chart_followups",
  "chart_event_outcomes",
  "chart_replays",
  "chart_validations",
  "chart_knowledge_versions",
  "chart_knowledge_validations",
  "chart_ai_guard_decisions",
  "chart_knowledge_control_events",
  "chart_knowledge_drift_cases",
]
  .map(
    (t) => `
CREATE TRIGGER IF NOT EXISTS ${t}_immutable BEFORE UPDATE ON ${t}
BEGIN SELECT RAISE(ABORT,'Immutable chart evidence'); END;`,
  )
  .join("")}
${[
  "chart_decisions",
  "chart_rule_versions",
  "chart_rule_evidence",
  "chart_replays",
  "chart_followups",
  "chart_validations",
  "chart_knowledge_versions",
  "chart_knowledge_validations",
  "chart_ai_guard_decisions",
  "chart_knowledge_control_events",
  "chart_knowledge_drift_cases",
]
  .map(
    (t) => `
CREATE TRIGGER IF NOT EXISTS ${t}_immutable_delete BEFORE DELETE ON ${t}
BEGIN SELECT RAISE(ABORT,'Immutable chart history'); END;`,
  )
  .join("")}
INSERT OR IGNORE INTO migrations VALUES(17,unixepoch());
INSERT OR IGNORE INTO migrations VALUES(19,unixepoch());
INSERT OR IGNORE INTO migrations VALUES(20,unixepoch());
INSERT OR IGNORE INTO migrations VALUES(21,unixepoch());
INSERT OR IGNORE INTO migrations VALUES(22,unixepoch());
INSERT OR IGNORE INTO migrations VALUES(23,unixepoch());
COMMIT;
`;
