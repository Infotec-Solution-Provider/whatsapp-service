/*
  Warnings:

  - You are about to drop the column `wppSectorId` on the `schedules` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE `schedules` DROP FOREIGN KEY `schedules_wppSectorId_fkey`;

-- DropIndex
DROP INDEX `schedules_wppSectorId_fkey` ON `schedules`;

-- AlterTable
ALTER TABLE `schedules` DROP COLUMN `wppSectorId`,
    ADD COLUMN `sector_id` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_sector_id_fkey` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
