/*
  Warnings:

  - A unique constraint covering the columns `[scope,instance,sectorId,userId,key]` on the table `parameters` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX `parameters_scope_instance_sectorId_userId_key_key` ON `parameters`(`scope`, `instance`, `sectorId`, `userId`, `key`);
