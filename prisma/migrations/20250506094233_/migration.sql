/*
  Warnings:

  - You are about to drop the `internalmessages_status` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `internalmessages_status` DROP FOREIGN KEY `internalmessages_status_message_id_fkey`;

-- AlterTable
ALTER TABLE `internal_chat_members` ADD COLUMN `last_read_id` INTEGER NULL;

-- DropTable
DROP TABLE `internalmessages_status`;
