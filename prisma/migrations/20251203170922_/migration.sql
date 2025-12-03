-- CreateTable
CREATE TABLE `message_queue_items` (
    `id` VARCHAR(191) NOT NULL,
    `instance` VARCHAR(191) NOT NULL,
    `chat_id` VARCHAR(191) NOT NULL,
    `client_id` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `priority` INTEGER NOT NULL DEFAULT 0,
    `payload` JSON NOT NULL,
    `is_group` BOOLEAN NOT NULL DEFAULT false,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `max_retries` INTEGER NOT NULL DEFAULT 3,
    `error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `processing_started_at` DATETIME(3) NULL,
    `processed_at` DATETIME(3) NULL,

    INDEX `message_queue_items_instance_chat_id_status_idx`(`instance`, `chat_id`, `status`),
    INDEX `message_queue_items_status_created_at_idx`(`status`, `created_at`),
    INDEX `message_queue_items_client_id_status_idx`(`client_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
