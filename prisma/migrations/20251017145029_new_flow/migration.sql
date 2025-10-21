-- AlterTable
ALTER TABLE `message_flows_steps` ADD COLUMN `config` JSON NULL,
    ADD COLUMN `description` VARCHAR(191) NULL,
    ADD COLUMN `enabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `fallback_step_id` INTEGER NULL,
    ADD COLUMN `next_step_id` INTEGER NULL,
    MODIFY `type` ENUM('CONDITION', 'QUERY', 'ROUTER', 'ASSIGN', 'CHECK_AVAILABLE_USERS', 'CHECK_LOALTY', 'CHECK_ONLY_ADMIN', 'SEND_TO_ADMIN', 'SEND_TO_SECTOR_USER', 'SEND_TO_SPECIFIC_USER', 'CHECK_CUSTOMER_CAMPAIGN_TYPE') NOT NULL;

-- CreateTable
CREATE TABLE `message_flow_metrics` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `flow_id` INTEGER NOT NULL,
    `step_id` INTEGER NOT NULL,
    `contact_id` INTEGER NOT NULL,
    `duration_ms` INTEGER NOT NULL,
    `result` VARCHAR(191) NOT NULL,
    `error` VARCHAR(191) NULL,
    `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `message_flow_metrics_flow_id_timestamp_idx`(`flow_id`, `timestamp`),
    INDEX `message_flow_metrics_step_id_result_idx`(`step_id`, `result`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_flow_versions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `flow_id` INTEGER NOT NULL,
    `version` INTEGER NOT NULL,
    `config` JSON NOT NULL,
    `created_by` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `description` VARCHAR(191) NULL,

    UNIQUE INDEX `message_flow_versions_flow_id_version_key`(`flow_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `message_flows_steps_message_flow_id_enabled_idx` ON `message_flows_steps`(`message_flow_id`, `enabled`);
