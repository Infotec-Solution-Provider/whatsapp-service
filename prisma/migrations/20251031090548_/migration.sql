/*
  Warnings:

  - You are about to drop the column `wpp_instance_id` on the `sectors` table. All the data in the column will be lost.
  - You are about to drop the `sectors_clients` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `sectors_clients` DROP FOREIGN KEY `sectors_clients_clientId_fkey`;

-- DropForeignKey
ALTER TABLE `sectors_clients` DROP FOREIGN KEY `sectors_clients_sectorId_fkey`;

-- AlterTable
ALTER TABLE `sectors` DROP COLUMN `wpp_instance_id`;

-- DropTable
DROP TABLE `sectors_clients`;

-- CreateTable
CREATE TABLE `_WppClientToWppSector` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_WppClientToWppSector_AB_unique`(`A`, `B`),
    INDEX `_WppClientToWppSector_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `_WppClientToWppSector` ADD CONSTRAINT `_WppClientToWppSector_A_fkey` FOREIGN KEY (`A`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_WppClientToWppSector` ADD CONSTRAINT `_WppClientToWppSector_B_fkey` FOREIGN KEY (`B`) REFERENCES `sectors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
