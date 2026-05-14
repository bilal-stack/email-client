-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerThreadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "lastMessageAt" DATETIME NOT NULL,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "labels" JSONB NOT NULL,
    "participants" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Thread_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "providerThreadId" TEXT NOT NULL,
    "from" JSONB NOT NULL,
    "to" JSONB NOT NULL,
    "cc" JSONB NOT NULL,
    "bcc" JSONB NOT NULL,
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "bodyText" TEXT,
    "receivedAt" DATETIME NOT NULL,
    "isUnread" BOOLEAN NOT NULL DEFAULT false,
    "labels" JSONB NOT NULL,
    "inReplyTo" TEXT,
    "references" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "providerAttachmentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "fetchedAt" DATETIME,
    CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Thread_accountId_lastMessageAt_idx" ON "Thread"("accountId", "lastMessageAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Thread_accountId_providerThreadId_key" ON "Thread"("accountId", "providerThreadId");

-- CreateIndex
CREATE INDEX "Message_accountId_receivedAt_idx" ON "Message"("accountId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "Message_threadId_receivedAt_idx" ON "Message"("threadId", "receivedAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Message_accountId_providerMessageId_key" ON "Message"("accountId", "providerMessageId");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");
