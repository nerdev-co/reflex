-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('POLL', 'WEBHOOK', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "TriggerStateKind" AS ENUM ('CURSOR', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "StepRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "triggerKey" TEXT NOT NULL,
    "triggerConfig" JSONB NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "webhookPath" TEXT,
    "webhookSecret" TEXT,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workflowId" TEXT NOT NULL,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Step" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "actionKey" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "workflowId" TEXT NOT NULL,

    CONSTRAINT "Step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailableTrigger" (
    "key" TEXT NOT NULL,
    "noun" TEXT NOT NULL,
    "type" "TriggerType" NOT NULL,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "AvailableTrigger_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AvailableAction" (
    "key" TEXT NOT NULL,
    "noun" TEXT NOT NULL,
    "idempotentSafe" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "AvailableAction_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TriggerState" (
    "id" TEXT NOT NULL,
    "kind" "TriggerStateKind" NOT NULL,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workflowId" TEXT NOT NULL,

    CONSTRAINT "TriggerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZapRun" (
    "id" TEXT NOT NULL,
    "triggerKey" TEXT NOT NULL,
    "triggerPayload" JSONB NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "workflowId" TEXT,
    "workflowVersion" INTEGER,
    "replayOfRunId" TEXT,

    CONSTRAINT "ZapRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepRun" (
    "id" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "status" "StepRunStatus" NOT NULL DEFAULT 'QUEUED',
    "config" JSONB NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "output" JSONB,
    "workerId" TEXT,
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "runId" TEXT NOT NULL,
    "stepId" TEXT,
    "inheritedFromStepRunId" TEXT,

    CONSTRAINT "StepRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepRunAttempt" (
    "id" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" JSONB,
    "httpTrace" JSONB,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stepRunId" TEXT NOT NULL,

    CONSTRAINT "StepRunAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT NOT NULL,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_webhookPath_key" ON "Workflow"("webhookPath");

-- CreateIndex
CREATE INDEX "Workflow_userId_idx" ON "Workflow"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_version_key" ON "WorkflowVersion"("workflowId", "version");

-- CreateIndex
CREATE INDEX "Step_workflowId_idx" ON "Step"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "Step_workflowId_position_key" ON "Step"("workflowId", "position");

-- CreateIndex
CREATE INDEX "TriggerState_workflowId_idx" ON "TriggerState"("workflowId");

-- CreateIndex
CREATE INDEX "Credential_userId_idx" ON "Credential"("userId");

-- CreateIndex
CREATE INDEX "ZapRun_workflowId_idx" ON "ZapRun"("workflowId");

-- CreateIndex
CREATE INDEX "ZapRun_status_idx" ON "ZapRun"("status");

-- CreateIndex
CREATE INDEX "StepRun_runId_idx" ON "StepRun"("runId");

-- CreateIndex
CREATE INDEX "StepRun_status_nextAttemptAt_idx" ON "StepRun"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "StepRun_status_claimedAt_idx" ON "StepRun"("status", "claimedAt");

-- CreateIndex
CREATE INDEX "StepRunAttempt_stepRunId_idx" ON "StepRunAttempt"("stepRunId");

-- CreateIndex
CREATE UNIQUE INDEX "StepRunAttempt_stepRunId_attemptNo_key" ON "StepRunAttempt"("stepRunId", "attemptNo");

-- CreateIndex
CREATE INDEX "RunEvent_runId_at_idx" ON "RunEvent"("runId", "at");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Step" ADD CONSTRAINT "Step_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerState" ADD CONSTRAINT "TriggerState_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZapRun" ADD CONSTRAINT "ZapRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZapRun" ADD CONSTRAINT "ZapRun_replayOfRunId_fkey" FOREIGN KEY ("replayOfRunId") REFERENCES "ZapRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepRun" ADD CONSTRAINT "StepRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ZapRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepRun" ADD CONSTRAINT "StepRun_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepRun" ADD CONSTRAINT "StepRun_inheritedFromStepRunId_fkey" FOREIGN KEY ("inheritedFromStepRunId") REFERENCES "StepRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepRunAttempt" ADD CONSTRAINT "StepRunAttempt_stepRunId_fkey" FOREIGN KEY ("stepRunId") REFERENCES "StepRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ZapRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
