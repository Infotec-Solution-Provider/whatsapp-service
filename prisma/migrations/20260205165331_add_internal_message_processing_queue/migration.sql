-- CreateTable
CREATE TABLE `internal_message_processing_queue` (
    `id` VARCHAR(191) NOT NULL,
    `instance` VARCHAR(191) NOT NULL,
    `internal_chat_id` INTEGER NOT NULL,
    `internal_message_id` INTEGER NULL,
    `group_id` VARCHAR(191) NOT NULL,
    `message_data` LONGTEXT NOT NULL,
    `author_name` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `max_retries` INTEGER NOT NULL DEFAULT 3,
    `error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `processing_started_at` DATETIME(3) NULL,
    `processed_at` DATETIME(3) NULL,
    `locked_until` DATETIME(3) NULL,
    `locked_by` VARCHAR(191) NULL,

    INDEX `internal_message_processing_queue_instance_status_group_id_idx`(`instance`, `status`, `group_id`),
    INDEX `internal_message_processing_queue_status_created_at_idx`(`status`, `created_at`),
    INDEX `internal_message_processing_queue_group_id_status_idx`(`group_id`, `status`),
    INDEX `internal_message_processing_queue_locked_until_idx`(`locked_until`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
