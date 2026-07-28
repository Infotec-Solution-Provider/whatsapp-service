-- CreateTable
CREATE TABLE `client_session_snapshots` (
    `client_id` INTEGER NOT NULL,
    `contract_version` INTEGER NOT NULL,
    `state` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `process_started_at` DATETIME(3) NOT NULL,
    `state_changed_at` DATETIME(3) NOT NULL,
    `last_activity_at` DATETIME(3) NULL,
    `connected_since` DATETIME(3) NULL,
    `last_connected_at` DATETIME(3) NULL,
    `last_disconnected_at` DATETIME(3) NULL,
    `last_disconnect_reason` VARCHAR(255) NULL,
    `reconnect_attempts` INTEGER NOT NULL DEFAULT 0,
    `last_reconnect_at` DATETIME(3) NULL,
    `last_observed_at` DATETIME(3) NOT NULL,
    `current_operation_id` VARCHAR(36) NULL,
    `current_operation_type` VARCHAR(32) NULL,
    `current_operation_started_at` DATETIME(3) NULL,
    `consecutive_poll_failures` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `client_session_snapshots_state_idx`(`state`),
    INDEX `client_session_snapshots_last_observed_at_idx`(`last_observed_at`),
    PRIMARY KEY (`client_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_session_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `client_id` INTEGER NOT NULL,
    `previous_state` VARCHAR(32) NULL,
    `state` VARCHAR(32) NOT NULL,
    `reason` VARCHAR(255) NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `trace_id` VARCHAR(64) NOT NULL,
    `transition_key` VARCHAR(128) NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `client_session_events_trace_id_key`(`trace_id`),
    UNIQUE INDEX `client_session_events_transition_key_key`(`transition_key`),
    INDEX `client_session_events_client_id_occurred_at_idx`(`client_id`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `client_session_snapshots` ADD CONSTRAINT `client_session_snapshots_client_id_fkey` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `client_session_events` ADD CONSTRAINT `client_session_events_client_id_fkey` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;