-- CreateTable
CREATE TABLE `waba_webhook_queue` (
    `id` VARCHAR(191) NOT NULL,
    `instance` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'IGNORED') NOT NULL DEFAULT 'PENDING',
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `max_retries` INTEGER NOT NULL DEFAULT 3,
    `error` TEXT NULL,
    `ignored_reason` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `processing_started_at` DATETIME(3) NULL,
    `processed_at` DATETIME(3) NULL,

    INDEX `waba_webhook_queue_instance_status_idx`(`instance`, `status`),
    INDEX `waba_webhook_queue_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
