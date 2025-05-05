/*
  Warnings:

  - You are about to drop the column `name` on the `schedules` table. All the data in the column will be lost.
  - You are about to drop the column `sector_id` on the `schedules` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE `schedules` DROP FOREIGN KEY `schedules_sector_id_fkey`;

-- DropIndex
DROP INDEX `schedules_sector_id_fkey` ON `schedules`;

-- AlterTable
ALTER TABLE `chats` MODIFY `avatar_url` TEXT NULL;

-- AlterTable
ALTER TABLE `schedules` DROP COLUMN `name`,
    DROP COLUMN `sector_id`,
    ADD COLUMN `description` VARCHAR(191) NULL,
    ADD COLUMN `wppSectorId` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_wppSectorId_fkey` FOREIGN KEY (`wppSectorId`) REFERENCES `sectors`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
