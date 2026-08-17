-- Preflight (must return zero rows before applying):
-- SELECT `message_id`, COUNT(*) AS `duplicates`
-- FROM `wpp_message_processing_queue`
-- GROUP BY `message_id`
-- HAVING COUNT(*) > 1;
--
-- This index intentionally runs first. If historical duplicates exist, the
-- migration stops without silently deleting queue records; consolidate them
-- explicitly before retrying the migration.
CREATE UNIQUE INDEX `wpp_message_processing_queue_message_id_key`
  ON `wpp_message_processing_queue`(`message_id`);

CREATE TABLE `remote_inbound_event_inbox` (
  `id` VARCHAR(191) NOT NULL,
  `idempotency_key` VARCHAR(191) NOT NULL,
  `client_id` INTEGER NOT NULL,
  `event_type` VARCHAR(64) NOT NULL,
  `provider_message_id` VARCHAR(255) NOT NULL,
  `payload_hash` CHAR(64) NOT NULL,
  `payload` JSON NOT NULL,
  `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
  `retry_count` INTEGER NOT NULL DEFAULT 0,
  `max_retries` INTEGER NOT NULL DEFAULT 0,
  `error` TEXT NULL,
  `message_id` INTEGER NULL,
  `locked_until` DATETIME(3) NULL,
  `locked_by` VARCHAR(191) NULL,
  `processing_started_at` DATETIME(3) NULL,
  `next_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `remote_inbound_event_inbox_idempotency_key_key`(`idempotency_key`),
  UNIQUE INDEX `remote_inbound_event_inbox_canonical_event_key`(`client_id`, `event_type`, `provider_message_id`),
  INDEX `remote_inbound_event_inbox_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
  INDEX `remote_inbound_event_inbox_locked_until_idx`(`locked_until`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
