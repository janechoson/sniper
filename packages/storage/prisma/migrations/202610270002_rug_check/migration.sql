-- CreateTable
CREATE TABLE "rug_check_snapshots" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "poolAddress" TEXT,
    "snapshotHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "decision" TEXT,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rug_check_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_evidence" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holder_snapshots" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holder_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holder_clusters" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holder_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_history" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidity_snapshots" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "liquidity_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sellability_checks" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sellability_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_trip_checks" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "round_trip_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_security_results" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_security_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jev_risk_results" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jev_risk_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_decisions" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risk_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_reason_codes" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risk_reason_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rug_check_snapshots_namespace_chainId_tokenAddress_observed_idx" ON "rug_check_snapshots"("namespace", "chainId", "tokenAddress", "observedAt");

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
CREATE INDEX "liquidity_snapshots_namespace_chainId_tokenAddress_observed_idx" ON "liquidity_snapshots"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "sellability_checks_namespace_chainId_tokenAddress_observedA_idx" ON "sellability_checks"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "round_trip_checks_namespace_chainId_tokenAddress_observedAt_idx" ON "round_trip_checks"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "external_security_results_namespace_chainId_tokenAddress_ob_idx" ON "external_security_results"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "external_security_results_namespace_provider_status_observe_idx" ON "external_security_results"("namespace", "provider", "status", "observedAt");

-- CreateIndex
CREATE INDEX "jev_risk_results_namespace_chainId_tokenAddress_observedAt_idx" ON "jev_risk_results"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "jev_risk_results_namespace_snapshotHash_idx" ON "jev_risk_results"("namespace", "snapshotHash");

-- CreateIndex
CREATE INDEX "risk_decisions_namespace_chainId_tokenAddress_observedAt_idx" ON "risk_decisions"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "risk_reason_codes_namespace_code_observedAt_idx" ON "risk_reason_codes"("namespace", "code", "observedAt");
