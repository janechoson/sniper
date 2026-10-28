-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "chainId" TEXT,
    "tokenAddress" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineLease" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngineLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chain" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dex" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pool" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenObservation" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureSnapshot" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityAnalysis" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIClassification" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIClassification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyDecision" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskDecision" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeQuote" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperOrder" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionEvent" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyRun" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenOutcome" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "poolAddress" TEXT,
    "dexId" TEXT,
    "strategyId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_sequence_key" ON "JournalEntry"("sequence");

-- CreateIndex
CREATE INDEX "JournalEntry_kind_createdAt_idx" ON "JournalEntry"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "JournalEntry_chainId_tokenAddress_createdAt_idx" ON "JournalEntry"("chainId", "tokenAddress", "createdAt");

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
