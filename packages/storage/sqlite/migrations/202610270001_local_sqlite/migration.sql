-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "chainId" TEXT,
    "tokenAddress" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "rug_check_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "poolAddress" TEXT,
    "snapshotHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "decision" TEXT,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "security_evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "holder_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "holder_clusters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "creator_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "liquidity_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sellability_checks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "round_trip_checks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "external_security_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "jev_risk_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "risk_decisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "risk_reason_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TradeIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "transactionId" TEXT,
    "payload" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ApprovalTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "transactionId" TEXT,
    "payload" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CreatorProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "creatorAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CreatorTokenRelationship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "creatorAddress" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProviderHealth" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT,
    "providerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "checkedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "KillSwitchEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DiscoveryCursor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PipelineObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "providerId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Chain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Dex" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Pool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TokenObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FeatureSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SecurityAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AIClassification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "StrategyDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RiskDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TradeQuote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PaperOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PositionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "StrategyRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TokenOutcome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_id_key" ON "JournalEntry"("id");

-- CreateIndex
CREATE INDEX "JournalEntry_kind_createdAt_idx" ON "JournalEntry"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "JournalEntry_chainId_tokenAddress_createdAt_idx" ON "JournalEntry"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "rug_check_snapshots_namespace_chainId_tokenAddress_observedAt_idx" ON "rug_check_snapshots"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "rug_check_snapshots_namespace_snapshotHash_idx" ON "rug_check_snapshots"("namespace", "snapshotHash");

-- CreateIndex
CREATE INDEX "security_evidence_namespace_snapshotId_field_idx" ON "security_evidence"("namespace", "snapshotId", "field");

-- CreateIndex
CREATE INDEX "security_evidence_namespace_provider_state_observedAt_idx" ON "security_evidence"("namespace", "provider", "state", "observedAt");

-- CreateIndex
CREATE INDEX "holder_snapshots_namespace_chainId_tokenAddress_observedAt_idx" ON "holder_snapshots"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "holder_clusters_namespace_chainId_tokenAddress_observedAt_idx" ON "holder_clusters"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "creator_history_namespace_chainId_tokenAddress_observedAt_idx" ON "creator_history"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "liquidity_snapshots_namespace_chainId_tokenAddress_observedAt_idx" ON "liquidity_snapshots"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "sellability_checks_namespace_chainId_tokenAddress_observedAt_idx" ON "sellability_checks"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "round_trip_checks_namespace_chainId_tokenAddress_observedAt_idx" ON "round_trip_checks"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "external_security_results_namespace_chainId_tokenAddress_observedAt_idx" ON "external_security_results"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "external_security_results_namespace_provider_status_observedAt_idx" ON "external_security_results"("namespace", "provider", "status", "observedAt");

-- CreateIndex
CREATE INDEX "jev_risk_results_namespace_chainId_tokenAddress_observedAt_idx" ON "jev_risk_results"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "jev_risk_results_namespace_snapshotHash_idx" ON "jev_risk_results"("namespace", "snapshotHash");

-- CreateIndex
CREATE INDEX "risk_decisions_namespace_chainId_tokenAddress_observedAt_idx" ON "risk_decisions"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "risk_reason_codes_namespace_code_observedAt_idx" ON "risk_reason_codes"("namespace", "code", "observedAt");

-- CreateIndex
CREATE INDEX "TradeIntent_namespace_chainId_walletId_createdAt_idx" ON "TradeIntent"("namespace", "chainId", "walletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradeIntent_namespace_idempotencyKey_key" ON "TradeIntent"("namespace", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Execution_namespace_chainId_walletId_state_updatedAt_idx" ON "Execution"("namespace", "chainId", "walletId", "state", "updatedAt");

-- CreateIndex
CREATE INDEX "Execution_transactionId_idx" ON "Execution"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_namespace_idempotencyKey_key" ON "Execution"("namespace", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ApprovalTransaction_namespace_walletId_chainId_updatedAt_idx" ON "ApprovalTransaction"("namespace", "walletId", "chainId", "updatedAt");

-- CreateIndex
CREATE INDEX "ApprovalTransaction_transactionId_idx" ON "ApprovalTransaction"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorProfile_namespace_chainId_creatorAddress_key" ON "CreatorProfile"("namespace", "chainId", "creatorAddress");

-- CreateIndex
CREATE INDEX "CreatorTokenRelationship_namespace_chainId_creatorAddress_observedAt_idx" ON "CreatorTokenRelationship"("namespace", "chainId", "creatorAddress", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorTokenRelationship_namespace_chainId_tokenAddress_evidence_key" ON "CreatorTokenRelationship"("namespace", "chainId", "tokenAddress", "evidence");

-- CreateIndex
CREATE INDEX "ProviderHealth_namespace_chainId_providerId_checkedAt_idx" ON "ProviderHealth"("namespace", "chainId", "providerId", "checkedAt");

-- CreateIndex
CREATE INDEX "KillSwitchEvent_namespace_scope_createdAt_idx" ON "KillSwitchEvent"("namespace", "scope", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryCursor_namespace_key_key" ON "DiscoveryCursor"("namespace", "key");

-- CreateIndex
CREATE INDEX "PipelineObservation_namespace_chainId_tokenAddress_observedAt_idx" ON "PipelineObservation"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "PipelineObservation_namespace_providerId_kind_observedAt_idx" ON "PipelineObservation"("namespace", "providerId", "kind", "observedAt");

-- CreateIndex
CREATE INDEX "Chain_chainId_tokenAddress_createdAt_idx" ON "Chain"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Chain_chainId_poolAddress_idx" ON "Chain"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "Chain_dexId_createdAt_idx" ON "Chain"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "Chain_strategyId_createdAt_idx" ON "Chain"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "Dex_chainId_tokenAddress_createdAt_idx" ON "Dex"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Dex_chainId_poolAddress_idx" ON "Dex"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "Dex_dexId_createdAt_idx" ON "Dex"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "Dex_strategyId_createdAt_idx" ON "Dex"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "Token_chainId_tokenAddress_createdAt_idx" ON "Token"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Token_chainId_poolAddress_idx" ON "Token"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "Token_dexId_createdAt_idx" ON "Token"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "Token_strategyId_createdAt_idx" ON "Token"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "Pool_chainId_tokenAddress_createdAt_idx" ON "Pool"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Pool_chainId_poolAddress_idx" ON "Pool"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "Pool_dexId_createdAt_idx" ON "Pool"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "Pool_strategyId_createdAt_idx" ON "Pool"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "TokenObservation_chainId_tokenAddress_createdAt_idx" ON "TokenObservation"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "TokenObservation_chainId_poolAddress_idx" ON "TokenObservation"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "TokenObservation_dexId_createdAt_idx" ON "TokenObservation"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "TokenObservation_strategyId_createdAt_idx" ON "TokenObservation"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "FeatureSnapshot_chainId_tokenAddress_createdAt_idx" ON "FeatureSnapshot"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "FeatureSnapshot_chainId_poolAddress_idx" ON "FeatureSnapshot"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "FeatureSnapshot_dexId_createdAt_idx" ON "FeatureSnapshot"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "FeatureSnapshot_strategyId_createdAt_idx" ON "FeatureSnapshot"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAnalysis_chainId_tokenAddress_createdAt_idx" ON "SecurityAnalysis"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAnalysis_chainId_poolAddress_idx" ON "SecurityAnalysis"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "SecurityAnalysis_dexId_createdAt_idx" ON "SecurityAnalysis"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAnalysis_strategyId_createdAt_idx" ON "SecurityAnalysis"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "AIClassification_chainId_tokenAddress_createdAt_idx" ON "AIClassification"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "AIClassification_chainId_poolAddress_idx" ON "AIClassification"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "AIClassification_dexId_createdAt_idx" ON "AIClassification"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "AIClassification_strategyId_createdAt_idx" ON "AIClassification"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "StrategyDecision_chainId_tokenAddress_createdAt_idx" ON "StrategyDecision"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "StrategyDecision_chainId_poolAddress_idx" ON "StrategyDecision"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "StrategyDecision_dexId_createdAt_idx" ON "StrategyDecision"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "StrategyDecision_strategyId_createdAt_idx" ON "StrategyDecision"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskDecision_chainId_tokenAddress_createdAt_idx" ON "RiskDecision"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "RiskDecision_chainId_poolAddress_idx" ON "RiskDecision"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "RiskDecision_dexId_createdAt_idx" ON "RiskDecision"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskDecision_strategyId_createdAt_idx" ON "RiskDecision"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "TradeQuote_chainId_tokenAddress_createdAt_idx" ON "TradeQuote"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "TradeQuote_chainId_poolAddress_idx" ON "TradeQuote"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "TradeQuote_dexId_createdAt_idx" ON "TradeQuote"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "TradeQuote_strategyId_createdAt_idx" ON "TradeQuote"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperOrder_chainId_tokenAddress_createdAt_idx" ON "PaperOrder"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "PaperOrder_chainId_poolAddress_idx" ON "PaperOrder"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "PaperOrder_dexId_createdAt_idx" ON "PaperOrder"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperOrder_strategyId_createdAt_idx" ON "PaperOrder"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_chainId_tokenAddress_createdAt_idx" ON "Order"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Order_chainId_poolAddress_idx" ON "Order"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "Order_dexId_createdAt_idx" ON "Order"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_strategyId_createdAt_idx" ON "Order"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_chainId_tokenAddress_createdAt_idx" ON "Transaction"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_chainId_poolAddress_idx" ON "Transaction"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "Transaction_dexId_createdAt_idx" ON "Transaction"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_strategyId_createdAt_idx" ON "Transaction"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "Position_chainId_tokenAddress_createdAt_idx" ON "Position"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Position_chainId_poolAddress_idx" ON "Position"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "Position_dexId_createdAt_idx" ON "Position"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "Position_strategyId_createdAt_idx" ON "Position"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "PositionEvent_chainId_tokenAddress_createdAt_idx" ON "PositionEvent"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "PositionEvent_chainId_poolAddress_idx" ON "PositionEvent"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "PositionEvent_dexId_createdAt_idx" ON "PositionEvent"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "PositionEvent_strategyId_createdAt_idx" ON "PositionEvent"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketSnapshot_chainId_tokenAddress_createdAt_idx" ON "MarketSnapshot"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "MarketSnapshot_chainId_poolAddress_idx" ON "MarketSnapshot"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "MarketSnapshot_dexId_createdAt_idx" ON "MarketSnapshot"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketSnapshot_strategyId_createdAt_idx" ON "MarketSnapshot"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "StrategyRun_chainId_tokenAddress_createdAt_idx" ON "StrategyRun"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "StrategyRun_chainId_poolAddress_idx" ON "StrategyRun"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "StrategyRun_dexId_createdAt_idx" ON "StrategyRun"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "StrategyRun_strategyId_createdAt_idx" ON "StrategyRun"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "TokenOutcome_chainId_tokenAddress_createdAt_idx" ON "TokenOutcome"("chainId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "TokenOutcome_chainId_poolAddress_idx" ON "TokenOutcome"("chainId", "poolAddress");

-- CreateIndex
CREATE INDEX "TokenOutcome_dexId_createdAt_idx" ON "TokenOutcome"("dexId", "createdAt");

-- CreateIndex
CREATE INDEX "TokenOutcome_strategyId_createdAt_idx" ON "TokenOutcome"("strategyId", "createdAt");
