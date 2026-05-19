-- CreateTable
CREATE TABLE "SendTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "threadId" TEXT,
    "providerThreadId" TEXT,
    "to" JSONB NOT NULL,
    "cc" JSONB NOT NULL,
    "bcc" JSONB NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "references" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SendTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SendTaskAttachment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SendTaskAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SendTask_userId_status_idx" ON "SendTask"("userId", "status");

-- CreateIndex
CREATE INDEX "SendTask_accountId_createdAt_idx" ON "SendTask"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SendTaskAttachment_taskId_idx" ON "SendTaskAttachment"("taskId");

-- AddForeignKey
ALTER TABLE "SendTask" ADD CONSTRAINT "SendTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendTask" ADD CONSTRAINT "SendTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendTask" ADD CONSTRAINT "SendTask_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendTaskAttachment" ADD CONSTRAINT "SendTaskAttachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "SendTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
