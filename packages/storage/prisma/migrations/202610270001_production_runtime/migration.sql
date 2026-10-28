-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "signerType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "chains" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletChainState" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletChainState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeIntent" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "transactionId" TEXT,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalTransaction" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "transactionId" TEXT,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorProfile" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "creatorAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorTokenRelationship" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "creatorAddress" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorTokenRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderHealth" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT,
    "providerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KillSwitchEvent" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KillSwitchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryCursor" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineObservation" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "providerId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Wallet_address_idx" ON "Wallet"("address");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_namespace_walletId_key" ON "Wallet"("namespace", "walletId");

-- CreateIndex
CREATE INDEX "WalletChainState_namespace_walletId_chainId_observedAt_idx" ON "WalletChainState"("namespace", "walletId", "chainId", "observedAt");

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
CREATE INDEX "CreatorTokenRelationship_namespace_chainId_creatorAddress_o_idx" ON "CreatorTokenRelationship"("namespace", "chainId", "creatorAddress", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorTokenRelationship_namespace_chainId_tokenAddress_evi_key" ON "CreatorTokenRelationship"("namespace", "chainId", "tokenAddress", "evidence");

-- CreateIndex
CREATE INDEX "ProviderHealth_namespace_chainId_providerId_checkedAt_idx" ON "ProviderHealth"("namespace", "chainId", "providerId", "checkedAt");

-- CreateIndex
CREATE INDEX "KillSwitchEvent_namespace_scope_createdAt_idx" ON "KillSwitchEvent"("namespace", "scope", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryCursor_namespace_key_key" ON "DiscoveryCursor"("namespace", "key");

-- CreateIndex
CREATE INDEX "PipelineObservation_namespace_chainId_tokenAddress_observed_idx" ON "PipelineObservation"("namespace", "chainId", "tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "PipelineObservation_namespace_providerId_kind_observedAt_idx" ON "PipelineObservation"("namespace", "providerId", "kind", "observedAt");
