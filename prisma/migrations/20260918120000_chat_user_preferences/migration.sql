CREATE TABLE `chat_user_preferences` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `user_id` INTEGER NOT NULL,
    `chat_type` VARCHAR(32) NOT NULL,
    `chat_id` INTEGER NOT NULL,
    `is_pinned` BOOLEAN NOT NULL DEFAULT false,
    `is_marked_unread` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `chat_user_preferences_instance_user_id_chat_type_chat_id_key`(`instance`, `user_id`, `chat_type`, `chat_id`),
    INDEX `chat_user_preferences_pin_idx`(`instance`, `user_id`, `is_pinned`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
