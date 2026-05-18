-- CreateTable
CREATE TABLE "PriorityScore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "suggestedActions" JSONB NOT NULL,
    "riskFlag" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "usage" JSONB NOT NULL,
    "userMessageJson" TEXT NOT NULL,
    "scoredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PriorityScore_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PriorityScore_messageId_key" ON "PriorityScore"("messageId");

-- CreateIndex
CREATE INDEX "PriorityScore_priority_idx" ON "PriorityScore"("priority");
