-- AlterTable
ALTER TABLE `internalmessages` ADD COLUMN `is_forwarded` BOOLEAN NULL;

-- AlterTable
ALTER TABLE `messages` ADD COLUMN `is_forwarded` BOOLEAN NULL,
    ADD COLUMN `userId` INTEGER NULL;

-- CreateTable
CREATE TABLE `internal_mentions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `internalmessage_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,

    INDEX `internal_mentions_internalmessage_id_idx`(`internalmessage_id`),
    INDEX `internal_mentions_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `chat_id` INTEGER NULL,
    `user_id` INTEGER NULL,
    `type` ENUM('CHAT_AUTO_FINISHED', 'CHAT_TRANSFERRED', 'CHAT_REASSIGNED', 'ALERT', 'INFO', 'WARNING', 'ERROR') NOT NULL,
    `read` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `messages_chat_id_userId_idx` ON `messages`(`chat_id`, `userId`);

-- AddForeignKey
ALTER TABLE `internal_mentions` ADD CONSTRAINT `internal_mentions_internalmessage_id_fkey` FOREIGN KEY (`internalmessage_id`) REFERENCES `internalmessages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_chat_id_fkey` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
