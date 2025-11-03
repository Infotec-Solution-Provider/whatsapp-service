/*
  Warnings:

  - You are about to drop the `_wppclienttowppsector` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `_wppclienttowppsector` DROP FOREIGN KEY `_WppClientToWppSector_A_fkey`;

-- DropForeignKey
ALTER TABLE `_wppclienttowppsector` DROP FOREIGN KEY `_WppClientToWppSector_B_fkey`;

-- AlterTable
ALTER TABLE `sectors` ADD COLUMN `default_client_id` INTEGER NULL;

-- DropTable
DROP TABLE `_wppclienttowppsector`;

-- CreateTable
CREATE TABLE `_sector_clients` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_sector_clients_AB_unique`(`A`, `B`),
    INDEX `_sector_clients_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sectors` ADD CONSTRAINT `sectors_default_client_id_fkey` FOREIGN KEY (`default_client_id`) REFERENCES `clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_sector_clients` ADD CONSTRAINT `_sector_clients_A_fkey` FOREIGN KEY (`A`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_sector_clients` ADD CONSTRAINT `_sector_clients_B_fkey` FOREIGN KEY (`B`) REFERENCES `sectors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
