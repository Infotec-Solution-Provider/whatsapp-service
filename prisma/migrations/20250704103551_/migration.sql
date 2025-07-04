/*
  Warnings:

  - A unique constraint covering the columns `[schedule_id]` on the table `chats` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[wwebjs_id_stanza]` on the table `internalmessages` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[wwebjs_id_stanza]` on the table `messages` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[chat_id]` on the table `schedules` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `scheduled_at` to the `schedules` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `chats` ADD COLUMN `schedule_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `internalchats` ADD COLUMN `group_image_file_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `internalmessages` ADD COLUMN `wwebjs_id_stanza` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `messages` ADD COLUMN `wwebjs_id_stanza` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `schedules` ADD COLUMN `chat_id` INTEGER NULL,
    ADD COLUMN `scheduled_at` DATETIME(3) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `chats_schedule_id_key` ON `chats`(`schedule_id`);

-- CreateIndex
CREATE UNIQUE INDEX `internalmessages_wwebjs_id_stanza_key` ON `internalmessages`(`wwebjs_id_stanza`);

-- CreateIndex
CREATE UNIQUE INDEX `messages_wwebjs_id_stanza_key` ON `messages`(`wwebjs_id_stanza`);

-- CreateIndex
CREATE UNIQUE INDEX `schedules_chat_id_key` ON `schedules`(`chat_id`);

-- AddForeignKey
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_chat_id_fkey` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
