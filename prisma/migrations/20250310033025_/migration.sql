-- CreateTable
CREATE TABLE "sectors_users" (
    "instanceName" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "sectorId" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "sectors_users_instanceName_userId_key" ON "sectors_users"("instanceName", "userId");

-- AddForeignKey
ALTER TABLE "sectors_users" ADD CONSTRAINT "sectors_users_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "sectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
