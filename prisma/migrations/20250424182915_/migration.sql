-- AlterTable
ALTER TABLE `chats` ADD COLUMN `finished_by` INTEGER NULL,
    ADD COLUMN `is_schedule` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `contacts` ADD COLUMN `is_deleted` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `messages` MODIFY `status` ENUM('PENDING', 'SENT', 'RECEIVED', 'READ', 'DOWNLOADED', 'ERROR', 'REVOKED') NOT NULL;

-- CreateTable
CREATE TABLE `tags` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `bg_color` VARCHAR(191) NOT NULL,
    `wppChatId` INTEGER NULL,

    UNIQUE INDEX `tags_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `_WppChatToWppTag` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_WppChatToWppTag_AB_unique`(`A`, `B`),
    INDEX `_WppChatToWppTag_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `_WppChatToWppTag` ADD CONSTRAINT `_WppChatToWppTag_A_fkey` FOREIGN KEY (`A`) REFERENCES `chats`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_WppChatToWppTag` ADD CONSTRAINT `_WppChatToWppTag_B_fkey` FOREIGN KEY (`B`) REFERENCES `tags`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
