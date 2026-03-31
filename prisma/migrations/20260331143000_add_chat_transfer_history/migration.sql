CREATE TABLE `chat_transfer_history` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `chat_id` INTEGER NOT NULL,
    `from_user_id` INTEGER NULL,
    `to_user_id` INTEGER NULL,
    `from_sector_id` INTEGER NULL,
    `to_sector_id` INTEGER NULL,
    `initiated_by_user_id` INTEGER NULL,
    `source` VARCHAR(64) NOT NULL,
    `reason` VARCHAR(255) NULL,
    `transferred_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `chat_transfer_history_instance_transferred_at_idx` ON `chat_transfer_history`(`instance`, `transferred_at`);
CREATE INDEX `chat_transfer_history_from_user_id_transferred_at_idx` ON `chat_transfer_history`(`from_user_id`, `transferred_at`);
CREATE INDEX `chat_transfer_history_to_user_id_transferred_at_idx` ON `chat_transfer_history`(`to_user_id`, `transferred_at`);
CREATE INDEX `chat_transfer_history_chat_id_transferred_at_idx` ON `chat_transfer_history`(`chat_id`, `transferred_at`);