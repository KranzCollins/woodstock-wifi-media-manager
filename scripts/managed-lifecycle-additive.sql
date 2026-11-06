-- CreateTable
CREATE TABLE "ManagedLifecycleOrganization" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedLifecycleOrganization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedPostLifecycle" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "managedPostId" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduleGeneration" INTEGER NOT NULL DEFAULT 0,
    "activeScheduleId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastLifecycleSequence" INTEGER NOT NULL DEFAULT 0,
    "lastOperationKey" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedOperationKey" TEXT,
    "deletedSequence" INTEGER,
    "deletedFromLifecycle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedPostLifecycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedLifecycleOperation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "managedPostId" TEXT NOT NULL,
    "dispatchId" TEXT,
    "scheduleId" TEXT,
    "revision" INTEGER NOT NULL,
    "scheduleGeneration" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagedLifecycleOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedLifecycleChangeEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "managedPostId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "dispatchId" TEXT,
    "operationKey" TEXT,
    "scheduleGeneration" INTEGER,
    "dispatchVersion" INTEGER,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagedLifecycleChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "managedPostId" TEXT NOT NULL,
    "scheduleGeneration" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL,
    "bindingGeneration" INTEGER NOT NULL,
    "integrationId" TEXT NOT NULL,
    "providerIdentifier" TEXT NOT NULL,
    "identityFingerprint" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "releaseHash" TEXT NOT NULL,
    "releaseHashVersion" TEXT NOT NULL,
    "codec" TEXT NOT NULL,
    "release" TEXT NOT NULL,
    "anchorAt" TIMESTAMP(3) NOT NULL,
    "intervalDays" INTEGER,
    "maxOccurrences" INTEGER NOT NULL,
    "lastOccurrence" INTEGER NOT NULL,
    "maxLatenessMs" INTEGER NOT NULL,
    "policyGrantedAt" TIMESTAMP(3) NOT NULL,
    "policyExpiresAt" TIMESTAMP(3) NOT NULL,
    "operationKey" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "endRequestedOperationKey" TEXT,
    "endRequestedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedCode" TEXT,
    "endedOperationKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedDispatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "managedPostId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "occurrence" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "admissibleUntil" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "code" TEXT,
    "revision" INTEGER NOT NULL,
    "bindingGeneration" INTEGER NOT NULL,
    "scheduleGeneration" INTEGER NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "releaseHash" TEXT NOT NULL,
    "members" TEXT NOT NULL,
    "resolution" TEXT,
    "cancelledByOperationKey" TEXT,
    "leaseHolder" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "activeCallId" TEXT,
    "nextActionAt" TIMESTAMP(3),
    "nextStep" TEXT,
    "nextMember" INTEGER,
    "deferralCode" TEXT,
    "deferralCount" INTEGER NOT NULL DEFAULT 0,
    "firstDeferredAt" TIMESTAMP(3),
    "lastDeferredAt" TIMESTAMP(3),
    "admittedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "lastLifecycleSequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedDispatchCall" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "managedPostId" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "member" INTEGER NOT NULL,
    "postId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "stage" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "code" TEXT,
    "holder" TEXT NOT NULL,
    "dispatchVersion" INTEGER NOT NULL,
    "fencingToken" INTEGER NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "requestHash" TEXT NOT NULL,
    "reservedUnits" INTEGER NOT NULL,
    "consumedUnits" INTEGER NOT NULL DEFAULT 0,
    "sentLedger" TEXT,
    "pendingEnvelope" TEXT,
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "pollReservedUnits" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" TIMESTAMP(3),
    "pollDeadlineAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "result" TEXT,
    "admittedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedDispatchCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedMediaCapability" (
    "capabilityIdSha256" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "dispatchVersion" INTEGER NOT NULL,
    "mediaId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "storageNamespace" TEXT NOT NULL,
    "storageVersion" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxFetches" INTEGER NOT NULL,
    "fetchCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "ManagedMediaCapability_pkey" PRIMARY KEY ("capabilityIdSha256")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagedLifecycleOrganization_organizationId_key" ON "ManagedLifecycleOrganization"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedPostLifecycle_managedPostId_key" ON "ManagedPostLifecycle"("managedPostId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedPostLifecycle_activeScheduleId_key" ON "ManagedPostLifecycle"("activeScheduleId");

-- CreateIndex
CREATE INDEX "ManagedPostLifecycle_organizationId_lifecycle_idx" ON "ManagedPostLifecycle"("organizationId", "lifecycle");

-- CreateIndex
CREATE INDEX "ManagedLifecycleOperation_organizationId_managedPostId_idx" ON "ManagedLifecycleOperation"("organizationId", "managedPostId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedLifecycleOperation_organizationId_operationKey_key" ON "ManagedLifecycleOperation"("organizationId", "operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedLifecycleOperation_organizationId_sequence_key" ON "ManagedLifecycleOperation"("organizationId", "sequence");

-- CreateIndex
CREATE INDEX "ManagedLifecycleChangeEvent_organizationId_managedPostId_idx" ON "ManagedLifecycleChangeEvent"("organizationId", "managedPostId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedLifecycleChangeEvent_organizationId_sequence_key" ON "ManagedLifecycleChangeEvent"("organizationId", "sequence");

-- CreateIndex
CREATE INDEX "ManagedSchedule_organizationId_status_idx" ON "ManagedSchedule"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedSchedule_managedPostId_scheduleGeneration_key" ON "ManagedSchedule"("managedPostId", "scheduleGeneration");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedSchedule_organizationId_operationKey_key" ON "ManagedSchedule"("organizationId", "operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedDispatch_activeCallId_key" ON "ManagedDispatch"("activeCallId");

-- CreateIndex
CREATE INDEX "ManagedDispatch_organizationId_status_nextActionAt_idx" ON "ManagedDispatch"("organizationId", "status", "nextActionAt");

-- CreateIndex
CREATE INDEX "ManagedDispatch_organizationId_managedPostId_idx" ON "ManagedDispatch"("organizationId", "managedPostId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedDispatch_scheduleId_occurrence_key" ON "ManagedDispatch"("scheduleId", "occurrence");

-- CreateIndex
CREATE INDEX "ManagedDispatchCall_organizationId_status_idx" ON "ManagedDispatchCall"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ManagedDispatchCall_organizationId_dispatchId_idx" ON "ManagedDispatchCall"("organizationId", "dispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedDispatchCall_dispatchId_member_step_stage_attempt_key" ON "ManagedDispatchCall"("dispatchId", "member", "step", "stage", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedMediaCapability_organizationId_callId_evidenceId_key" ON "ManagedMediaCapability"("organizationId", "callId", "evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedMediaCapability_organizationId_callId_mediaId_key" ON "ManagedMediaCapability"("organizationId", "callId", "mediaId");
