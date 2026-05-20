/*
  Warnings:

  - You are about to drop the `Account` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Session` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `VerificationToken` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Account" DROP CONSTRAINT "Account_userId_fkey";

-- DropForeignKey
ALTER TABLE "Draft" DROP CONSTRAINT "Draft_userId_fkey";

-- DropForeignKey
ALTER TABLE "MailAccount" DROP CONSTRAINT "MailAccount_userId_fkey";

-- DropForeignKey
ALTER TABLE "SendTask" DROP CONSTRAINT "SendTask_userId_fkey";

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_userId_fkey";

-- AlterTable
ALTER TABLE "MailAccount" ADD COLUMN     "image" TEXT;

-- DropTable
DROP TABLE "Account";

-- DropTable
DROP TABLE "Session";

-- DropTable
DROP TABLE "User";

-- DropTable
DROP TABLE "VerificationToken";

-- CreateIndex
CREATE INDEX "MailAccount_provider_emailAddress_idx" ON "MailAccount"("provider", "emailAddress");

-- CreateIndex
CREATE INDEX "MailAccount_userId_idx" ON "MailAccount"("userId");
