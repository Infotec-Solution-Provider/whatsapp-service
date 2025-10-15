/*
  Warnings:

  - You are about to drop the `w_mensagens_prontas` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `is_edited` to the `internalmessages` table without a default value. This is not possible if the table is not empty.
  - Made the column `is_forwarded` on table `internalmessages` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE `automatic_response_schedules` ADD COLUMN `dayOfMonth` INTEGER NULL,
    ADD COLUMN `daysOfWeek` JSON NULL,
    ADD COLUMN `endDate` DATETIME(3) NULL,
    ADD COLUMN `frequency` ENUM('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') NOT NULL DEFAULT 'WEEKLY',
    ADD COLUMN `month` INTEGER NULL,
    ADD COLUMN `startDate` DATETIME(3) NULL,
    ADD COLUMN `timezone` VARCHAR(191) NOT NULL DEFAULT 'America/Fortaleza',
    MODIFY `dayOfWeek` INTEGER NULL;

-- AlterTable
ALTER TABLE `internalmessages` ADD COLUMN `is_edited` BOOLEAN NOT NULL,
    MODIFY `is_forwarded` BOOLEAN NOT NULL;

-- DropTable
DROP TABLE `w_mensagens_prontas`;

-- CreateTable
CREATE TABLE `ready_messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `sector_id` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `message` TEXT NOT NULL,
    `file_id` INTEGER NULL,
    `file_name` VARCHAR(191) NULL,
    `only_admin` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ready_messages_instance_sector_id_idx`(`instance`, `sector_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
