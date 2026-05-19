-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "MailAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "encryptedSecret" BYTEA NOT NULL,
    "secretIv" BYTEA NOT NULL,
    "secretTag" BYTEA NOT NULL,
    "syncCursor" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerThreadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "labels" JSONB NOT NULL,
    "participants" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
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
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "isUnread" BOOLEAN NOT NULL DEFAULT false,
    "labels" JSONB NOT NULL,
    "inReplyTo" TEXT,
    "references" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "providerAttachmentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3),

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AISummary" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "tldr" TEXT NOT NULL,
    "ask" TEXT,
    "decision" TEXT,
    "deadline" TEXT,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "usage" JSONB NOT NULL,
    "userMessageJson" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AISummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriorityScore" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "suggestedActions" JSONB NOT NULL,
    "riskFlag" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "usage" JSONB NOT NULL,
    "userMessageJson" TEXT NOT NULL,
    "scoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriorityScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "MailAccount_userId_provider_emailAddress_key" ON "MailAccount"("userId", "provider", "emailAddress");

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

-- CreateIndex
CREATE INDEX "Draft_userId_updatedAt_idx" ON "Draft"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Draft_userId_threadId_mode_key" ON "Draft"("userId", "threadId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "AISummary_threadId_key" ON "AISummary"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "PriorityScore_messageId_key" ON "PriorityScore"("messageId");

-- CreateIndex
CREATE INDEX "PriorityScore_priority_idx" ON "PriorityScore"("priority");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAccount" ADD CONSTRAINT "MailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AISummary" ADD CONSTRAINT "AISummary_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriorityScore" ADD CONSTRAINT "PriorityScore_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
