-- CreateTable
CREATE TABLE "AISummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "tldr" TEXT NOT NULL,
    "ask" TEXT,
    "decision" TEXT,
    "deadline" TEXT,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "usage" JSONB NOT NULL,
    "userMessageJson" TEXT NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AISummary_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AISummary_threadId_key" ON "AISummary"("threadId");
