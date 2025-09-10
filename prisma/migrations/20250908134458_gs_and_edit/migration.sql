/*
  Warnings:

  - A unique constraint covering the columns `[gupshup_id]` on the table `messages` will be added. If there are existing duplicate values, this will fail.
  - Made the column `is_forwarded` on table `messages` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE `messages` ADD COLUMN `gupshup_id` VARCHAR(191) NULL,
    ADD COLUMN `gupshup_request_id` VARCHAR(191) NULL,
    ADD COLUMN `is_edited` BOOLEAN NOT NULL DEFAULT false,
    MODIFY `is_forwarded` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX `messages_gupshup_id_key` ON `messages`(`gupshup_id`);
