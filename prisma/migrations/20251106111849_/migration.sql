/*
  Warnings:

  - You are about to drop the `internal_chat_members` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `internal_chat_members` DROP FOREIGN KEY `internal_chat_members_internalchatId_fkey`;

-- DropTable
DROP TABLE `internal_chat_members`;

-- CreateTable
CREATE TABLE `internal_chat_participants` (
    `internalchat_id` INTEGER NOT NULL,
    `participant_id` VARCHAR(191) NOT NULL,
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_read_at` DATETIME(3) NULL,

    PRIMARY KEY (`internalchat_id`, `participant_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `internal_chat_participants` ADD CONSTRAINT `internal_chat_participants_internalchat_id_fkey` FOREIGN KEY (`internalchat_id`) REFERENCES `internalchats`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
