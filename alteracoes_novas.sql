-- DropForeignKey
ALTER TABLE `internal_mentions` DROP FOREIGN KEY `internal_mentions_internalmessage_id_fkey`;

-- DropForeignKey
ALTER TABLE `notifications` DROP FOREIGN KEY `notifications_chat_id_fkey`;

-- DropIndex
DROP INDEX `notifications_chat_id_fkey` ON `notifications`;

-- AlterTable
ALTER TABLE `chats` DROP COLUMN `user_name`,
    MODIFY `schedule_id` INTEGER NULL;

-- AlterTable
ALTER TABLE `clients` MODIFY `type` ENUM('WABA', 'WWEBJS', 'GUPSHUP') NOT NULL;

-- AlterTable
ALTER TABLE `contacts` DROP COLUMN `user_name`,
    ADD COLUMN `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `last_out_of_hours_reply_sent_at` DATETIME(3) NULL,
    ADD COLUMN `updated_at` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `internal_chat_members` DROP PRIMARY KEY,
    ALTER COLUMN `internalchatId` DROP DEFAULT,
    MODIFY `internalcontactId` INTEGER NOT NULL,
    ADD PRIMARY KEY (`internalchatId`, `internalcontactId`);

-- AlterTable
ALTER TABLE `internal_mentions` DROP COLUMN `user_name`,
    MODIFY `user_id` INTEGER NOT NULL;

-- AlterTable
ALTER TABLE `internalchats` DROP COLUMN `user_name`;

-- AlterTable
ALTER TABLE `internalmessages` DROP COLUMN `user_name`;

-- AlterTable
ALTER TABLE `messages` DROP COLUMN `user_name`,
    MODIFY `body` VARCHAR(191) NOT NULL,
    MODIFY `sent_at` DATETIME(3) NOT NULL;

-- AlterTable
ALTER TABLE `parameters` MODIFY `key` VARCHAR(191) NOT NULL,
    MODIFY `value` VARCHAR(191) NOT NULL,
    MODIFY `instance` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `schedules` MODIFY `chat_id` INTEGER NULL,
    MODIFY `scheduled_at` DATETIME(3) NOT NULL;

-- CreateTable
CREATE TABLE `automatic_response_rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isGlobal` BOOLEAN NOT NULL DEFAULT false,
    `message` TEXT NOT NULL,
    `fileId` INTEGER NULL,
    `isEnabled` BOOLEAN NOT NULL DEFAULT true,
    `cooldownSeconds` INTEGER NOT NULL DEFAULT 3600,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automatic_response_rule_users` (
    `rule_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,

    PRIMARY KEY (`rule_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automatic_response_schedules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ruleId` INTEGER NOT NULL,
    `dayOfWeek` INTEGER NOT NULL,
    `startTime` VARCHAR(191) NOT NULL,
    `endTime` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


-- AddForeignKey
ALTER TABLE `internal_mentions` ADD CONSTRAINT `internal_mentions_internalmessage_id_fkey` FOREIGN KEY (`internalmessage_id`) REFERENCES `internalmessages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automatic_response_rule_users` ADD CONSTRAINT `automatic_response_rule_users_rule_id_fkey` FOREIGN KEY (`rule_id`) REFERENCES `automatic_response_rules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automatic_response_schedules` ADD CONSTRAINT `automatic_response_schedules_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `automatic_response_rules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_chat_id_fkey` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_chat_id_fkey` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER TABLE `_wppchattowpptag` RENAME INDEX `_wppchattowpptag_AB_unique` TO `_WppChatToWppTag_AB_unique`;

-- RenameIndex
ALTER TABLE `_wppchattowpptag` RENAME INDEX `_wppchattowpptag_B_index` TO `_WppChatToWppTag_B_index`;

-- RenameIndex
ALTER TABLE `internal_mentions` RENAME INDEX `internal_mentions_internalmessage_id_fkey` TO `internal_mentions_internalmessage_id_idx`;

-- RenameIndex
ALTER TABLE `parameters` RENAME INDEX `unique_parameter` TO `parameters_scope_instance_sectorId_userId_key_key`;

