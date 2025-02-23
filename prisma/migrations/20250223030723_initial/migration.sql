-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('PENDING', 'SENT', 'RECEIVED', 'READ', 'DOWNLOADED', 'ERROR');

-- CreateEnum
CREATE TYPE "WppInstanceType" AS ENUM ('WABA', 'WWEBJS');

-- CreateEnum
CREATE TYPE "chat_type" AS ENUM ('RECEPTIVE', 'ACTIVE');

-- CreateEnum
CREATE TYPE "chat_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'VERY_HIGH', 'URGENCY');

-- CreateTable
CREATE TABLE "instances" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "instanceName" TEXT NOT NULL,
    "type" "WppInstanceType" NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "WABAPhoneId" TEXT,
    "WABAToken" TEXT,

    CONSTRAINT "instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "instanceName" TEXT NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "quotedId" TEXT,
    "chatId" INTEGER NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "status" "message_status" NOT NULL,
    "fileType" TEXT,
    "fileName" TEXT,
    "fileOriginalName" TEXT,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" SERIAL NOT NULL,
    "instanceName" TEXT NOT NULL,
    "isFinished" BOOLEAN NOT NULL,
    "userId" INTEGER NOT NULL,
    "botId" INTEGER,
    "resultId" INTEGER,
    "type" "chat_type" NOT NULL,
    "priority" "chat_priority" NOT NULL,
    "avatarUrl" TEXT,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sectors" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "instanceName" TEXT NOT NULL,

    CONSTRAINT "sectors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instances_isActive_idx" ON "instances"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "instances_phone_instanceName_key" ON "instances"("phone", "instanceName");

-- CreateIndex
CREATE INDEX "contacts_customerId_instanceName_idx" ON "contacts"("customerId", "instanceName");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_instanceName_phone_key" ON "contacts"("instanceName", "phone");

-- CreateIndex
CREATE INDEX "messages_from_to_idx" ON "messages"("from", "to");

-- CreateIndex
CREATE INDEX "chats_userId_idx" ON "chats"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sectors_instanceName_name_key" ON "sectors"("instanceName", "name");
