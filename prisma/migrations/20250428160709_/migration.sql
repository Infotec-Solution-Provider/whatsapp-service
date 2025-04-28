/*
  Warnings:

  - You are about to drop the column `avatar_url` on the `internalchats` table. All the data in the column will be lost.
  - You are about to drop the column `group_created_at` on the `internalchats` table. All the data in the column will be lost.
  - You are about to drop the column `group_created_by` on the `internalchats` table. All the data in the column will be lost.
  - You are about to drop the column `internalcontact_id` on the `internalchats` table. All the data in the column will be lost.
  - You are about to drop the column `internalcontact_id` on the `internalmessages` table. All the data in the column will be lost.
  - You are about to drop the column `to` on the `internalmessages` table. All the data in the column will be lost.
  - You are about to drop the column `wppChatId` on the `tags` table. All the data in the column will be lost.
  - You are about to drop the `internal_chat_tags` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `internalcontacts` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `started_at` on table `internalchats` required. This step will fail if there are existing NULL values in that column.
  - Made the column `internalchat_id` on table `internalmessages` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE `internal_chat_members` DROP FOREIGN KEY `internal_chat_members_internalcontactId_fkey`;

-- DropForeignKey
ALTER TABLE `internal_chat_tags` DROP FOREIGN KEY `internal_chat_tags_internalchatId_fkey`;

-- DropForeignKey
ALTER TABLE `internal_chat_tags` DROP FOREIGN KEY `internal_chat_tags_tagId_fkey`;

-- DropForeignKey
ALTER TABLE `internalchats` DROP FOREIGN KEY `internalchats_internalcontact_id_fkey`;

-- DropForeignKey
ALTER TABLE `internalmessages` DROP FOREIGN KEY `internalmessages_internalchat_id_fkey`;

-- DropForeignKey
ALTER TABLE `internalmessages` DROP FOREIGN KEY `internalmessages_internalcontact_id_fkey`;

-- DropIndex
DROP INDEX `internal_chat_members_internalcontactId_fkey` ON `internal_chat_members`;

-- DropIndex
DROP INDEX `internalchats_internalcontact_id_fkey` ON `internalchats`;

-- DropIndex
DROP INDEX `internalmessages_from_to_internalchat_id_idx` ON `internalmessages`;

-- DropIndex
DROP INDEX `internalmessages_internalchat_id_fkey` ON `internalmessages`;

-- DropIndex
DROP INDEX `internalmessages_internalcontact_id_fkey` ON `internalmessages`;

-- AlterTable
ALTER TABLE `internalchats` DROP COLUMN `avatar_url`,
    DROP COLUMN `group_created_at`,
    DROP COLUMN `group_created_by`,
    DROP COLUMN `internalcontact_id`,
    MODIFY `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `internalmessages` DROP COLUMN `internalcontact_id`,
    DROP COLUMN `to`,
    MODIFY `internalchat_id` INTEGER NOT NULL,
    MODIFY `timestamp` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `tags` DROP COLUMN `wppChatId`;

-- DropTable
DROP TABLE `internal_chat_tags`;

-- DropTable
DROP TABLE `internalcontacts`;

-- CreateIndex
CREATE INDEX `internalmessages_from_internalchat_id_idx` ON `internalmessages`(`from`, `internalchat_id`);

-- AddForeignKey
ALTER TABLE `internalmessages` ADD CONSTRAINT `internalmessages_internalchat_id_fkey` FOREIGN KEY (`internalchat_id`) REFERENCES `internalchats`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
