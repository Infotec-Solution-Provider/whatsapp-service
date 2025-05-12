/*
  Warnings:

  - You are about to drop the column `last_read_id` on the `internal_chat_members` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[wpp_group_id]` on the table `internalchats` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[wwebjs_id]` on the table `internalmessages` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `internal_chat_members` DROP COLUMN `last_read_id`;

-- AlterTable
ALTER TABLE `internalchats` ADD COLUMN `wpp_group_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `internalmessages` ADD COLUMN `wwebjs_id` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `internalchats_wpp_group_id_key` ON `internalchats`(`wpp_group_id`);

-- CreateIndex
CREATE UNIQUE INDEX `internalmessages_wwebjs_id_key` ON `internalmessages`(`wwebjs_id`);
