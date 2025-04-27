/*
  Warnings:

  - You are about to drop the `sectors_users` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `sectors_users` DROP FOREIGN KEY `sectors_users_sector_id_fkey`;

-- DropTable
DROP TABLE `sectors_users`;

-- CreateTable
CREATE TABLE `internalcontacts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `user_id` INTEGER NULL,
    `instance` VARCHAR(191) NOT NULL,
    `is_deleted` BOOLEAN NOT NULL DEFAULT false,
    `is_blocked` BOOLEAN NOT NULL DEFAULT false,
    `is_only_admin` BOOLEAN NOT NULL DEFAULT false,

    INDEX `internalcontacts_user_id_instance_idx`(`user_id`, `instance`),
    UNIQUE INDEX `internalcontacts_instance_phone_key`(`instance`, `phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `internalmessages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `from` VARCHAR(191) NOT NULL,
    `to` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `quoted_id` INTEGER NULL,
    `internalchat_id` INTEGER NULL,
    `internalcontact_id` INTEGER NULL,
    `body` VARCHAR(191) NOT NULL,
    `timestamp` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'RECEIVED', 'READ', 'DOWNLOADED', 'ERROR', 'REVOKED') NOT NULL,
    `file_id` INTEGER NULL,
    `file_name` VARCHAR(191) NULL,
    `file_type` VARCHAR(191) NULL,
    `file_size` VARCHAR(191) NULL,

    INDEX `internalmessages_from_to_internalchat_id_idx`(`from`, `to`, `internalchat_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `internalchats` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `internalcontact_id` INTEGER NULL,
    `user_id` INTEGER NULL,
    `sector_id` INTEGER NULL,
    `avatar_url` VARCHAR(191) NULL,
    `is_finished` BOOLEAN NOT NULL DEFAULT false,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `finished_by` INTEGER NULL,
    `is_group` BOOLEAN NOT NULL DEFAULT false,
    `group_name` VARCHAR(191) NULL,
    `group_description` VARCHAR(191) NULL,
    `group_created_by` INTEGER NULL,
    `group_created_at` DATETIME(3) NULL,

    INDEX `internalchats_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `internal_chat_members` (
    `internalchatId` INTEGER NOT NULL,
    `internalcontactId` INTEGER NOT NULL,
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_read_at` DATETIME(3) NULL,

    PRIMARY KEY (`internalchatId`, `internalcontactId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `internal_chat_tags` (
    `internalchatId` INTEGER NOT NULL,
    `tagId` INTEGER NOT NULL,

    PRIMARY KEY (`internalchatId`, `tagId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `internalmessages` ADD CONSTRAINT `internalmessages_internalchat_id_fkey` FOREIGN KEY (`internalchat_id`) REFERENCES `internalchats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internalmessages` ADD CONSTRAINT `internalmessages_internalcontact_id_fkey` FOREIGN KEY (`internalcontact_id`) REFERENCES `internalcontacts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internalchats` ADD CONSTRAINT `internalchats_internalcontact_id_fkey` FOREIGN KEY (`internalcontact_id`) REFERENCES `internalcontacts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internalchats` ADD CONSTRAINT `internalchats_sector_id_fkey` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internal_chat_members` ADD CONSTRAINT `internal_chat_members_internalchatId_fkey` FOREIGN KEY (`internalchatId`) REFERENCES `internalchats`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internal_chat_members` ADD CONSTRAINT `internal_chat_members_internalcontactId_fkey` FOREIGN KEY (`internalcontactId`) REFERENCES `internalcontacts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internal_chat_tags` ADD CONSTRAINT `internal_chat_tags_internalchatId_fkey` FOREIGN KEY (`internalchatId`) REFERENCES `internalchats`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internal_chat_tags` ADD CONSTRAINT `internal_chat_tags_tagId_fkey` FOREIGN KEY (`tagId`) REFERENCES `tags`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
