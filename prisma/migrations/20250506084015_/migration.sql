-- CreateTable
CREATE TABLE `internalmessages_status` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `user_id` INTEGER NOT NULL,
    `message_id` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'RECEIVED', 'READ', 'DOWNLOADED', 'ERROR', 'REVOKED') NOT NULL,
    `timestamp` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `internalmessages_status` ADD CONSTRAINT `internalmessages_status_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `internalmessages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
