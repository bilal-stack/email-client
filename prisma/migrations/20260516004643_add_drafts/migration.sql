-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "threadId" TEXT,
    "mode" TEXT NOT NULL,
    "to" JSONB NOT NULL,
    "cc" JSONB NOT NULL,
    "bcc" JSONB NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "inReplyTo" JSONB NOT NULL,
    "references" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Draft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Draft_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Draft_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Draft_userId_updatedAt_idx" ON "Draft"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Draft_userId_threadId_mode_key" ON "Draft"("userId", "threadId", "mode");
